/**
 * Stage C cases: the structured question a requirement puts to a person, and the
 * selection only the person may make (`ROLE-DISPATCH.md` §5.7).
 *
 * A decision requirement used to carry its choices as prose in the description,
 * which left the answer nowhere to live: the person replied in chat and the board
 * kept nothing. These cases drive the whole path the panel uses — the tool that
 * writes the question, the command that records the selection, and the stored
 * record that outlives the process — and assert the refusals that keep an agent
 * from writing the answer itself.
 *
 * Every case runs against every backend in {@link BACKENDS}, because `options`
 * and `answer` are stored fields and have to survive a reopen. A record written
 * before these fields existed must still open and read as one asking nothing.
 */

import { dispatchBoardCommand } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { apply as applyBoardPlugin, createOwnershipPort } from '../index.js'
import {
  BACKENDS,
  createMountContext,
  createReporter,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset, name = '') {
  return { id, name, status: 'idle', ctx: { preset } }
}

/** A fake agent registry in the platform's own terms, as `AgentRegistry` is. */
function fakeAgents(agents, ownership = []) {
  return {
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
    isOwnedBy: (id, owner) => ownership.some(([child, parent]) => child === id && agents.find(agent => agent.id === parent) === owner),
  }
}

/** The preset registry fake: the composed preset id is the role id. */
function fakePresets() {
  return { composedPreset: ctx => ctx?.preset }
}

/**
 * The two questions a case asks, shaped as the board stores them.
 *
 * The second question and its third choice carry no id on purpose: the write path
 * mints `q2` and `C`, and a case that reads them back proves the default rather
 * than repeating what the fixture wrote.
 */
const QUESTIONS = [
  {
    id: 'q1',
    prompt: '美术规范里「没验证过就不许写进规范」要不要放宽？',
    choices: [
      { id: 'A', label: '一点都不放宽', detail: '最保险，地面特效的规格继续冻结。' },
      { id: 'B', label: '可以写，但注明两件事', detail: '规范能往前走，但「多贵」只能填「还不知道」。' },
      { id: 'C', label: '分开处理', detail: '便宜的三种先放开，倒影继续冻着。', recommended: true },
    ],
  },
  {
    prompt: 'GDD 里「不做传送门特效」留不留？',
    choices: [
      { id: 'A', label: '还是不做，换一个新理由', recommended: true },
      { id: 'B', label: '做最轻的光晕' },
      { label: '先不决定，维持现状' },
    ],
  },
]

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-options-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/**
 * Open a board with the plugin mounted, so one domain backs the tool, the panel
 * route, and the prompt — the same wiring the Host uses.
 * @param options - Backend, directory, and the live agents to publish.
 * @returns the open board, its registry, and the registered board tool.
 */
async function openOptionsBoard({ backend, dir, agents = [agentOf('ses_A', 'art-role', '小画家')] } = {}) {
  const registry = fakeAgents(agents)
  const board = await openBoard({
    backend,
    dir,
    ports: {
      agents: () => registry,
      presets: () => fakePresets(),
      owns: createOwnershipPort({ get: serviceName => (serviceName === 'agents' ? registry : undefined) }),
    },
  })
  const mounted = createMountContext({
    storageDomain: { open: async () => board.domain },
    get: serviceName => {
      if (serviceName === 'agents') return registry
      if (serviceName === 'agentPresets') return fakePresets()
      return undefined
    },
  })
  await applyBoardPlugin(mounted.ctx, resolveConfig({ promptMaxItems: 12 }))
  return { ...board, registry, tool: mounted.records.tools[0], mounted }
}

/** A question is stored, read back on every view, and refused when malformed. */
async function caseOptionsAreStructured(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openOptionsBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const a = { session: 'ses_A', name: '小画家' }
    const requirements = board.domain.table('requirements')

    const asked = await service.createRequirement({ summary: '测试简述', title: '要不要放宽', kind: 'decision', options: QUESTIONS }, a)
    const stored = requirements.get(asked.id)
    check('the question is stored with the requirement', stored.options?.length === 2)
    check('question ids default in order', asked.options[0].id === 'q1' && asked.options[1].id === 'q2')
    check('the prompt and the choice labels read back unchanged', asked.options[0].prompt === QUESTIONS[0].prompt && asked.options[0].choices[2].label === '分开处理')
    check('a choice id defaults to its letter', asked.options[1].choices[2].id === 'C' && asked.options[1].choices[2].label === '先不决定，维持现状')
    check('the advised choice carries its mark and no other one does',
      asked.options[0].choices.filter(choice => choice.recommended === true).length === 1
      && asked.options[0].choices[2].recommended === true)
    check('a choice with no detail stores no empty field', !('detail' in asked.options[1].choices[0]))
    check('no selection exists yet', asked.answer !== null && typeof asked.answer === 'object' && Object.keys(asked.answer).length === 0)
    check('the read-back defaults have the same meaning as an absent field', asked.answerNote === '' && asked.answeredAt === null)

    const plain = await service.createRequirement({ summary: '测试简述', title: '普通任务' }, a)
    check('a requirement asking nothing stores no question field', !('options' in requirements.get(plain.id)))
    const listed = await service.listRequirements({}, '')
    check('a list row carries how much is asked and how much is answered',
      listed.items.find(item => item.id === asked.id)?.optionsCount === 2
      && listed.items.find(item => item.id === asked.id)?.answeredCount === 0
      && listed.items.find(item => item.id === plain.id)?.optionsCount === 0)

    const viaTool = await board.tool.execute({
      action: 'create',
      title: '工具写的裁决',
      summary: '测试简述',
      kind: 'decision',
      options: QUESTIONS,
    }, { agent })
    check('the tool writes the same structure', viaTool.options?.length === 2 && viaTool.options[1].id === 'q2')

    // The panel reaches creation through `command`, not the tool: the browser half
    // sends `{ requirement: { …, options } }` and the branch hands it to the same
    // service method, so the structure has to survive that second entry point.
    const viaCommand = await dispatchBoardCommand(service, {
      action: 'create',
      requirement: { summary: '测试简述', title: '面板建的裁决', kind: 'decision', options: QUESTIONS },
      session: '',
      name: '面板',
    })
    check('the panel command carries the same structure', viaCommand.options?.length === 2 && viaCommand.options[1].choices[2].id === 'C')

    const before = requirements.size
    const malformed = [
      ['one choice', [{ prompt: '只有一个选项', choices: [{ label: 'A' }] }]],
      ['two advised choices', [{ prompt: '两个推荐', choices: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }]],
      ['a repeated question id', [{ id: 'q1', prompt: '一', choices: [{ label: 'A' }, { label: 'B' }] }, { id: 'q1', prompt: '二', choices: [{ label: 'A' }, { label: 'B' }] }]],
      ['a repeated choice id', [{ prompt: '重复选项', choices: [{ id: 'A', label: 'A' }, { id: 'A', label: 'B' }] }]],
      ['no prompt', [{ choices: [{ label: 'A' }, { label: 'B' }] }]],
      ['nine choices', [{ prompt: '太多', choices: Array.from({ length: 9 }, (_, index) => ({ label: `选项${index}` })) }]],
      ['a value that is not a list', '问一句'],
    ]
    for (const [label, options] of malformed) {
      await reporter.rejects(`a question with ${label} is refused`, () => service.createRequirement({ summary: '测试简述', title: label, options }, a), 'invalid-argument')
    }
    check('every refused question wrote nothing', requirements.size === before)
    await board.close()
  })
}

/** Writing the selection is the person's act, through the panel's command alone. */
async function caseSelectionIsTheHumansOnly(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openOptionsBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const panel = { session: '', name: '面板' }
    const question = await service.createRequirement({ summary: '测试简述', title: '谁来选', kind: 'decision', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })
    const before = board.domain.table('requirements').get(question.id)

    const viaCommand = await reporter.rejects('an agent\'s command cannot select', () => dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q1: 'C' }, session: 'ses_A', name: '小画家' }), 'forbidden')
    check('the refusal names the human-only rule', viaCommand.details?.reason === 'human-only')
    const viaService = await reporter.rejects('the service refuses a session the same way', () => service.decideRequirement(question.id, { answer: { q1: 'C' } }, { session: 'ses_A', name: '小画家' }), 'forbidden')
    check('and the service names the same reason', viaService.details?.reason === 'human-only')

    const viaTool = await board.tool.execute({ action: 'decide', id: question.id, answer: { q1: 'C' } }, { agent })
    check('the tool has no decide action at all', typeof viaTool?.error === 'string' && viaTool.error.includes('unknown action'))

    const viaUpdate = await reporter.rejects('the answer is not a field an update may carry', () => service.updateRequirement(question.id, { answer: { q1: 'C' } }, panel), 'invalid-argument')
    check('the update refusal lists the supported fields and not the answer',
      Array.isArray(viaUpdate.details?.supported)
      && viaUpdate.details.supported.includes('options')
      && !viaUpdate.details.supported.includes('answer'))
    // The tool's schema declares no `answer`, and the executor drops an undeclared
    // argument rather than failing: the guard is that nothing was written.
    const dropped = await board.tool.execute({ action: 'update', id: question.id, answer: { q1: 'A' } }, { agent })
    check('an answer sent to the tool is dropped by name, not applied', Object.keys(board.domain.table('requirements').get(question.id).answer ?? {}).length === 0 && dropped.id === question.id)

    const without = await service.createRequirement({ summary: '测试简述', title: '没有选项' }, { session: 'ses_A', name: '小画家' })
    const noQuestion = await reporter.rejects('a requirement asking nothing cannot be answered', () => dispatchBoardCommand(service, { action: 'decide', id: without.id, answer: { q1: 'A' } }), 'invalid-argument')
    check('that refusal says there is nothing to select', noQuestion.details?.reason === 'no-options')

    const unknownQuestion = await reporter.rejects('a selection for a question that was never asked is refused', () => dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q9: 'A' } }), 'invalid-argument')
    check('the refusal names the question and the ones that exist', unknownQuestion.details?.questionId === 'q9' && unknownQuestion.details?.questions?.join(',') === 'q1,q2')
    const unknownChoice = await reporter.rejects('a selection naming no choice is refused', () => dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q1: 'Z' } }), 'invalid-argument')
    check('the refusal names the choices that exist', unknownChoice.details?.choices?.join(',') === 'A,B,C')
    await reporter.rejects('an empty selection is refused', () => dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: {} }), 'invalid-argument')

    const after = board.domain.table('requirements').get(question.id)
    check('no refused selection wrote the record', after.rev === before.rev && Object.keys(after.answer ?? {}).length === 0)

    // The panel sends the revision it rendered: a second tab holding an older
    // reading must not overwrite a selection made after it.
    const stale = await reporter.rejects('a selection against a stale revision is refused', () => dispatchBoardCommand(service, {
      action: 'decide',
      id: question.id,
      answer: { q1: 'A' },
      expectedRev: question.rev - 1,
    }), 'conflict')
    check('the refusal carries the revision it expected and the one stored',
      stale.details?.expected === question.rev - 1 && stale.details?.current === after.rev)
    await board.close()
  })
}

/** A recorded selection is stored, noted in history, and closes a decision. */
async function caseSelectionIsRecordedAndCloses(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openOptionsBoard({ backend, dir })
    const service = board.service
    const question = await service.createRequirement({ summary: '测试简述', title: '两条一起问', kind: 'decision', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })

    const partial = await dispatchBoardCommand(service, {
      action: 'decide',
      id: question.id,
      answer: { q1: 'C' },
      note: '先放开便宜的三种',
      expectedRev: question.rev,
    })
    check('one answer of two is stored', partial.answer?.q1 === 'C' && Object.keys(partial.answer).length === 1)
    check('a partly answered decision is still waiting', partial.status === 'active' && partial.kind === 'decision')
    check('the person\'s sentence is stored beside it', partial.answerNote === '先放开便宜的三种')
    check('the selection is stamped with when it was made', typeof partial.answeredAt === 'string' && partial.answeredAt.includes('T'))
    check('one history entry names the choice the person made', partial.lastTransition?.action === 'decide'
      && partial.lastTransition.note.includes('q1 = C (分开处理)')
      && partial.lastTransition.note.includes('先放开便宜的三种'))
    check('the board still counts it as a waiting decision', service.stats().decisions === 1)

    const closed = await dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q2: 'A' } })
    check('answering the last question stores both selections', closed.answer?.q1 === 'C' && closed.answer?.q2 === 'A')
    check('and the decision is finished', closed.status === 'done' && closed.lastTransition?.action === 'complete')
    check('the finished decision leaves the waiting count', service.stats().decisions === 0)
    check('the stored record carries the selection, not just the view',
      Object.keys(board.domain.table('requirements').get(question.id).answer ?? {}).sort().join(',') === 'q1,q2')
    const listed = service.listRequirements({ kind: 'decision' }, '')
    check('a list row counts the answers', listed.items.find(item => item.id === question.id)?.answeredCount === 2)

    // An ordinary requirement may carry the same question; answering it is context
    // for its work, so it keeps working.
    const task = await service.createRequirement({ summary: '测试简述', title: '带选项的任务', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })
    const answeredTask = await dispatchBoardCommand(service, { action: 'decide', id: task.id, answer: { q1: 'A', q2: 'B' } })
    check('a task keeps working after its question is answered', answeredTask.status === 'active' && answeredTask.answer?.q1 === 'A')

    // A settled record takes a corrected selection the way it takes any other
    // update: the person may change their mind, the history says so, and the
    // decision stays settled — only an active decision ends itself.
    const corrected = await dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q1: 'A' }, note: '改主意了' })
    check('a settled decision accepts a corrected selection', corrected.answer?.q1 === 'A' && corrected.answer?.q2 === 'A' && corrected.status === 'done')
    check('the correction leaves its own history entry naming the new choice',
      corrected.lastTransition?.action === 'decide'
      && corrected.lastTransition.note.includes('q1 = A (一点都不放宽)')
      && corrected.lastTransition.note.includes('改主意了'))
    await board.close()
  })
}

/** A question an agent may sharpen stops being rewritable once the person answers. */
async function caseAnsweredQuestionIsFrozen(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openOptionsBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const question = await service.createRequirement({ summary: '测试简述', title: '可改题面', kind: 'decision', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })

    const sharpened = await board.tool.execute({
      action: 'update',
      id: question.id,
      options: [{ id: 'q1', prompt: '换个更清楚的说法？', choices: QUESTIONS[0].choices }],
    }, { agent })
    check('an agent may sharpen the question before anyone answers', sharpened.options?.[0].prompt === '换个更清楚的说法？' && sharpened.options.length === 1)
    const settled = await dispatchBoardCommand(service, { action: 'decide', id: question.id, answer: { q1: 'B' } })
    check('the person answers the sharpened question', settled.answer?.q1 === 'B')

    const before = board.domain.table('requirements').get(question.id)
    const frozen = await reporter.rejects('the question cannot be rewritten under a selection', () => board.tool.execute({
      action: 'update',
      id: question.id,
      options: QUESTIONS,
    }, { agent }), 'conflict')
    check('the refusal names the answered-options rule and the selection it protects', frozen.details?.reason === 'answered-options' && frozen.details?.answer?.q1 === 'B')
    const unchanged = board.domain.table('requirements').get(question.id)
    check('the refused rewrite left the record untouched', unchanged.rev === before.rev && unchanged.options[0].prompt === '换个更清楚的说法？')

    const restated = await board.tool.execute({ action: 'update', id: question.id, options: sharpened.options }, { agent })
    check('restating the stored question is not a change at all', restated.rev === before.rev && restated.options[0].prompt === '换个更清楚的说法？')
    await board.close()
  })
}

/** A record written before options existed still opens and reads as asking nothing. */
async function caseOptionsAreAdditive(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openOptionsBoard({ backend, dir })
    const service = board.service
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    const legacy = await service.createRequirement({ summary: '测试简述', title: '旧记录', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })
    await dispatchBoardCommand(service, { action: 'decide', id: legacy.id, answer: { q1: 'A' } })

    // A record written by a build that never knew the fields: the write path does
    // not validate, so dropping the keys here is exactly what the old build stored.
    await requirements.update(legacy.id, record => {
      const { options, answer, answerNote, answeredAt, ...older } = record
      return older
    })
    const read = await service.getRequirement(legacy.id)
    check('a record without the fields reads as asking nothing and holding no selection',
      Array.isArray(read.options) && read.options.length === 0
      && read.answer !== null && Object.keys(read.answer).length === 0
      && read.answerNote === '' && read.answeredAt === null)
    const listed = await service.listRequirements({}, '')
    check('and its list row counts nothing', listed.items.find(item => item.id === legacy.id)?.optionsCount === 0)
    check('it is still answerable-looking but asks nothing', (await reporter.rejects('nothing to select', () => dispatchBoardCommand(service, { action: 'decide', id: legacy.id, answer: { q1: 'A' } }), 'invalid-argument')) !== undefined)

    const kept = await service.createRequirement({ summary: '测试简述', title: '留下选项', kind: 'decision', options: QUESTIONS }, { session: 'ses_A', name: '小画家' })
    await dispatchBoardCommand(service, { action: 'decide', id: kept.id, answer: { q1: 'C' } })
    const revision = board.domain.global.revision
    await board.close()

    // The reopen is the assertion: the domain validates every stored record, so a
    // written-but-undeclared key would refuse the whole board here (§ domain open).
    const reopened = await openBoard({ backend, dir })
    const reread = reopened.service.getRequirement(kept.id)
    check('a stored selection survives a reopen', reread?.answer?.q1 === 'C' && reread.options?.[0].choices[2].id === 'C')
    check('and the reopen reads the revision the writes left stored', reopened.domain.global.revision === revision)
    check('the legacy record still opens beside it', reopened.service.getRequirement(legacy.id)?.options.length === 0)
    await reopened.close()
  })
}

for (const backend of BACKENDS) {
  await caseOptionsAreStructured(backend, 'a question is stored, read back, and refused when malformed')
  await caseSelectionIsTheHumansOnly(backend, 'only the panel may record a selection')
  await caseSelectionIsRecordedAndCloses(backend, 'a selection is stored, noted, and closes a decision')
  await caseAnsweredQuestionIsFrozen(backend, 'an answered question cannot be rewritten')
  await caseOptionsAreAdditive(backend, 'a record without options opens and reads as none')
}

process.exit(reporter.finish() ? 0 : 1)