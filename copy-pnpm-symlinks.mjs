#!/usr/bin/env node
/**
 * copy-pnpm-symlinks — re-create pnpm's node_modules symlinks (packages and
 * scoped sub-packages pointing into .pnpm) inside a Next.js standalone output
 * directory, since NFT tracing copies real files but doesn't wire up pnpm's
 * symlink layout on its own.
 *
 * Usage:
 *   copy-pnpm-symlinks <src_node_modules> <dst_node_modules>
 *
 * For every symlink directly under <src_node_modules> (including one level
 * into scoped @scope directories), if the link's target also exists relative
 * to <dst_node_modules>, the same symlink is (re)created there.
 */

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const [, , src, dst] = process.argv

if (!src || !dst) {
  console.error('Usage: copy-pnpm-symlinks <src_node_modules> <dst_node_modules>')
  process.exit(1)
}

if (!fs.existsSync(src)) {
  console.error(`Source directory does not exist: ${src}`)
  process.exit(1)
}

if (!fs.existsSync(dst)) {
  console.error(`Destination directory does not exist: ${dst}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

for (const name of fs.readdirSync(src)) {
  if (name === '.pnpm') continue

  const srcPath = path.join(src, name)
  const isScope = name.startsWith('@') && fs.lstatSync(srcPath).isDirectory()

  const items = isScope
    ? fs.readdirSync(srcPath).map((sub) => path.join(name, sub))
    : [name]

  for (const item of items) {
    const itemPath = path.join(src, item)

    if (fs.lstatSync(itemPath).isSymbolicLink()) {
      const dstPath = path.join(dst, item)
      const target = fs.readlinkSync(itemPath)

      if (fs.existsSync(path.resolve(path.dirname(dstPath), target))) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true })
        fs.rmSync(dstPath, { recursive: true, force: true })
        fs.symlinkSync(target, dstPath)
      }
    }
  }
}
