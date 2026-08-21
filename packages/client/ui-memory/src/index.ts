/**
 * Node half of `@deepseek-ai/dsh-client-ui-memory` — a browser-side surface
 * plugin, so the node half owns nothing: the memory section reads and writes
 * the `user-habits` settings namespace through the wire, which is a host
 * contract owned by `@deepseek-ai/dsh-habits-settings`.
 * @module @deepseek-ai/dsh-client-ui-memory
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Mount the node half (no-op).
 * @param ctx - the plugin context.
 */
export function apply(ctx: ClientContext): void {
  void ctx
}
