/**
 * Audit the board's own synchronization state from a read-only copy of the
 * production medium.
 *
 * The panel and the runtime context both render a "sync" line per requirement
 * (`sync.gap`, `execSync.gaps`) and a global pair of counters. This probe prints
 * exactly those stored values next to each requirement, so a claim like "only one
 * requirement syncs" can be checked against the bytes rather than the rendering.
 *
 * The medium (and its `-wal`/`-shm`) is copied to a temporary directory first;
 * the live file is never opened.
 *
 * Usage: node probes/sync-audit.mjs [db-path]
 *   (default: <DSH_PROFILE_DIR or ~/.dsh>/storages/requirement_board.db)
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Storages sit under the harness home, not the profile directory; accept either
// when the caller names no path.
const homes = [process.env.DSH_HOME, join(homedir(), '.dsh'), process.env.DSH_PROFILE_DIR]
  .filter(home => typeof home === 'string' && home !== '')
const fallback = join(homes[0] ?? join(homedir(), '.dsh'), 'storages', 'requirement_board.db')
const source = process.argv[2] ?? homes
  .map(home => join(home, 'storages', 'requirement_board.db'))
  .find(candidate => existsSync(candidate)) ?? fallback
if (!existsSync(source)) {
  console.log(`no medium at ${source}`)
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'rb-sync-audit-'))
const base = join(scratch, 'requirement_board.db')
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${base}${suffix}`)
}

/** One line's worth of a value of unknown size. */
const brief = (value, max = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text === undefined ? 'undefined' : text.length > max ? `${text.slice(0, max)}…` : text
}

const db = new DatabaseSync(base, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'u\\_%' ESCAPE '\\'").all()
const requirements = []
const others = []

for (const { name } of tables) {
  for (const row of db.prepare(`SELECT key, value FROM "${name}"`).all()) {
    let record
    try {
      record = JSON.parse(row.value)
    } catch {
      others.push(`${row.key} (unparsed in ${name})`)
      continue
    }
    if (typeof row.key === 'string' && row.key.startsWith('req_')) requirements.push(record)
    else others.push(`${row.key}: ${brief(record)}`)
  }
}
db.close()
rmSync(scratch, { recursive: true, force: true })

console.log(`medium         ${source}`)
console.log(`requirements   ${requirements.length}`)
for (const record of requirements) {
  const sync = record.sync ?? {}
  const lock = record.lock === null || record.lock === undefined ? '-' : (record.lock.orphaned === true ? 'orphaned' : record.lock.session)
  console.log(
    `${record.id}  status=${record.status} node=${record.nodeId} rev=${record.rev} lock=${lock} ` +
    `sync.gap=${sync.gap === true} syncedAt=${brief(sync.syncedAt, 24)} reason=${brief(sync.reason, 32)} ` +
    `units=${Array.isArray(record.executions) ? record.executions.length : 0} truncated=${record.executionsTruncated === true} ` +
    `execRev=${record.execRev ?? '-'} images=${Array.isArray(record.images) ? record.images.length : 0} ` +
    `updated=${brief(record.updatedAt, 24)}`,
  )
  const running = (record.executions ?? []).filter(unit => unit.status === 'running' || unit.status === 'stopping')
  if (running.length > 0) for (const unit of running) console.log(`    running ${unit.ref} ${unit.kind} ${brief(unit.label, 60)} since ${brief(unit.startedAt, 24)} stale=${unit.stale === true}`)
  if (Array.isArray(record.executions) && record.executions.length > 0) {
    const newest = record.executions[record.executions.length - 1]
    console.log(`    newest  ${brief(newest?.ref, 20)} ${brief(newest?.status, 12)} finished=${brief(newest?.finishedAt, 24)} stale=${newest?.stale === true}`)
  }
}
for (const line of others) console.log(`other          ${line}`)
