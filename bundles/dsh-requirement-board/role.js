/**
 * Declare the role a preset's sessions hold (`ROLE-DISPATCH.md` §2.3).
 *
 * This is a function plugin mounted inside an
 * `isolate: { requirementBoardRole: true }` group of one preset: the
 * declaration then lives in that preset's realm, which is exactly what
 * `agentPresets.serviceFor(agent, 'requirementBoardRole')` reads. Mounted
 * unisolated it would publish the service process-wide, and the preset registry
 * reports such a preset as broken.
 *
 * No `Config` schema is declared. The row carries three fields, and
 * `parseRoleDeclaration` is the one gate for them: it rejects an unusable role
 * id where the row is written, so an invalid declaration fails the row loud
 * instead of publishing a role no task could name.
 */

import { parseRoleDeclaration } from './host/model.js'

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 'requirement-board-role'

/** This row reads no service; it only publishes its declaration. */
export const inject = []

/**
 * Publish this row's role declaration.
 * @param ctx - The preset-scoped plugin context.
 * @param config - Raw `{ roleId, roleName, duties }` from the `board-role` row.
 * @returns the disposer withdrawing the service.
 */
export function apply(ctx, config) {
  const declaration = parseRoleDeclaration(config)
  return ctx.provide('requirementBoardRole', declaration)
}
