/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-memory`.
 * @module @deepseek-ai/dsh-command-memory/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-memory'

/** Cordis companion plugin name. */
export const name = 'command-memory-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the command appends no session events of its own
 * (`recordInput: false` keeps the durable command pairing minimal), and every
 * durable fact it creates goes through `ctx.habits.write`/`remove`, whose
 * commit/store agreement is checked by the contract-level companion of
 * `@deepseek-ai/dsh-user-habits` against the same authoritative data stream,
 * so no additional relation exists for this package to observe at runtime.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
