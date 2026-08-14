/** Remote word-explanation endpoint: one model-generated translation and noun introduction. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  LookupExplainMeaning,
  LookupExplainRequest,
  LookupExplainResult,
} from './types.ts'

export type * from './types.ts'

/** Stable system instruction for the auxiliary explanation call. */
const LOOKUP_SYSTEM_PROMPT = [
  'You are a precise bilingual dictionary. Translate the given word and introduce it as a noun or term.',
  'Translate an English word to Chinese and a Chinese word to English.',
  'Write the explanation in the language of the translation: 2-4 sentences of plain prose, no Markdown, no lists.',
  'For an English word include an IPA phonetic and 1-3 part-of-speech groups with 1-2 short definitions each; a Chinese word omits both.',
  'Return ONLY a JSON object, no markdown fences, no extra text:',
  '{"translation": string, "phonetic": string (optional), "meanings": [{"partOfSpeech": string, "definitions": [string]}], "explanation": string}',
].join('\n')

/** Exact auxiliary output-token cap for one explanation. */
const MAX_OUTPUT_TOKENS = 700

/** Frame the word and its optional context as JSON so user text cannot break structural delimiters. */
function frameLookup(request: LookupExplainRequest): string {
  const context = request.context === undefined || request.context.length === 0
    ? ''
    : `\nSurrounding text of the selection: ${JSON.stringify(request.context)}`
  return `Word or phrase to explain: ${JSON.stringify(request.word)}${context}`
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('lookup-llm: explanation output reached maxTokens')
    case 'tool-calls':
      return new Error('lookup-llm: explanation model unexpectedly requested a tool')
    default:
      return new Error(`lookup-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/** Narrow the model's text to the typed explanation result, validating every field. */
export function parseExplain(text: string, word: string): LookupExplainResult {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('lookup-llm: model output contained no JSON object')
  }
  const raw: unknown = JSON.parse(cleaned.slice(start, end + 1))
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('lookup-llm: model output was not a JSON object')
  }
  const value = raw as Record<string, unknown>
  const translation = typeof value.translation === 'string' ? value.translation : ''
  const explanation = typeof value.explanation === 'string' ? value.explanation : ''
  if (translation.length === 0 || explanation.length === 0) {
    throw new Error('lookup-llm: model output lacked translation or explanation')
  }
  const phonetic = typeof value.phonetic === 'string' && value.phonetic.length > 0 ? value.phonetic : undefined
  const meanings: LookupExplainMeaning[] = []
  if (Array.isArray(value.meanings)) {
    for (const item of value.meanings.slice(0, 3)) {
      if (typeof item !== 'object' || item === null) continue
      const group = item as Record<string, unknown>
      const definitions = Array.isArray(group.definitions)
        ? group.definitions
          .filter((definition): definition is string => typeof definition === 'string' && definition.length > 0)
          .slice(0, 2)
        : []
      if (definitions.length === 0) continue
      meanings.push({
        partOfSpeech: typeof group.partOfSpeech === 'string' ? group.partOfSpeech : '',
        definitions,
      })
    }
  }
  return {
    word,
    translation,
    explanation,
    ...(phonetic !== undefined ? { phonetic } : {}),
    ...(meanings.length > 0 ? { meanings } : {}),
  }
}

/** Remote-only service exposing model-generated word explanations to the browser. */
export class LookupLlmGateway extends TypertRemoteService {
  static inject = ['llm', 'agentDefaultModel']

  constructor(ctx: Context) {
    super(ctx, 'lookupLlm')
  }

  /**
   * Generate one translation and noun introduction for a selected word.
   * @param request - the word and its optional surrounding context.
   * @param signal - caller cancellation; checked before, during, and after the stream.
   * @returns the model-generated explanation.
   */
  @Remote('explain')
  async explain(request: LookupExplainRequest, signal: AbortSignal): Promise<LookupExplainResult> {
    signal.throwIfAborted()
    const word = request.word.trim()
    if (word.length === 0) throw new Error('lookup-llm: word is required')
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: frameLookup({ ...request, word }) }],
      source: { kind: 'plugin', plugin: 'dsh-host-lookup-llm' },
    })]
    const options: GenerateOptions = deepFreeze({
      provider: selection.provider,
      model: selection.model,
      messages,
      system: LOOKUP_SYSTEM_PROMPT,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) throw terminalError
    const blocks = assembler.blocks()
    const text = blocks
      .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' ')
    return parseExplain(text, word)
  }
}

export default LookupLlmGateway
