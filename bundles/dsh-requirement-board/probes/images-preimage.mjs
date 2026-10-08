/**
 * Evidence that the operator's real stored board still opens after `images` was
 * added to the record.
 *
 * The live medium under `~/.dsh` is never touched. This probe works on the
 * read-only preimage copy under `rollout/backup-preimage-*`, copies it once more
 * into a temporary directory (an opened SQLite medium needs a writable WAL), and
 * reads every requirement back through the real service: a record written before
 * `images` existed has no such key in the medium and must read as one carrying an
 * empty list, and the unit stamp must still be the version this build declares.
 *
 * Usage: node probes/images-preimage.mjs [backup-directory]
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { SCHEMA_VERSION } from '../host/model.js'
import { boardService, openRawBoard } from '../tests/harness.mjs'

const BUNDLE = fileURLToPath(new URL('..', import.meta.url))
const backup = resolve(process.argv[2] ?? join(BUNDLE, 'rollout', 'backup-preimage-20261004-132610'))
const source = join(backup, 'requirement_board.db')
if (!existsSync(source)) {
  console.error(`backup medium not found: ${source}`)
  process.exit(2)
}

const dir = await mkdtemp(join(tmpdir(), 'rb-preimage-'))
let opened
try {
  // The medium is copied under the backend's own file name, WAL included: the
  // rows live in the WAL until a checkpoint, so a copy of the `.db` alone would
  // read an older board.
  await copyFile(source, join(dir, 'board.db'))
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) await copyFile(`${source}${suffix}`, join(dir, `board.db${suffix}`))
  }

  const stamp = new DatabaseSync(join(dir, 'board.db'), { readOnly: true })
  const unit = stamp.prepare('SELECT name, version FROM units').get()
  stamp.close()
  console.log(`backup          ${backup}`)
  console.log(`working copy    ${dir}`)
  console.log(`unit            ${unit.name} version=${unit.version}`)
  console.log(`declared        SCHEMA_VERSION=${SCHEMA_VERSION}`)

  opened = await openRawBoard({ backend: 'sqlite', dir })
  const service = boardService(opened.domain)
  const rows = [...opened.domain.table('requirements').entries()]
  let checks = 0
  let failures = 0
  const check = (label, condition) => {
    checks += 1
    if (condition) {
      console.log(`  ok   ${label}`)
      return
    }
    failures += 1
    console.log(`  FAIL ${label}`)
  }

  console.log(`\nrequirements    ${rows.length}`)
  for (const [id, record] of rows) {
    const read = service.getRequirement(id)
    const empty = Array.isArray(read.images) && read.images.length === 0
    check(`${id}  ${record.title}  images=${read.images?.length}  storedKey=${record.images === undefined ? 'absent' : 'present'}`, empty && read.title === record.title)
  }
  check(`the preimage holds the 4 records the operator reported`, rows.length === 4)
  check(`the stored global stamp is still ${SCHEMA_VERSION}`, opened.domain.global.get().schemaVersion === SCHEMA_VERSION)
  console.log(`\n${checks - failures}/${checks} checks passed`)
  await opened.close()
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await opened?.close()
  await rm(dir, { recursive: true, force: true })
}
