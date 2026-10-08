/**
 * Stub `agents` service for the role-resolution scenario.
 *
 * The board reads the agent registry through a resolver (`ctx.get('agents')`) to
 * answer two questions: which session a prompt assembly belongs to, and which
 * role each live session resolves to. Both are external, process-owned inputs, so
 * the channel substitutes this registry instead of starting real sessions — the
 * task forbids creating a session or writing the Harness home.
 *
 * The roster arrives as JSON in `RB_BOARD_STUB_AGENTS` because the runner owns
 * the world: the driver can then assert against the same ids without sharing a
 * module instance with the Loader's copy of this row.
 */

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 'requirement-board-composition-agents-stub'

/** This row reads no service; it only publishes the registry. */
export const inject = []

/**
 * Read the seeded roster.
 * @returns the agents described by `RB_BOARD_STUB_AGENTS`.
 */
function roster() {
  const raw = process.env.RB_BOARD_STUB_AGENTS
  if (typeof raw !== 'string' || raw === '') return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('RB_BOARD_STUB_AGENTS must be a JSON array')
  return parsed.map(entry => ({
    id: String(entry.id),
    status: typeof entry.status === 'string' ? entry.status : 'idle',
    // The preset identity is what the real Agent carries on its scope for
    // `agentPresets.composedPreset()`; this stub keeps the same shape.
    ctx: { presetId: String(entry.presetId) },
  }))
}

/**
 * Publish the stub registry.
 * @param ctx - The plugin context.
 * @returns the disposer withdrawing the service.
 */
export function apply(ctx) {
  const agents = roster()
  return ctx.provide('agents', {
    get: id => agents.find(agent => agent.id === id),
    list: () => [...agents],
  })
}
