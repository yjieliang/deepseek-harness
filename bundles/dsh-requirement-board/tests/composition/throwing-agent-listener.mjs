/**
 * Test-only negative control for `agent/created` containment.
 *
 * Agent creation dispatches `agent/created` through `ctx.serial`, so a listener
 * that lets an error escape rejects the dispatch and breaks the creation. This
 * plugin is exactly that uncontained listener, and the composition runner uses
 * it to prove the channel reports the failure mode it exists to catch.
 */

/** Message the listener throws; the runner matches it. */
export const PROBE_MESSAGE = 'composition probe: uncontained agent/created listener'

/** Stable plugin name for Loader diagnostics. */
export const name = 'requirement-board-composition-throwing-listener'

/**
 * Register the throwing listener on this fiber.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.on('agent/created', () => {
    throw new Error(PROBE_MESSAGE)
  })
}
