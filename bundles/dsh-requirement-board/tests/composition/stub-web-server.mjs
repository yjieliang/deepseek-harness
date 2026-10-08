/**
 * Test-only `webServer` stub for the requirement-board REAL composition.
 *
 * The production profile owns one process-wide HTTP listener. Asserting that the
 * board registered its browser route does not need a port, and this channel must
 * open no listener, so the stub records what a real server would have mounted
 * and removes the record through the same disposer the route owner uses.
 *
 * The record list is live: disposal empties it in place, exactly as a real
 * server would unregister the route.
 */

/** Stable plugin name for Loader diagnostics. */
export const name = 'requirement-board-composition-web-server'

/**
 * Register the stub as this fiber's `webServer` service.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  /** Route registrations currently mounted, in registration order. */
  const registrations = []

  /**
   * Record one route registration.
   * @param route - `{ kind, path, handler }` as the board route declares it.
   * @returns the disposer removing the record, mirroring a real server.
   */
  function register(route) {
    const record = {
      kind: typeof route?.kind === 'string' ? route.kind : '',
      path: typeof route?.path === 'string' ? route.path : '',
      hasHandler: typeof route?.handler === 'function',
    }
    registrations.push(record)
    return () => {
      const index = registrations.indexOf(record)
      if (index >= 0) registrations.splice(index, 1)
    }
  }

  ctx.provide('webServer', {
    get registrations() { return registrations },
    register,
  })
}
