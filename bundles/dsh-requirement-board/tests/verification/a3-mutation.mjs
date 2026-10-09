#!/usr/bin/env node
/**
 * Mutation test for the A3 clock repair: does the pre-fix shape reproduce the
 * intermittent failure, and does the shipped version stay clean over the same
 * number of real-clock claims?
 *
 * `host/dispatch.js` `renewedLock(record, session, at)` ships as `touchedAt: at`
 * (one instant per write chain). A verification-only copy under `_red-copy/`
 * changes it back to a second `nowIso()`; this script then runs the same claim
 * over and over against either module and counts how often one claim produces a
 * lock whose `touchedAt` disagrees with the instant the same claim stamped into
 * `lock.at`, `updatedAt`, and the claim history entry.
 *
 * Real clock, no fake: the mismatch is the race the author's `dispatch` case
 * caught intermittently, so the count is a rate rather than a certainty.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/a3-mutation.mjs
 *   RB_A3_SERVICE=./_red-copy/service.js RB_A3_EXPECT_MISMATCH=1 RB_A3_N=200 …
 *
 * Written by a member other than the implementation's author.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from '../harness.mjs'
import { resolveConfig } from '../../host/config.js'
import { RequirementService } from '../../host/service.js'

const SERVICE_PATH = process.env.RB_A3_SERVICE ?? '../../host/service.js'
const EXPECT_MISMATCH = process.env.RB_A3_EXPECT_MISMATCH === '1'
const N = Number(process.env.RB_A3_N ?? '200')
const BACKEND = process.env.RB_A3_BACKEND ?? 'json'

/** The mutated service class, loaded from the path under test. */
const UnderTest = SERVICE_PATH === '../../host/service.js'
  ? RequirementService
  : (await import(SERVICE_PATH)).RequirementService

const dir = await mkdtemp(join(tmpdir(), 'a3-mutation-'))
const world = await openBoard({ backend: BACKEND, dir, config: resolveConfig({}), ports: {} })
const service = new UnderTest({ domain: world.domain, config: resolveConfig({}), ports: {} })

let mismatchAt = 0
let mismatchUpdated = 0
let mismatchHistory = 0
let maxSkewMs = 0

for (let index = 0; index < N; index += 1) {
  // One session per claim: a session holds one lock at a time, so reusing a
  // session would refuse the claim instead of exercising it.
  const session = `ses_mutation_${index}`
  const created = await service.createRequirement({ summary: '测试简述', title: `Mutation ${index}` }, { session: '', name: '面板' })
  const claimed = await service.claim(created.id, {}, { session, name: 'M' })
  const lock = claimed.lock
  if (lock.at !== lock.touchedAt) {
    mismatchAt += 1
    maxSkewMs = Math.max(maxSkewMs, Date.parse(lock.touchedAt) - Date.parse(lock.at))
  }
  if (lock.touchedAt !== claimed.updatedAt) mismatchUpdated += 1
  if (lock.touchedAt !== claimed.history.at(-1).at) mismatchHistory += 1
}

await world.close()
await rm(dir, { recursive: true, force: true })

const rate = (count) => `${count}/${N} (${((count / N) * 100).toFixed(2)}%)`
console.log(`service under test: ${SERVICE_PATH} on ${BACKEND}, ${N} claims on the real clock`)
console.log(`  lock.touchedAt !== lock.at            : ${rate(mismatchAt)}${maxSkewMs === 0 ? '' : `, largest skew ${maxSkewMs} ms`}`)
console.log(`  lock.touchedAt !== updatedAt          : ${rate(mismatchUpdated)}`)
console.log(`  lock.touchedAt !== history entry time : ${rate(mismatchHistory)}`)
process.exit(EXPECT_MISMATCH ? (mismatchAt > 0 ? 0 : 1) : (mismatchAt === 0 ? 0 : 1))
