/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-lookup`.
 * @module @deepseek-ai/dsh-client-ui-lookup/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-lookup'

/** Cordis companion plugin name. */
export const name = 'client-ui-lookup-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the overlay registers into the declared
 * `shell.overlay` slot (a presentation effect owned by the slot registry),
 * and the dictionary lookups run in the browser without durable state.
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
