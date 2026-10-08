/**
 * Assertion cases for the requirement-board REAL-composition channel.
 *
 * One list, two consumers: `tests/loader.mjs` runs every scenario through the
 * Loader and is the authority, while `driver.mjs` prints the cases for its own
 * scenario so the driver stays directly runnable. Keeping the cases here is what
 * stops the two views from drifting apart.
 *
 * Two independent gates:
 * - Storage-open failure visibility (`LEAD-DECISIONS.md` D11) is stage-0
 *   behaviour, so its cases are hard.
 * - Store-failure containment during 建档 (`ROLE-DISPATCH.md` §10) is stage-A1
 *   work; A1 has landed, so the flag below is `true` and those cases are hard
 *   too. It stays a separate flag so a future rollback of that stage has one
 *   switch and does not disturb D11.
 */

import { join } from 'node:path'
import { PROBE_MESSAGE } from './throwing-agent-listener.mjs'

/**
 * Whether 建档 store-failure containment has landed (`ROLE-DISPATCH.md` §10,
 * stage A1). Stage A1 landed on 2026-10-04, so the two containment cases below
 * are hard assertions; the independent verification of that claim lives in
 * `tests/verification/A1-verification.md`.
 */
export const A1_STORE_CONTAINMENT_LANDED = true

/** Compact description of the recorded logger and stderr records. */
function warnSummary(report) {
  return JSON.stringify({ logger: report.loggerRecords, stderr: report.stderrChunks })
}

/** Read the observation-facing names out of a recorded tool list. */
function toolNames(report) {
  return Array.isArray(report.toolNames) ? report.toolNames : []
}

/** Whether a `safely` observation recorded a failure instead of a value. */
function didFail(value) {
  return typeof value === 'object' && value !== null && value.failed === true
}

/** Find one role row in the recorded `requirement_role{list}` result. */
function roleItem(report, id) {
  const items = report.roleList?.value?.items
  return Array.isArray(items) ? items.find(item => item.id === id) : undefined
}

/** Find one recorded Loader entry by id. */
function entryOf(report, id) {
  return report.entries.find(entry => entry.id === id)
}

/**
 * Evaluate one recorded report into its assertion cases.
 *
 * A case is `{ label, ok, detail, pending }`: `pending` cases are evidence
 * recorded now and assertions once {@link A1_STORE_CONTAINMENT_LANDED} is true.
 * @param report - the driver's recorded observations.
 * @returns the cases for the report's scenario, in report order.
 */
export function evaluateCases(report) {
  const names = toolNames(report)
  const entry = entryOf(report, 'requirement-board')
  const cases = []
  const hard = (label, ok, detail = '') => cases.push({ label, ok, detail, pending: false })
  const afterA1 = (label, ok, detail = '') => cases.push({ label, ok, detail, pending: true })

  switch (report.scenario) {
    case 'happy':
      hard('boot resolved without error', report.bootError === null, report.bootError ?? '')
      hard('the board mount settled within the deadline', report.mount?.mounted === true, JSON.stringify(report.mount))
      hard('the requirement-board entry activated through the Loader', entry?.state === 'active', JSON.stringify(entry))
      hard('the real tool registry assembled requirement_board', names.includes('requirement_board'), JSON.stringify(report.toolNames))
      hard('the real tool registry assembled flow_template', names.includes('flow_template'), JSON.stringify(report.toolNames))
      hard(
        'the board tool created a requirement without a tool error',
        report.toolCreate?.isError === false,
        JSON.stringify(report.toolCreate),
      )
      hard(
        'the rendered tool result names the new requirement',
        typeof report.toolCreate?.text === 'string' && report.toolCreate.text.includes('组合测试需求'),
        JSON.stringify(report.toolCreate?.text ?? report.toolCreate),
      )
      hard(
        'the document was committed to the composition storage root',
        typeof report.document?.text === 'string'
          && report.document.path === join(report.storageRoot, 'requirement_board.json')
          && report.document.text.includes('组合测试需求'),
        JSON.stringify(report.document?.path ?? report.document),
      )
      hard(
        'the requirement_board domain opened through the real storage stack',
        report.domainOpen === true && JSON.stringify(report.storageBackends) === JSON.stringify(['json']),
        JSON.stringify({ domainOpen: report.domainOpen, backends: report.storageBackends }),
      )
      hard('the prompt context provider was evaluated', report.promptContext?.name === 'requirement-board', JSON.stringify(report.promptContext))
      hard(
        'the prompt context carries the live board',
        typeof report.promptContext?.text === 'string'
          && report.promptContext.text.includes('<requirement-board>')
          && report.promptContext.text.includes('组合测试需求'),
        JSON.stringify(report.promptContext?.text ?? report.promptContext),
      )
      hard(
        'the browser route registered as the board prefix route',
        JSON.stringify(report.webServerRegistrations)
          === JSON.stringify([{ kind: 'prefix', path: '/api/requirement-board', hasHandler: true }]),
        JSON.stringify(report.webServerRegistrations),
      )
      hard(
        'disposing the tree unregistered both tools',
        JSON.stringify(report.afterDispose.toolNames) === JSON.stringify([]),
        JSON.stringify(report.afterDispose.toolNames),
      )
      hard(
        'disposing the tree removed the route registration',
        JSON.stringify(report.afterDispose.webServerRegistrations) === JSON.stringify([]),
        JSON.stringify(report.afterDispose.webServerRegistrations),
      )
      hard('the healthy composition logged no warn or error', warnSummary(report) === JSON.stringify({ logger: [], stderr: [] }), warnSummary(report))
      hard('the logger capture path observes a warn', report.loggerCapture === true, JSON.stringify({ loggerCapture: report.loggerCapture }))
      break

    case 'throwing-store':
      hard('boot resolved without error despite the failing write path', report.bootError === null, report.bootError ?? '')
      hard('the board mount settled within the deadline', report.mount?.mounted === true, JSON.stringify(report.mount))
      hard('the board entry still activated', entry?.state === 'active', JSON.stringify(entry))
      hard('the real tool registry still assembled requirement_board', names.includes('requirement_board'), JSON.stringify(report.toolNames))
      // The fault must be real, or the containment cases below are vacuous.
      hard('the injected write fault reached the medium', report.faultInjection === 'applied', JSON.stringify(report.faultInjection))
      hard('the injected store failure reaches the tool as an error', report.toolCreate?.isError === true, JSON.stringify(report.toolCreate))
      hard(
        'the store error names the unit whose write failed',
        typeof report.toolCreate?.text === 'string' && report.toolCreate.text.includes('requirement_board.json'),
        JSON.stringify(report.toolCreate?.text ?? report.toolCreate),
      )
      hard(
        'nothing warned before the agent/created dispatch',
        JSON.stringify(report.warnBeforeRoleDispatch) === JSON.stringify({ logger: [], stderr: [] }),
        JSON.stringify(report.warnBeforeRoleDispatch ?? { logger: report.loggerRecords, stderr: report.stderrChunks }),
      )
      hard('a local agent/created dispatch did not reject', report.serialThrew === null, report.serialThrew ?? '')
      afterA1(
        'agent creation survives a throwing 建档 store write',
        didFail(report.roleDispatch?.art) === false
          && report.serialThrew === null
          && (Array.isArray(report.toolNamesAfterSerial) && report.toolNamesAfterSerial.includes('requirement_board')),
        JSON.stringify({ roleDispatch: report.roleDispatch, serialThrew: report.serialThrew, tools: report.toolNamesAfterSerial }),
      )
      afterA1(
        'the contained 建档 failure logged exactly one requirement-board warn naming the session it ignored',
        report.loggerRecords.length === 1
          && report.loggerRecords[0].type === 'warn'
          && report.loggerRecords[0].text.includes('requirement-board: registering the role of session "sess-art" failed and was ignored so the session is still created'),
        warnSummary(report),
      )
      break

    case 'broken-storage':
      hard('boot resolved without error despite the unopenable medium', report.bootError === null, report.bootError ?? '')
      // D11, hard since stage 0: activation awaits the domain open, so a rejected
      // `apply` marks the entry FAILED and the Loader names the reason. The
      // failure must NOT be the silent shape stage 0 removed — an `active` entry
      // with an empty tool table — and must not degrade into "waiting for a
      // service", which would mean the failure never reached `open`.
      hard(
        'the medium failure fails the entry instead of leaving it active',
        entry?.state === 'failed' && report.mount?.mounted === false,
        JSON.stringify({ entry, mount: report.mount }),
      )
      hard(
        'the failure is reported as a settled failure, not a silent wait',
        report.mount?.entryFailed === true && report.mount?.timedOut === false,
        JSON.stringify(report.mount),
      )
      hard(
        'the entry failure carries the storage error and no half-open domain',
        typeof entry?.error === 'string'
          && entry.error.includes(report.storageRoot)
          && report.domainOpen === false,
        JSON.stringify({ error: entry?.error, domainOpen: report.domainOpen }),
      )
      hard(
        'the Loader reports the activation failure with its detail',
        report.stderrChunks.join('').includes('1 entry did not activate')
          && report.stderrChunks.join('').includes('requirement-board (../../index.js):'),
        JSON.stringify(report.stderrChunks),
      )
      hard(
        'the failed activation registered nothing',
        names.includes('requirement_board') === false
          && JSON.stringify(report.webServerRegistrations) === JSON.stringify([]),
        JSON.stringify({ toolNames: report.toolNames, routes: report.webServerRegistrations }),
      )
      break

    case 'role-resolution': {
      const art = roleItem(report, 'art')
      const standard = roleItem(report, 'standard')
      const unregistered = Array.isArray(report.roleList?.value?.unregistered) ? report.roleList.value.unregistered : []
      const ghost = unregistered.find(entry => entry.id === 'ghost-preset')
      const params = report.roleToolSchema?.parameters

      hard('boot resolved without error', report.bootError === null, report.bootError ?? '')
      hard('the board mount settled within the deadline', report.mount?.mounted === true, JSON.stringify(report.mount))
      hard('the requirement-board entry activated through the Loader', entry?.state === 'active', JSON.stringify(entry))
      hard('the model-facing role tool is registered', names.includes('requirement_role'), JSON.stringify(report.toolNames))

      // Declared preset: the real `role.js` row published into the preset realm,
      // read back through the stub registry's `serviceFor`.
      hard(
        'the declared preset role was established through the registration chain',
        didFail(report.roleDispatch?.art) === false
          && art?.source === 'preset'
          && art?.dutiesMissing === false
          && Array.isArray(art?.duties) && art.duties.length === 2,
        JSON.stringify({ dispatch: report.roleDispatch?.art, art }),
      )
      hard(
        'the preset realm hides the declaration from the root realm',
        report.roleRealmVisibleAtRoot === false,
        JSON.stringify({ visibleAtRoot: report.roleRealmVisibleAtRoot }),
      )
      hard(
        'the real prompt assembly names the declared role and its duties',
        typeof report.rolePrompt?.art === 'string'
          && report.rolePrompt.art.includes('You are role "art" (Art Director)')
          && report.rolePrompt.art.includes('美术与音频资产规范'),
        JSON.stringify(report.rolePrompt?.art),
      )

      // Undeclared preset: the preset id is the fallback role, and the empty duty
      // list is reported instead of invented.
      hard(
        'an undeclared preset falls back to its preset id with no duties',
        didFail(report.roleDispatch?.standard) === false
          && standard?.source === 'observed'
          && standard?.dutiesMissing === true
          && typeof report.rolePrompt?.standard === 'string'
          && report.rolePrompt.standard.includes('You are role "standard" (standard)')
          && report.rolePrompt.standard.includes('no duties recorded'),
        JSON.stringify({ standard, prompt: report.rolePrompt?.standard }),
      )

      // An id in use by a live session with no stored record.
      hard(
        'a role id in use but unrecorded is reported as unregistered',
        ghost !== undefined
          && ghost.dutiesMissing === true
          && ghost.holders?.online === 1
          && roleItem(report, 'ghost-preset') === undefined,
        JSON.stringify({ unregistered, items: report.roleList?.value?.items }),
      )

      hard(
        'an identical second establishment writes nothing',
        report.roleFrames?.first > 0 && report.roleFrames?.repeat === 0,
        JSON.stringify(report.roleFrames),
      )
      hard(
        'the global assembly carries no role line',
        report.rolePrompt?.global === null
          || (typeof report.rolePrompt?.global === 'string' && report.rolePrompt.global.includes('You are role') === false),
        JSON.stringify(report.rolePrompt?.global),
      )

      // The model-facing surface, read from the real tool table rather than from
      // the author's assertions.
      hard(
        'the role tool schema exposes only list',
        params?.properties !== undefined
          && JSON.stringify(Object.keys(params.properties)) === JSON.stringify(['action'])
          && JSON.stringify(params.properties.action.enum) === JSON.stringify(['list'])
          && params.additionalProperties === false,
        JSON.stringify(report.roleToolSchema),
      )
      hard(
        'the model cannot manage roles through the tool',
        didFail(report.roleBadAction) === true
          ? String(report.roleBadAction.error).includes('put')
          : String(report.roleBadAction?.text ?? '').includes('unknown action'),
        JSON.stringify(report.roleBadAction),
      )
      hard('the healthy role composition logged no warn or error', warnSummary(report) === JSON.stringify({ logger: [], stderr: [] }), warnSummary(report))
      break
    }

    case 'uncontained-listener':
      // Control: an escaping listener error MUST reject the serial dispatch. If
      // this ever passes as contained, the pending cases above prove nothing.
      hard(
        'an uncontained agent/created listener rejects the dispatch',
        typeof report.serialThrew === 'string' && report.serialThrew.includes(PROBE_MESSAGE),
        report.serialThrew ?? 'null',
      )
      hard(
        'the rejecting listener left the board tool registered',
        Array.isArray(report.toolNamesAfterSerial) && report.toolNamesAfterSerial.includes('requirement_board'),
        JSON.stringify(report.toolNamesAfterSerial),
      )
      hard('the board entry stayed active after the rejection', entry?.state === 'active', JSON.stringify(entry))
      break

    default:
      throw new Error(`unknown composition scenario "${report.scenario}"`)
  }

  return cases
}
