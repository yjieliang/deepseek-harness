#!/usr/bin/env node
/**
 * The D19 tree digest for stage B: `index.js` + `host/*.js` + `tests/*.mjs`,
 * each truncated to eight hex characters of SHA256, joined with `-`.
 *
 * `tests/verification/**` is deliberately outside the digest: it is this
 * verifier's own instrument, not the author's tree.
 *
 * Usage: node tests/verification/b-digest.mjs
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const files = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
  .map(entry => entry.name)
  .sort()
for (const dir of ['host', 'tests']) {
  const names = (await readdir(new URL(dir, root))).filter(name => name.endsWith('.js') || name.endsWith('.mjs')).sort()
  for (const name of names) files.push(`${dir}/${name}`)
}
const parts = []
for (const rel of files) {
  const bytes = await readFile(new URL(rel, root))
  parts.push(createHash('sha256').update(bytes).digest('hex').slice(0, 8))
}
console.log(parts.join('-'))
console.log(`${files.length} files: ${files.join(' ')}`)
