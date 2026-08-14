/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-kb`.
 * @module @deepseek-ai/dsh-client-ui-kb/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-kb'

/** Cordis companion plugin name. */
export const name = 'client-ui-kb-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the trigger and the panel register into declared
 * slots (a presentation effect owned by the slot registry), and every read
 * goes through the `kb` Remote namespace without durable client state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
