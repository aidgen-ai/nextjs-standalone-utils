#!/usr/bin/env node
/**
 * include-standalone-deps — trace extra CLI tools (e.g. node_modules/.bin/prisma)
 * with @vercel/nft and copy their file closure into a Next.js standalone output
 * directory, mirroring what `output: 'standalone'` does for the server itself.
 *
 * Usage:
 *   include-standalone-deps [options] <path-or-glob> [<path-or-glob> ...]
 *
 * Each argument is auto-detected:
 *   - "pkg:<name>[/<subpath-or-glob>]": resolves <name> via Node module
 *     resolution (require.resolve(`<name>/package.json`) from --root),
 *     following symlinks to the package's real on-disk directory — this
 *     avoids hardcoding package-manager-specific store layouts (e.g. pnpm's
 *     `.pnpm/@scope+name@<version>/node_modules/@scope/name`). With no
 *     subpath, the whole resolved directory is copied (can be large for
 *     big packages); with a subpath, it is classified using the same rules
 *     as a literal path/glob below, resolved against the package directory.
 *     Resolution first tries `<name>/package.json`; if the package has a
 *     restrictive "exports" map, it falls back to resolving the main entry
 *     and walking up to find the package root. Fails only if the package has
 *     no resolvable entry point at all — use a literal node_modules path then.
 *   - existing file (or symlink to one): resolved through .bin shims
 *     (pnpm cmd-shim or symlink) and traced with @vercel/nft; the shim or
 *     symlink itself is copied too
 *   - existing directory (or symlink to one): copied recursively, verbatim
 *   - contains glob characters (star, ?, [, {): treated as a glob relative
 *     to --root, matches are copied verbatim (a trailing "double-star" is
 *     implied for directory matches)
 *
 * All copies — traced files, explicit directories, and glob matches alike —
 * still go through the same node_modules filter, so anything outside
 * node_modules is skipped unless --all is passed.
 *
 * A literal path that does not exist, or a glob with zero matches, is a hard
 * error (pass --ignore-missing to warn and continue instead).
 *
 * Options:
 *   --out <dir>        Output directory (default: .next/standalone)
 *   --root <dir>       Tracing root; must match outputFileTracingRoot for
 *                      monorepos (default: process.cwd())
 *   --all              Also copy files outside node_modules (default: skip them)
 *   --ignore-missing   Warn instead of failing on missing paths / empty globs
 *   --verbose          Log every copied file
 *
 * Files are written to <out>/<path relative to root>. Existing files are never
 * overwritten (Next.js may have written them first). Symlinks are recreated as
 * symlinks. File modes are preserved (uv_fs_copyfile keeps permissions), so
 * engine binaries stay executable.
 */

import { nodeFileTrace } from '@vercel/nft';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const inputs = [];
let out = '.next/standalone';
let root = process.cwd();
let copyAll = false;
let verbose = false;
let ignoreMissing = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i];
  else if (a === '--root') root = args[++i];
  else if (a === '--all') copyAll = true;
  else if (a === '--verbose') verbose = true;
  else if (a === '--ignore-missing') ignoreMissing = true;
  else if (a === '--help' || a === '-h') {
    console.log(
      'Usage: include-standalone-deps [--out dir] [--root dir] [--all] [--ignore-missing] [--verbose] <path-or-glob>...',
    );
    process.exit(0);
  } else if (a.startsWith('--')) {
    console.error(`Unknown option: ${a}`);
    process.exit(1);
  } else inputs.push(a);
}

if (inputs.length === 0) {
  console.error('Nothing to do. Example: include-standalone-deps node_modules/.bin/prisma');
  process.exit(1);
}

root = path.resolve(root);
out = path.resolve(out);

// ---------------------------------------------------------------------------
// Input classification
// ---------------------------------------------------------------------------

/** Extract the real JS target from a pnpm/npm cmd-shim shell wrapper. */
function parseCmdShim(shimPath, content) {
  // pnpm & cmd-shim append: `# cmd-shim-target=<path>` (absolute or relative)
  const m = content.match(/^#\s*cmd-shim-target=(.+)\s*$/m);
  if (m) {
    const target = m[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(shimPath), target);
  }
  // Fallback: parse an `exec ... "$basedir[_win]/<relpath>" "$@"` line
  // (npm cmd-shim variants: quoted or bare `node`/`node.exe`, and a
  // `$basedir_win` variable on the Windows/WSL branches)
  const e = content.match(/exec\s+(?:.*?\s+)?"\$basedir(?:_win)?\/([^"]+)"\s+"\$@"/);
  if (e) return path.resolve(path.dirname(shimPath), e[1]);
  return null;
}

const entrypoints = new Set(); // absolute JS files to hand to nft
const extraFiles = new Set(); // absolute files to copy verbatim (shims, symlinks)
const dirs = new Set(); // absolute directories to copy recursively
const globs = []; // patterns relative to root

// Glob metacharacters that mark an argument as a pattern rather than a
// literal path. Note: @ and + (common in pnpm store paths) are not magic.
function hasGlobMagic(input) {
  return /[*?[\]{}]/.test(input);
}

function missing(message) {
  if (ignoreMissing) {
    console.warn(`warning: ${message}`);
  } else {
    console.error(`error: ${message} (use --ignore-missing to continue anyway)`);
    process.exit(1);
  }
}

/** Resolve a regular file: .bin shim -> its JS target, otherwise the file itself. */
async function addFileEntrypoint(abs, label) {
  const content = await fsp.readFile(abs, 'utf8');
  if (content.startsWith('#!') && !/^#!.*\bnode\b/.test(content.split('\n', 1)[0])) {
    // Shell shim (pnpm cmd-shim): find the real JS entry
    const target = parseCmdShim(abs, content);
    if (!target) {
      console.error(`Could not determine cmd-shim target of ${label}`);
      process.exit(1);
    }
    if (!fs.existsSync(target)) {
      console.error(`cmd-shim target of ${label} does not exist: ${target}`);
      process.exit(1);
    }
    entrypoints.add(target);
    extraFiles.add(abs);
  } else {
    // Plain JS file (possibly with a node shebang)
    entrypoints.add(abs);
  }
}

/** Classify an already-resolved absolute path: directory, symlink, or regular file. */
async function classifyAbsPath(abs, label) {
  const st = await fsp.lstat(abs).catch(() => null);

  if (!st) {
    missing(`path not found: ${label}`);
    return;
  }

  if (st.isDirectory()) {
    dirs.add(abs);
    return;
  }

  if (st.isSymbolicLink()) {
    const real = await fsp.realpath(abs).catch(() => null);
    if (!real) {
      missing(`dangling symlink: ${label}`);
      return;
    }
    extraFiles.add(abs); // always copy the symlink itself
    const rst = await fsp.stat(real);
    if (rst.isDirectory()) {
      dirs.add(real);
    } else {
      await addFileEntrypoint(real, label);
    }
    return;
  }

  await addFileEntrypoint(abs, label);
}

const PKG_PREFIX = 'pkg:';

/** Split a `pkg:` specifier body into its package name and optional subpath. */
function parsePkgSpecifier(spec) {
  const segments = spec.split('/');
  const pkgName = spec.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  const subpath = spec.slice(pkgName.length).replace(/^\/+/, '');
  return { pkgName, subpath };
}

let requireFromRoot;

/** Resolve a package's real (symlink-free) directory via Node module resolution. */
async function resolvePkgDir(pkgName) {
  if (!requireFromRoot) requireFromRoot = createRequire(path.join(root, 'package.json'));

  // First try resolving `<pkg>/package.json` directly — works for most packages.
  try {
    const pkgJsonPath = requireFromRoot.resolve(`${pkgName}/package.json`);
    return fsp.realpath(path.dirname(pkgJsonPath));
  } catch {
    // Fall through: restrictive "exports" map doesn't expose "./package.json".
  }

  // Second try: resolve the main entry and walk up to find the package root.
  // Works for packages with a restrictive exports map that still have a default export.
  try {
    const mainEntry = requireFromRoot.resolve(pkgName);
    let dir = path.dirname(mainEntry);
    const { root: fsRoot } = path.parse(dir);
    while (dir !== fsRoot) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        return fsp.realpath(dir);
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through: no default export either.
  }

  // Last resort: scan Node's module resolution paths for the package directory
  // directly in node_modules. Works for packages with no resolvable exports at
  // all (e.g. pure native binary packages that aren't hoisted by the package manager).
  const searchPaths = requireFromRoot.resolve.paths(pkgName) ?? [];
  for (const base of searchPaths) {
    const candidate = path.join(base, pkgName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fsp.realpath(candidate);
    }
  }

  missing(
    `could not resolve package "${pkgName}" ` +
      `(package not found or no resolvable entry point; use a literal node_modules path instead)`,
  );
  return null;
}

async function classifyInput(input) {
  if (input.startsWith(PKG_PREFIX)) {
    const { pkgName, subpath } = parsePkgSpecifier(input.slice(PKG_PREFIX.length));
    const pkgDir = await resolvePkgDir(pkgName);
    if (!pkgDir) return; // missing() already reported (or warned, with --ignore-missing)

    if (!subpath) {
      dirs.add(pkgDir);
    } else if (hasGlobMagic(subpath)) {
      globs.push(path.join(path.relative(root, pkgDir), subpath));
    } else {
      await classifyAbsPath(path.join(pkgDir, subpath), input);
    }
    return;
  }

  if (hasGlobMagic(input)) {
    globs.push(input);
    return;
  }

  await classifyAbsPath(path.resolve(root, input), input);
}

// ---------------------------------------------------------------------------
// Copy helpers — never overwrite, preserve symlinks
// ---------------------------------------------------------------------------

const stats = { copied: 0, skippedExisting: 0, filtered: 0 };

function isInsideNodeModules(rel) {
  return rel.split(path.sep).includes('node_modules');
}

async function copyEntry(absSrc) {
  const rel = path.relative(root, absSrc);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    stats.filtered++;
    if (verbose) console.log(`filter (outside root): ${absSrc}`);
    return;
  }
  if (!copyAll && !isInsideNodeModules(rel)) {
    stats.filtered++;
    if (verbose) console.log(`filter (outside node_modules): ${rel}`);
    return;
  }

  const srcStat = await fsp.lstat(absSrc);
  if (srcStat.isDirectory()) return;

  const dest = path.join(out, rel);
  const destStat = await fsp.lstat(dest).catch(() => null);
  if (destStat) {
    stats.skippedExisting++;
    return;
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (srcStat.isSymbolicLink()) {
    const link = await fsp.readlink(absSrc);
    await fsp.symlink(link, dest).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } else {
    await fsp.copyFile(absSrc, dest);
  }
  stats.copied++;
  if (verbose) console.log(`copy: ${rel}`);
}

async function copyDirRecursive(absDir) {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(p);
    } else {
      await copyEntry(p); // files and symlinks (symlinks copied as-is)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

for (const input of inputs) {
  await classifyInput(input);
}

let traced = 0;
if (entrypoints.size > 0) {
  const { fileList, warnings } = await nodeFileTrace([...entrypoints], {
    base: root,
    processCwd: root,
    mixedModules: true,
  });
  traced = fileList.size;
  if (verbose) {
    for (const w of warnings) console.warn(`nft warning: ${w.message.split('\n')[0]}`);
  }
  for (const rel of [...fileList].sort()) {
    await copyEntry(path.join(root, rel));
  }
}

for (const f of extraFiles) await copyEntry(f);

let globMatches = 0;
if (globs.length > 0) {
  const matches = new Set();
  for (const pattern of globs) {
    let matched = false;
    for await (const rel of fsp.glob(pattern, { cwd: root })) {
      matches.add(rel);
      matched = true;
    }
    if (!matched) {
      missing(`glob matched nothing: ${pattern}`);
    }
  }
  globMatches = matches.size;
  for (const rel of [...matches].sort()) {
    const abs = path.join(root, rel);
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) {
      await copyDirRecursive(abs);
    } else {
      await copyEntry(abs);
    }
  }
}

for (const d of dirs) await copyDirRecursive(d);

console.log(
  `include-standalone-deps: traced ${traced} files from ${entrypoints.size} entrypoint(s), ` +
    `${globMatches} glob matches; copied ${stats.copied}, kept ${stats.skippedExisting} existing, ` +
    `filtered ${stats.filtered} -> ${out}`,
);
