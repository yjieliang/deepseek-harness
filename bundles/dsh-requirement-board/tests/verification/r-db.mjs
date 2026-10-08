#!/usr/bin/env node
/**
 * Read-only readback of a Requirement Board sqlite medium (stage R verification).
 *
 * Independent of the rollout-side inspector: it prints every table with its row
 * count and columns, every row of the singleton tables, and the requirement keys;
 * `--json` prints the same reading as one JSON object so two boots can be diffed
 * mechanically. The connection is opened `readOnly` and nothing is ever written,
 * so it can run while a live host holds the same file in WAL mode.
 *
 * Usage (from the repository root):
 *   node --experimental-sqlite .artifacts/requirement-board/tests/verification/r-db.mjs [db-path] [--json]
 */

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const path = argv.find(argument => !argument.startsWith('--')) ?? 'C:/Users/Administrator/.dsh/storages/requirement_board.db'
const stat = statSync(path)
const db = new DatabaseSync(path, { readOnly: true })

const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all().map(row => row.name)
const reading = { path, bytes: stat.size, mtime: stat.mtime.toISOString(), tables: {}, singletons: {}, requirementsKeys: [] }
for (const table of tables) {
  reading.tables[table] = {
    rows: db.prepare(`select count(*) as n from "${table}"`).get().n,
    columns: db.prepare(`pragma table_info("${table}")`).all().map(column => column.name),
  }
  if (table !== 'requirements' && table !== 'templates') {
    reading.singletons[table] = db.prepare(`select * from "${table}" order by 1`).all()
  }
}
if (tables.includes('requirements')) {
  reading.requirementsKeys = db.prepare('select key from requirements order by key').all().map(row => row.key)
}
db.close()

if (asJson) {
  console.log(JSON.stringify(reading, null, 2))
  process.exit(0)
}
console.log(`file    = ${reading.path} (${reading.bytes} B, mtime ${reading.mtime})`)
console.log(`tables  = ${tables.join(', ')}`)
for (const table of tables) {
  console.log(`${table.padEnd(14)} rows=${reading.tables[table].rows} cols=${reading.tables[table].columns.join(',')}`)
}
for (const [table, rows] of Object.entries(reading.singletons)) {
  for (const row of rows) console.log(`${table} row = ${JSON.stringify(row)}`)
}
console.log(`requirements keys = ${reading.requirementsKeys.length === 0 ? '(none)' : reading.requirementsKeys.join(', ')}`)
