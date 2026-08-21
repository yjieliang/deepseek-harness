/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-lookup-llm`.
 * @module @deepseek-ai/dsh-host-lookup-llm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-lookup-llm'

/** Cordis companion plugin name. */
export const name = 'host-lookup-llm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the endpoint is exercised through the public Remote
 * wire protocol; the auxiliary model call carries no session state.
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
