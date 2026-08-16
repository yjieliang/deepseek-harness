/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-habits-settings`.
 * @module @deepseek-ai/dsh-habits-settings/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-habits-settings'

/** Cordis companion plugin name. */
export const name = 'habits-settings-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the commit/store agreement every write must satisfy
 * is checked by the contract-level companion of `@deepseek-ai/dsh-user-habits`
 * against the same `ctx.habits` data stream this provider backs, and the
 * stored settings section is schema-validated by the settings seam itself at
 * every load and write, so no additional relation exists that a runtime check
 * could observe here without duplicating the contract companion.
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
