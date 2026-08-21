/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-user-habits`:
 * every `user-habits/committed` event must agree with the store state it
 * names — an add/update event names the exact committed entry version, and a
 * remove event names an id that is no longer present. This checks the
 * authoritative data stream (store state), never the event payload alone.
 *
 * @module @deepseek-ai/dsh-user-habits/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { HabitEntry, HabitOp } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-habits'

/** Cordis companion plugin name. */
export const name = 'user-habits-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Install commit agreement validation over the live event stream. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('user-habits/committed', (entry: HabitEntry, op: HabitOp) => {
    const current = ctx.habits.list().find(candidate => candidate.id === entry.id)
    if (op === 'remove') {
      if (current !== undefined) {
        fail(`user-habits/committed remove ${JSON.stringify(entry.id)} names an entry still present in the store`)
      }
      return
    }
    if (current === undefined || current.version !== entry.version) {
      fail(`user-habits/committed ${op} ${JSON.stringify(entry.id)} does not match the committed store state`)
    }
  }, { global: true })
}, { inject: ['habits'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
