/**
 * Shared vocabulary for the requirement board: identifiers, closed enums,
 * boundary validation, and the one error type every operation throws.
 *
 * Validation lives here because tool arguments and HTTP bodies are the two
 * untrusted JSON boundaries this plugin reads; values crossing the in-process
 * service surface are already typed by these functions' callers.
 */

import { randomUUID } from 'node:crypto'

/**
 * Version of the persisted board data. It is the domain version declared in
 * `host/domain.js` and the literal stamped into the stored global, so the two
 * must move together.
 */
export const SCHEMA_VERSION = 2

/** Accepted requirement priorities, lowest first. */
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']

/** Requirement lifecycle states. `done` and `archived` are terminal for progress math. */
export const REQ_STATUSES = ['active', 'blocked', 'done', 'archived']

/**
 * Requirement kinds. A `decision` requirement is the human's to advance: no AI
 * session may claim, move, archive, delete, delegate, or reserve one (§5.7), and
 * the kind is fixed once the requirement exists.
 */
export const REQ_KINDS = ['task', 'decision']

/** How a node proves it is finished. */
export const COMPLETION_TYPES = ['manual', 'checklist']

/** Transition verbs accepted by `transitionRequirement`. */
export const TRANSITION_ACTIONS = ['advance', 'rollback', 'jump', 'complete', 'reopen']

/**
 * Lifecycle states of one execution unit (§4.2, §5.5).
 *
 * A protocol constant rather than a config choice: the background-job registry
 * publishes exactly these states and the subagent lifecycle is folded into them,
 * while a stored unit has to keep parsing after either side widens its own
 * vocabulary.
 */
export const EXEC_STATUSES = ['running', 'stopping', 'completed', 'killed', 'failed']

/**
 * What kind of work one execution unit observes. `subagent` is a child session
 * spawned by the owning session; `job` is a registered background job.
 */
export const EXEC_KINDS = ['subagent', 'job']

/**
 * Role id reserved for the human decision-maker. It names "a person must
 * decide", so no preset may declare it as an AI role (`human` is not a holder
 * a session can resolve to).
 */
export const HUMAN_ROLE = 'human'

/** Prefix reserved for the temporary roles task delegation mints. */
export const TMP_ROLE_PREFIX = 'tmp-'

/** Accepted role id: a lowercase start, then lowercase letters, digits, `_`, `-`. */
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** How a role record came to exist. */
export const ROLE_SOURCES = ['preset', 'manual', 'observed', 'delegated']

/** Longest accepted role display name. */
export const ROLE_NAME_MAX = 40

/** Most duties one role may declare. */
export const ROLE_DUTIES_MAX = 12

/** Longest accepted single duty. */
export const ROLE_DUTY_MAX = 40

/** Most questions one requirement's structured options may ask. */
export const OPTION_QUESTIONS_MAX = 6

/** Most choices one question may offer. */
export const OPTION_CHOICES_MAX = 8

/** Longest accepted question prompt. */
export const OPTION_PROMPT_MAX = 300

/** Longest accepted choice label. */
export const OPTION_LABEL_MAX = 80

/** Longest accepted choice detail (the cost or benefit under the label). */
export const OPTION_DETAIL_MAX = 600

/** Longest accepted choice id. */
export const OPTION_ID_MAX = 8

/** Longest accepted note a person attaches to their selection. */
export const ANSWER_NOTE_MAX = 500

/** Error carrying a stable machine code beside its message. */
export class BoardError extends Error {
  /**
   * @param code - Stable machine code, e.g. `not-found` or `conflict`.
   * @param message - Human- and model-readable explanation.
   * @param details - Optional structured context (current revision, missing checks).
   */
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.details = details
  }

  /** @returns the JSON form handed to tools and the browser route. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * Throw a {@link BoardError}.
 * @param code - Stable machine code.
 * @param message - Explanation.
 * @param details - Optional structured context.
 */
export function fail(code, message, details) {
  throw new BoardError(code, message, details)
}

/**
 * Mint a short, prefixed identifier.
 * @param prefix - Entity prefix (`req`, `tpl`, `evt`).
 * @returns the identifier.
 */
export function mintId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

/** @returns the current instant as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Read a bounded, trimmed string.
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure message.
 * @param options - `required`, `max`, `fallback`.
 * @returns the validated string.
 */
export function asString(value, field, { required = false, max = 8000, fallback = '' } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('invalid-argument', `"${field}" is required`)
    return fallback
  }
  if (typeof value !== 'string') fail('invalid-argument', `"${field}" must be a string`)
  const text = value.trim()
  if (required && text === '') fail('invalid-argument', `"${field}" must not be empty`)
  if (text.length > max) fail('invalid-argument', `"${field}" must be at most ${max} characters`)
  return text
}

/**
 * Read a value constrained to a closed enum.
 * @param value - Raw boundary value.
 * @param allowed - Accepted members.
 * @param field - Field name used in the failure message.
 * @param fallback - Value used when the field is absent.
 * @returns the validated member.
 */
export function asEnum(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) fail('invalid-argument', `"${field}" is required`)
    return fallback
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail('invalid-argument', `"${field}" must be one of ${allowed.join(', ')}`, { received: value })
  }
  return value
}

/**
 * Read a deduplicated array of bounded strings.
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure message.
 * @param options - `max` item count and `itemMax` per item.
 * @returns the validated array.
 */
export function asStringArray(value, field, { max = 100, itemMax = 400 } = {}) {
  if (value === undefined || value === null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list)) fail('invalid-argument', `"${field}" must be an array of strings`)
  if (list.length > max) fail('invalid-argument', `"${field}" must hold at most ${max} entries`)
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') fail('invalid-argument', `"${field}" must hold only strings`)
    const text = entry.trim()
    if (text.length > itemMax) fail('invalid-argument', `each "${field}" entry must be at most ${itemMax} characters`)
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * Read a boolean.
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure message.
 * @param fallback - Value used when the field is absent.
 * @returns the validated boolean.
 */
export function asBoolean(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  fail('invalid-argument', `"${field}" must be a boolean`)
}

/**
 * Read a finite number inside an inclusive range.
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure message.
 * @param fallback - Value used when the field is absent.
 * @param options - Inclusive `min` and `max`.
 * @returns the validated number.
 */
export function asNumber(value, field, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) fail('invalid-argument', `"${field}" must be a finite number`)
  if (parsed < min || parsed > max) fail('invalid-argument', `"${field}" must be between ${min} and ${max}`)
  return parsed
}

/**
 * Millisecond distance between two instants, clamped at zero.
 * @param from - Earlier ISO instant, or `null`.
 * @param to - Later ISO instant.
 * @returns elapsed milliseconds, or `null` when `from` is absent.
 */
export function elapsedMs(from, to) {
  if (from === null || from === undefined) return null
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.max(0, end - start)
}

/**
 * Read the role a requirement is routed to.
 *
 * The id must have the shape a role id can have, but it need not exist:
 * deleting a role that requirements still name leaves them `unregistered`
 * rather than rewriting them (§2.2), and `human` and the `tmp-` forms a
 * delegation mints are legal answers here even though no preset declares them.
 *
 * @param value - Raw boundary value; absent, `null`, and `''` mean "no role".
 * @param field - Field name used in the failure message.
 * @returns the role id, or `''` when the requirement names no role.
 */
export function asRoleId(value, field = 'role') {
  const text = asString(value, field, { max: 64 })
  if (text === '') return ''
  if (!ROLE_ID_RE.test(text)) {
    fail('invalid-role', `${field} "${text}" must match ${ROLE_ID_RE}`, { role: text })
  }
  return text
}

/**
 * The temporary role id task delegation mints for one requirement.
 *
 * The id derives from the task id alone, so replacing a delegation overwrites
 * the same role row rather than leaving a second role bound to the same task
 * (§3.3). It must still be a legal role id, which is checked here instead of
 * being discovered by the write that stores it.
 *
 * @param taskId - Requirement id.
 * @returns the temporary role id.
 */
export function delegatedRoleId(taskId) {
  const id = `${TMP_ROLE_PREFIX}${taskId}`
  if (!ROLE_ID_RE.test(id)) {
    fail('invalid-role', `requirement id "${taskId}" cannot name a temporary role: "${id}" must match ${ROLE_ID_RE}`, { role: id })
  }
  return id
}

/**
 * Validate one role declaration.
 *
 * This is the single gate for every boundary that names a role: a preset's
 * `board-role` row (`role.js`, where a rejection fails that row loud) and a
 * panel `put`. The reserved forms are refused here rather than at the storage
 * layer, so a declaration fails where it is written.
 *
 * @param input - Raw `{ roleId, roleName, duties }`.
 * @returns the trimmed declaration; `roleName` defaults to the role id.
 */
export function parseRoleDeclaration(input = {}) {
  const roleId = asString(input?.roleId, 'roleId', { required: true, max: 64 })
  if (!ROLE_ID_RE.test(roleId)) {
    fail('invalid-role', `roleId "${roleId}" must match ${ROLE_ID_RE}`, { roleId })
  }
  if (roleId.startsWith(TMP_ROLE_PREFIX)) {
    fail('invalid-role', `roleId "${roleId}" uses the reserved "${TMP_ROLE_PREFIX}" prefix, which only task delegation mints`, { roleId })
  }
  if (roleId === HUMAN_ROLE) {
    fail('invalid-role', `"${HUMAN_ROLE}" is reserved for the human decision-maker and cannot be declared as an AI role`, { roleId })
  }
  const roleName = asString(input?.roleName, 'roleName', { max: ROLE_NAME_MAX }) || roleId
  const duties = asStringArray(input?.duties, 'duties', { max: ROLE_DUTIES_MAX, itemMax: ROLE_DUTY_MAX })
  return { roleId, roleName, duties }
}

/** The letter a choice is labelled with when its author names no id. */
function optionLetter(index) {
  return String.fromCharCode(65 + index)
}

/**
 * Read the structured choices of one question.
 *
 * The `id`s are what an answer names, so they are unique within the question and
 * default to the letters a person reads (`A`, `B`, …). At most one choice may be
 * `recommended`: the recommendation is one author's advice, and two of them would
 * contradict each other. `detail` and `recommended` are omitted rather than stored
 * as empty when they carry nothing, so an unstored choice stays byte-identical to
 * a record written before the field existed.
 *
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure messages.
 * @returns the validated choices, in the order they were given.
 */
export function parseChoices(value, field = 'choices') {
  if (!Array.isArray(value)) fail('invalid-argument', `"${field}" must be an array of choices`)
  if (value.length < 2) fail('invalid-argument', `"${field}" must offer at least two choices`)
  if (value.length > OPTION_CHOICES_MAX) fail('invalid-argument', `"${field}" must hold at most ${OPTION_CHOICES_MAX} choices`)
  const out = []
  const seen = new Set()
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('invalid-argument', `${at} must be an object with a "label"`)
    }
    const id = asString(raw.id, `${at}.id`, { max: OPTION_ID_MAX, fallback: optionLetter(index) }) || optionLetter(index)
    if (seen.has(id)) fail('invalid-argument', `${at}.id "${id}" is already used by another choice of this question`, { id })
    seen.add(id)
    const label = asString(raw.label, `${at}.label`, { required: true, max: OPTION_LABEL_MAX })
    const detail = asString(raw.detail, `${at}.detail`, { max: OPTION_DETAIL_MAX })
    const recommended = asBoolean(raw.recommended, `${at}.recommended`, false)
    out.push({
      id,
      label,
      ...(detail === '' ? {} : { detail }),
      ...(recommended ? { recommended: true } : {}),
    })
  }
  if (out.filter(choice => choice.recommended === true).length > 1) {
    fail('invalid-argument', `"${field}" may mark at most one choice as recommended`)
  }
  return out
}

/**
 * Read the questions a requirement puts to the human.
 *
 * This is the structure a decision requirement carries instead of prose: each
 * question has an id (what an answer names), a prompt, and its choices. Question
 * ids default to `q1`, `q2`, … in the order given and must be unique, because an
 * answer is a map from them. An absent value is no questions at all, which is
 * what every requirement written before this field meant.
 *
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure messages.
 * @returns the validated questions, in the order they were given.
 */
export function parseQuestions(value, field = 'options') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('invalid-argument', `"${field}" must be an array of questions`)
  if (value.length > OPTION_QUESTIONS_MAX) fail('invalid-argument', `"${field}" must hold at most ${OPTION_QUESTIONS_MAX} questions`)
  const out = []
  const seen = new Set()
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('invalid-argument', `${at} must be an object with a "prompt" and its "choices"`)
    }
    const id = asString(raw.id, `${at}.id`, { max: 40, fallback: `q${index + 1}` }) || `q${index + 1}`
    if (seen.has(id)) fail('invalid-argument', `${at}.id "${id}" is already used by another question`, { id })
    seen.add(id)
    out.push({
      id,
      prompt: asString(raw.prompt, `${at}.prompt`, { required: true, max: OPTION_PROMPT_MAX }),
      choices: parseChoices(raw.choices, `${at}.choices`),
    })
  }
  return out
}

/**
 * Read one person's selections against the questions they answer.
 *
 * The map is partial on purpose: a decision may carry two questions and the
 * person may answer one now and the other later, so only the entries given are
 * checked and returned. Every id is resolved against the stored questions, and an
 * unknown question or choice is refused by name rather than dropped — a selection
 * that names nothing would read as an answer the record does not hold.
 *
 * @param value - Raw boundary value: a map of question id to choice id.
 * @param questions - Stored questions the selections are resolved against.
 * @param field - Field name used in the failure messages.
 * @returns the validated map, holding only the given entries.
 */
export function parseAnswers(value, questions, field = 'answer') {
  if (value === undefined || value === null) fail('invalid-argument', `"${field}" is required`)
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-argument', `"${field}" must be a map of question id to choice id`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) fail('invalid-argument', `"${field}" must name at least one question`)
  const out = {}
  for (const [questionId, choiceId] of entries) {
    const question = questions.find(candidate => candidate.id === questionId)
    if (question === undefined) {
      fail('invalid-argument', `"${field}" names question "${questionId}", which this requirement does not ask`, {
        questionId,
        questions: questions.map(candidate => candidate.id),
      })
    }
    if (typeof choiceId !== 'string' || !question.choices.some(choice => choice.id === choiceId)) {
      fail('invalid-argument', `"${field}.${questionId}" must name one of this question's choices`, {
        questionId,
        choices: question.choices.map(choice => choice.id),
      })
    }
    out[questionId] = choiceId
  }
  return out
}
