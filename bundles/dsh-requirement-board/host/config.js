/**
 * Config resolution for the Requirement Board row.
 *
 * The plugin declares no Loader `Config` schema, so this module is the
 * validation step at the row boundary: it reads the raw `config` object from
 * `cordis.patch.yml`, applies documented defaults, and throws on a malformed
 * value instead of silently falling back. Every deployment-varying choice the
 * plugin has lives here.
 *
 * Storage used to take a `dataDir` here. That choice now belongs to the
 * storage-domain route (which backend, and the backend's own path), so a
 * leftover path key is a misconfiguration: it is refused by name rather than
 * ignored, because silently dropping it would leave the operator believing
 * their data still lives where they put it.
 */

import { LOCK_LEASE_HOURS } from './dispatch.js'
import { defaultImageDir } from './domain.js'
import { fail } from './model.js'

/** Config keys the storage migration removed; their presence is a hard error. */
const REMOVED_KEYS = ['dataDir', 'documentPath']

/**
 * Resolve and validate the row config.
 * @param raw - Raw `config` object from the Loader patch, or `undefined`.
 * @returns the resolved config with validated bounds.
 */
export function resolveConfig(raw) {
  const input = raw ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-config', 'requirement-board config must be an object')
  }
  for (const removed of REMOVED_KEYS) {
    if (Object.hasOwn(input, removed)) {
      fail(
        'invalid-config',
        `requirement-board config "${removed}" was removed: the storage backend and its path are deployment choices of the storage-domain route, not of this plugin row`,
      )
    }
  }
  return {
    defaultTemplateId: input.defaultTemplateId === undefined || input.defaultTemplateId === null || input.defaultTemplateId === ''
      ? 'tpl-standard'
      : requireString(input.defaultTemplateId, 'defaultTemplateId'),
    stallAfterHours: requireNumber(input.stallAfterHours, 'stallAfterHours', 72, 0.1, 24 * 365),
    // Absolute directory holding the files of pasted requirement images. The
    // bytes live outside the records, so this is the one part of the board's
    // data whose location the storage route does not decide.
    imageDir: input.imageDir === undefined || input.imageDir === null || input.imageDir === ''
      ? defaultImageDir()
      : requireString(input.imageDir, 'imageDir'),
    // The lease a lock survives without being touched (§5.2). Keeping the
    // default beside the lock it bounds means the two cannot drift apart.
    staleClaimHours: requireNumber(input.staleClaimHours, 'staleClaimHours', LOCK_LEASE_HOURS, 0.1, 720),
    // How many requirements one session may reserve in its queue (§5.3).
    maxQueueItems: requireInteger(input.maxQueueItems, 'maxQueueItems', 20, 5, 100),
    promptContext: requireBoolean(input.promptContext, 'promptContext', true),
    promptMaxItems: requireNumber(input.promptMaxItems, 'promptMaxItems', 12, 1, 100),
    http: requireBoolean(input.http, 'http', true),
    // Whether this row follows sub-agent and background-job state into the
    // requirements it locks (§5.12). On by default: one execution-sync write is
    // a single-row update, so the churn the old whole-document store made
    // expensive no longer applies.
    executionSync: requireBoolean(input.executionSync, 'executionSync', true),
    // The optional hard gate of §5.4. Off by default: with it on, a session that
    // holds no board lock cannot call a tool that starts execution, including
    // work that has nothing to do with this board.
    requireLockForExecution: requireBoolean(input.requireLockForExecution, 'requireLockForExecution', false),
    // How many execution units one requirement keeps before the oldest is
    // dropped and the record is marked truncated.
    maxExecutions: requireInteger(input.maxExecutions, 'maxExecutions', 20, 5, 100),
    // Merge window for the browser stream (§4.1 read amplification): one change
    // frame per window instead of one per committed row write. 0 forwards every
    // frame, which is the documented way to observe the coalescer itself.
    sseCoalesceMs: requireNumber(input.sseCoalesceMs, 'sseCoalesceMs', 300, 0, 5000),
    // Off by default: opening the board must never absorb a legacy document the
    // operator did not ask for. Stage R turns it on for exactly one start.
    importLegacy: requireBoolean(input.importLegacy, 'importLegacy', false),
  }
}

/** Read a non-empty string config field. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('invalid-config', `requirement-board config "${field}" must be a non-empty string`)
  }
  return value.trim()
}

/** Read a finite number config field inside an inclusive range. */
function requireNumber(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    fail('invalid-config', `requirement-board config "${field}" must be a number between ${min} and ${max}`)
  }
  return parsed
}

/** Read a boolean config field. */
function requireBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  fail('invalid-config', `requirement-board config "${field}" must be a boolean`)
}

/** Read a whole-number config field inside an inclusive range. */
function requireInteger(value, field, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail('invalid-config', `requirement-board config "${field}" must be a whole number between ${min} and ${max}`)
  }
  return parsed
}
