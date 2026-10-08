/**
 * Measure what the board puts into a model step, from a read-only copy of the
 * production store.
 *
 * The board's own numbers answer "why is this session expensive": every write
 * receipt carries the whole requirement, and its `executions` array grows with
 * the very work the session does. This probe prints, per requirement, the size
 * of the stored JSON, the `executions` share of it, and the same record as it
 * would read with `maxExecutions` cut to five — so a configuration change can be
 * judged before it is made.
 *
 * It never opens the live file: the medium (and its `-wal`/`-shm`) is copied to a
 * temporary directory first, and that copy is opened read-only and deleted.
 *
 * Usage: node probes/token-budget.mjs [db-path]
 *   (default: <DSH_PROFILE_DIR or ~/.dsh>/storages/requirement_board.db)
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Storages sit under the harness home, not the profile directory; accept either
// when the caller names no path.
const HOMES = [process.env.DSH_HOME, join(homedir(), '.dsh'), process.env.DSH_PROFILE_DIR]
  .filter(home => typeof home === 'string' && home !== '')
const fallback = join(HOMES[0] ?? join(homedir(), '.dsh'), 'storages', 'requirement_board.db')
const source = process.argv[2] ?? HOMES
  .map(home => join(home, 'storages', 'requirement_board.db'))
  .find(candidate => existsSync(candidate)) ?? fallback

if (!existsSync(source)) {
  console.log(`no medium at ${source}`)
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'rb-token-budget-'))
const base = join(scratch, 'requirement_board.db')
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${base}${suffix}`)
}

/** Bytes a value occupies in a request, measured on its JSON text. */
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

const db = new DatabaseSync(base, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'u\\_%' ESCAPE '\\'").all()
let total = 0
let executionsTotal = 0
let withFive = 0
let rows = 0

for (const { name } of tables) {
  for (const row of db.prepare(`SELECT key, value FROM "${name}"`).all()) {
    if (typeof row.key !== 'string' || !row.key.startsWith('req_')) continue
    let record
    try {
      record = JSON.parse(row.value)
    } catch {
      continue
    }
    const units = Array.isArray(record.executions) ? record.executions : []
    const whole = size(record)
    const unitsSize = size(units)
    const trimmed = size({ ...record, executions: units.slice(-5) })
    rows += 1
    total += whole
    executionsTotal += unitsSize
    withFive += trimmed
    const share = whole === 0 ? 0 : Math.round((unitsSize / whole) * 100)
    console.log(
      `${record.id ?? row.key}  record=${whole}B  executions=${units.length} (${unitsSize}B, ${share}%)  ` +
      `at maxExecutions=5: ${trimmed}B (${whole === 0 ? 0 : Math.round((trimmed / whole) * 100)}%)`,
    )
  }
}
db.close()
rmSync(scratch, { recursive: true, force: true })

if (rows === 0) {
  console.log(`no requirement rows in ${tables.map(t => t.name).join(', ')}`)
  process.exit(0)
}
const percent = (part, whole) => (whole === 0 ? '0' : String(Math.round((part / whole) * 100)))
console.log(
  `\n${rows} requirements  stored total=${total}B  executions=${executionsTotal}B (${percent(executionsTotal, total)}%)  ` +
  `all records at maxExecutions=5: ${withFive}B (${percent(withFive, total)}% of today)`,
)
console.log(`medium size on disk: ${statSync(source).size}B`)
