/**
 * Inspect one SQLite KV file after an S2 run: its unit stamps, its record
 * tables, and their rows. Read-only with respect to the harness; the caller
 * owns deleting the file.
 *
 * Usage: node probes/s2-inspect-db.mjs <absolute-or-relative-db-path>
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const path = process.argv[2]
if (path === undefined) throw new Error('usage: node probes/s2-inspect-db.mjs <db-path>')

console.log(`db              ${path}`)
console.log(`exists          ${existsSync(path)}`)
if (!existsSync(path)) process.exit(0)

const db = new DatabaseSync(path, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
console.log(`tables          ${tables.map(row => row.name).join(', ')}`)
for (const { name } of tables) {
  if (name === 'units') {
    for (const row of db.prepare('SELECT name, version FROM units ORDER BY name').all()) {
      console.log(`unit            ${row.name} version=${row.version}`)
    }
    continue
  }
  if (name === 'sqlite_sequence') continue
  if (!name.startsWith('u_')) continue
  const rows = db.prepare(`SELECT key, value FROM "${name}" ORDER BY key`).all()
  console.log(`table           ${name} rows=${rows.length}`)
  for (const row of rows) console.log(`  ${row.key} -> ${row.value}`)
}
db.close()
