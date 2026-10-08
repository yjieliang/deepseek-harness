/**
 * Stub `agentPresets` service for the role-resolution scenario.
 *
 * Mounted inside the same `isolate: { requirementBoardRole: true }` group as the
 * real `role.js` row, so this is the only place in the process where the
 * declaration that row publishes is visible. That mirrors the platform registry:
 * `packages/preset/agent-preset-registry/README.md` states a preset service
 * provider and its consumers must share one `cordis:group` isolation realm, and
 * `serviceFor()` is the read that inspects it — while the service this row
 * publishes (`agentPresets`) is deliberately NOT isolated, so the board's
 * ordinary `ctx.get('agentPresets')` reaches it from the root realm.
 *
 * `serviceFor` resolves the declaration lazily, at call time, because the sibling
 * `role.js` row may activate after this one.
 */

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 'requirement-board-composition-presets-stub'

/** This row reads no service; it only publishes the registry. */
export const inject = []

/**
 * Publish the stub preset registry.
 *
 * @param ctx - The plugin context inside the role declaration's realm.
 * @param config - `{ declaredPreset }`: the preset id that carries a declaration.
 * @returns the disposer withdrawing the service.
 */
export function apply(ctx, config) {
  const declaredPreset = typeof config?.declaredPreset === 'string' && config.declaredPreset !== ''
    ? config.declaredPreset
    : 'art'
  return ctx.provide('agentPresets', {
    serviceFor(agent, key) {
      if (key !== 'requirementBoardRole') return undefined
      // Realm-scoped read: undefined outside this group, which is what makes an
      // unisolated declaration a different (and broken) composition.
      const declared = ctx.get('requirementBoardRole')
      if (declared === undefined) return undefined
      return agent?.ctx?.presetId === declaredPreset ? declared : undefined
    },
    composedPreset(target) {
      return typeof target?.presetId === 'string' ? target.presetId : undefined
    },
  })
}
