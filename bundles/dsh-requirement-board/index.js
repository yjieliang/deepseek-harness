/**
 * Requirement Board — the Host half.
 *
 * One Host process owns one board domain, one {@link RequirementService}, and
 * therefore one board: every session of the process reads and writes the same
 * committed records. This entry wires the consumers of that service:
 *
 * - agent tools (`requirement_board`, `flow_template`, `requirement_role`),
 * - the browser route `/api/requirement-board` (snapshot, command, SSE),
 * - the model's runtime context, so a session's AI always sees the live board,
 * - the `agent/created` registration of a session's own role, plus the one
 *   startup sweep of references an interrupted write chain left dangling,
 * - the `agent/disposed` settling: the session's queue row is dropped and every
 *   lock it held is marked orphaned,
 * - the execution synchronizer, when `executionSync` is on: the subagent
 *   lifecycle and the background-job stream are folded into the locked
 *   requirement's execution units, and the optional `requireLockForExecution`
 *   gate refuses execution tools from a session holding no lock,
 * - nothing else: the panel, the tools, and the prompt all read the same
 *   methods, so no rule is implemented twice.
 *
 * Plugin lifecycle: this plugin requires `tools` and `storageDomain`. The
 * browser route and the prompt context are optional services, so the plugin
 * stays active in profiles that lack them.
 *
 * Opening the storage is part of activation, not a background step: `apply`
 * awaits `open` and the bootstrap. That placement is deliberate — a rejected
 * `apply` marks the entry failed and the Loader reports it, whereas a rejection
 * inside a `ctx.effect` body is swallowed and the entry would stay "active"
 * with no tools (vendor/cordis/src/fiber.ts:545-548).
 */

import { resolveConfig } from './host/config.js'
import { bootstrapRequirementBoard, openBoardDomain, requirementBoardDomain } from './host/domain.js'
import { RequirementService } from './host/service.js'
import { registerBoardRoute } from './host/http.js'
import { registerTools } from './host/tools.js'
import { executionGateDecision } from './host/runs.js'

/** Runtime-context order: after the stock policy contexts (110–120). */
const PROMPT_CONTEXT_ORDER = 130

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 'requirement-board'

/** `tools` and the storage form are the services the plugin cannot work without. */
export const inject = ['tools', 'storageDomain']

/**
 * Report one failed role registration.
 *
 * `agent/created` is serial and awaited before a session's creation resolves,
 * so a rejection there would fail the creation (ROLE-DISPATCH.md §3.2). The
 * listener routes both the synchronous and the asynchronous failure here, and
 * this message names the session and the error that was contained.
 * @param logger - Host logger, when the context carries one.
 * @param agent - The Agent the registration was for.
 * @param error - The contained failure.
 */
function warnRoleRegistration(logger, agent, error) {
  const session = typeof agent?.id === 'string' ? agent.id : ''
  logger?.warn?.(`requirement-board: registering the role of session "${session}" failed and was ignored so the session is still created: ${String(error)}`)
}

/** Read the session id out of an assembly scope, which is the Agent. */
function sessionOfScope(scope) {
  const id = scope?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Report one contained execution-observation failure.
 *
 * The board keeps working without the observation — the requirement it belongs to
 * reports `sync.gap` — so the failure is logged with the producer that raised it
 * rather than escaping into the subagent or job lifecycle that emitted it.
 * @param logger - Host logger, when the context carries one.
 * @param source - Lifecycle edge or job event type that failed.
 * @param error - The contained failure.
 */
function warnExecutionSync(logger, source, error) {
  logger?.warn?.(`requirement-board: recording the execution observed through ${source} failed and was ignored: ${String(error)}`)
}

/**
 * Adapt the platform agent registry to the board's ownership port.
 *
 * The board asks one question in session ids — "is `target` a sub-session of
 * `caller`?" — while the platform answers it in live Agent objects:
 * `agents.isOwnedBy(id, ownerAgent)` compares the creating agent by object
 * identity, so the parent id must be resolved with the public `agents.get(id)`
 * first. Keeping that resolution here means no board code has to know what an
 * Agent object is, and the platform's signature appears in exactly one place.
 *
 * Runtime ownership alone is not the whole answer, and it is asked first: a
 * registry that can decide for a session with no live Agent — a durable one, or
 * the platform's own once the child is materialized — knows more than a liveness
 * guess does, so its `true` is taken whatever the target's state is.
 *
 * Only a `false` needs more evidence. A continuable sub-session is materialized
 * on demand, so a target the registry does not hold yet may well be the caller's
 * own child; and a child keeps its recorded creator in its own session header
 * (`header.parentSession`) even after the parent's live Agent object is replaced
 * by a resume. The header is the platform's own record of the relation, so it
 * decides: naming the caller is a `true`, naming anyone else is a `false`.
 *
 * `undefined` is the answer when a `false` cannot be made to mean anything: no
 * registry is mounted, the registry exposes no ownership predicate, the caller
 * has no live Agent, or the target has no live Agent and no recorded creator to
 * read. The caller reports that once and delegates without the check.
 * @param ctx - Host plugin context.
 * @returns `(target, caller) => boolean | undefined`.
 */
export function createOwnershipPort(ctx) {
  return (target, caller) => {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.isOwnedBy !== 'function' || typeof agents.get !== 'function') return undefined
    const owner = agents.get(caller)
    if (owner === undefined) return undefined
    if (agents.isOwnedBy(target, owner) === true) return true
    const child = agents.get(target)
    const recorded = child?.session?.header?.parentSession
    if (typeof recorded === 'string' && recorded !== '') return recorded === caller
    // A target the registry does not hold is not a decided stranger: a
    // continuable sub-session has no live Agent until it is first activated.
    if (child === undefined) return undefined
    return false
  }
}

/**
 * Forward one app-wide domain change to the board's subscribers.
 *
 * `domain/changed` carries no context filter, so every domain's writes reach
 * every listener in the process; only this board's own domain is republished.
 * A committed record write emits twice — once for the record, once for the
 * global revision that follows it — so subscribers observe the write and its
 * revision bump in write order; coalescing that pair belongs to the stream's
 * later merge window, not to this filter.
 * @param change - The `domain/changed` payload.
 * @param service - The board service holding the subscribers.
 */
export function forwardDomainChange(change, service) {
  if (change.domain !== requirementBoardDomain.name) return
  service.publishDomainChange(change)
}

/**
 * Mount the board.
 * @param ctx - Host plugin context.
 * @param config - Raw row config from `cordis.patch.yml`; resolved and validated here.
 * @returns resolution after every registration; rejection fails the entry loud.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  // The board's own open step, so an unreadable stored record names the field it
  // broke on in the error a failed boot prints (see `openBoardDomain`).
  const domain = await openBoardDomain(ctx.storageDomain)
  try {
    await bootstrapRequirementBoard(domain, {
      importLegacy: resolved.importLegacy,
      logger: ctx.logger,
    })
  } catch (error) {
    // Release the unit before the failure escapes, so the domain name is free
    // for a corrected configuration and no half-open board is left behind.
    await domain.close().catch(closeError => {
      ctx.logger?.warn?.(`requirement-board: closing the domain after a failed bootstrap failed: ${String(closeError)}`)
    })
    throw error
  }
  // The caller owns the handle; the fiber disposer closes it.
  ctx.effect(() => () => domain.close(), 'requirement-board: domain')

  const service = new RequirementService({
    domain,
    config: resolved,
    ports: {
      // Resolvers, not instances: the agent registry and the preset registry are
      // optional services, and another plugin may mount either of them after
      // this one. Reading them per call follows the live composition.
      agents: () => ctx.get('agents'),
      presets: () => ctx.get('agentPresets'),
      jobs: () => ctx.get('jobs'),
      // The platform's ownership predicate in the board's own id-shaped terms.
      owns: createOwnershipPort(ctx),
    },
    logger: ctx.logger,
  })
  ctx.logger?.info?.(`requirement-board: domain ${requirementBoardDomain.name} v${requirementBoardDomain.version} open`)

  ctx.on('domain/changed', change => {
    forwardDomainChange(change, service)
  })

  ctx.on('agent/created', payload => {
    const agent = payload?.agent
    try {
      // One statement: start the registration and route an asynchronous
      // rejection to the same named handler. The returned promise resolves
      // either way, so the awaited `agent/created` chain cannot fail on it.
      return service.establishRole(agent).catch(error => {
        warnRoleRegistration(ctx.logger, agent, error)
      })
    } catch (error) {
      warnRoleRegistration(ctx.logger, agent, error)
      return undefined
    }
  })

  ctx.on('agent/disposed', payload => {
    // Disposal is serial and awaited by the host, so the settling promise is
    // returned and its failure is reported here rather than escaping into
    // another agent's teardown.
    return service.disposeSession(payload?.agent).catch(error => {
      ctx.logger?.warn?.(`requirement-board: settling the state of a disposed session failed: ${String(error)}`)
      return undefined
    })
  })

  const swept = await service.sweepDangling()
  ctx.logger?.info?.([
    `requirement-board: startup sweep removed ${swept.removedRoles.length} orphan temporary role(s) and ${swept.removedQueueItems.length} dangling queue item(s)`,
    `unbound ${swept.unboundLinks.length} dangling gate link(s)`,
    `settled ${swept.settledDelegations.length} dangling delegation(s)`,
    ...(swept.deferred.length === 0
      ? []
      : [`${swept.deferred.length} reference class(es) are not checked yet (${swept.deferred.map(entry => entry.reference).join(', ')})`]),
  ].join('; '))

  // Execution sync (§4.2, §5.5). Two producers feed one writer: the subagent
  // lifecycle edges and the background-job registry's stream. Both are effects,
  // so an HMR replacement removes the old listeners with its fiber, and both
  // contain their own failures — an observation is not worth failing a step over.
  if (resolved.executionSync) {
    service.assertExecutionPorts()
    ctx.on('subagent/start', info => {
      return service.observeSubagent(info, 'start').catch(error => {
        warnExecutionSync(ctx.logger, 'subagent/start', error)
        return undefined
      })
    })
    ctx.on('subagent/end', info => {
      return service.observeSubagent(info, 'end').catch(error => {
        warnExecutionSync(ctx.logger, 'subagent/end', error)
        return undefined
      })
    })
    ctx.inject(['jobs'], jobsCtx => {
      jobsCtx.effect(() => {
        const jobs = ctx.get('jobs')
        if (jobs === undefined || typeof jobs.events?.subscribe !== 'function') return () => {}
        // No kind whitelist: every producer registers through the one registry, and
        // a job kind this plugin has never heard of is still work the locked
        // requirement is running.
        return jobs.events.subscribe({ owners: 'all' }, event => {
          service.observeJobEvent(event).catch(error => {
            warnExecutionSync(ctx.logger, `job ${String(event?.type)}`, error)
          })
        })
      }, 'requirement-board: execution sync')
    })
  }

  // §5.4's optional hard gate. It is registered only when switched on, and it
  // delegates every call it allows: a waterfall listener that returns without
  // `next()` short-circuits the rest of the chain.
  if (resolved.requireLockForExecution) {
    ctx.on('tools/pre-execute', (exec, next) => {
      const decision = executionGateDecision({
        name: exec?.name,
        session: typeof exec?.agent?.id === 'string' ? exec.agent.id : '',
        holdsLock: service.lockHeldBy(typeof exec?.agent?.id === 'string' ? exec.agent.id : '') !== '',
      })
      if (decision !== undefined) return decision
      return next()
    })
  }

  // A pending merge window belongs to this service alone, so it ends with the
  // fiber: an HMR replacement must not publish a queued frame for a board that no
  // longer exists.
  ctx.effect(() => () => service.close(), 'requirement-board: execution sync window')

  if (resolved.promptContext) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.effect(
        () => promptCtx.systemPrompt.context({
          name: 'requirement-board',
          order: PROMPT_CONTEXT_ORDER,
          text: assembly => service.promptContext(sessionOfScope(assembly?.scope), resolved.promptMaxItems),
        }),
        'requirement-board: prompt context',
      )
    })
  }

  if (resolved.http) {
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(
        // The platform's request-trust judgement is preferred when the connection
        // service is mounted: it knows about credentials, which this plugin does
        // not. Without it the route keeps its own loopback Origin check.
        () => registerBoardRoute(webCtx.webServer, service, () => ctx.get('connection')),
        'requirement-board: browser route',
      )
    })
  }

  return registerTools(ctx, service)
}
