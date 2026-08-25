/**
 * Pure translation and UUID logic for the developer toolbox, independent of the
 * Remote service so it stays unit-testable without a mounted gateway.
 *
 * Translation runs through either a free public API (GET, so large texts are
 * split on URL-encoded length) or the configured model (streaming). UUID
 * generation is pure JS: v1 time-ordered via BigInt (a plain Number loses
 * precision past 2^53) plus random v4.
 * @module @deepseek-ai/dsh-host-toolbox/engine
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WebFetchProvider } from '@deepseek-ai/dsh-web'

/** A provider/model selection, structurally compatible with the agent-default-model facade. */
export interface ToolboxModelSelection {
  provider: string
  model: string
}

/** The free translation endpoint (Google's gtx single-shot). */
const TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
/** Absolute URL budget: the local fetch provider caps URLs at 2048. */
const URL_BUDGET = 1950
/** Per-request encoded-query budget for one translation split. */
const Q_BUDGET = 1800

/** Language codes to human-readable target names for the model prompt. */
const TARGET_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
  es: '西班牙文',
  ru: '俄文',
  pt: '葡萄牙文',
  it: '意大利文',
  ar: '阿拉伯文',
}

/**
 * Translate one text through the free API, splitting on URL-encoded length so a
 * Chinese-heavy passage (each glyph occupies 9 encoded characters) stays inside
 * the fetch provider's URL budget.
 * @param text - the source text.
 * @param source - source language code.
 * @param target - target language code.
 * @param web - the fetch provider.
 * @returns the translated text.
 */
export async function translateFree(
  text: string,
  source: string,
  target: string,
  web: Pick<WebFetchProvider, 'fetch'>,
): Promise<string> {
  const chunks = splitChunks(text)
  const parts: string[] = []
  for (const chunk of chunks) {
    const url = TRANSLATE_ENDPOINT
      + '&sl=' + encodeURIComponent(source)
      + '&tl=' + encodeURIComponent(target)
      + '&q=' + encodeURIComponent(chunk)
    if (url.length > URL_BUDGET) throw new Error('翻译分片仍超出 URL 长度限制')
    const result = await web.fetch({ url })
    if (result.statusCode !== 200) throw new Error('翻译服务返回 HTTP ' + result.statusCode)
    const content = result.body.kind === 'text' || result.body.kind === 'html' ? result.body.content : ''
    let data: unknown
    try {
      data = JSON.parse(content)
    } catch {
      throw new Error('翻译服务响应无法解析')
    }
    const segments = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : []
    const translated = segments
      .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : ''))
      .join('')
    parts.push(translated)
  }
  return parts.join('')
}

/** Split text into URL-length-safe chunks along line boundaries, hard-splitting any oversize remainder. */
function splitChunks(text: string): string[] {
  const clean = String(text).replace(/\r\n/g, '\n')
  const encodedLen = (s: string): number => encodeURIComponent(s).length
  const units = clean.split(/(?<=\n)/)
  const chunks: string[] = []
  let buf = ''
  let bufEnc = 0
  for (const unit of units) {
    const unitEnc = encodedLen(unit)
    if (bufEnc + unitEnc > Q_BUDGET && buf.length > 0) {
      chunks.push(buf)
      buf = unit
      bufEnc = unitEnc
    } else {
      buf += unit
      bufEnc += unitEnc
    }
  }
  if (buf.length > 0) chunks.push(buf)
  const final: string[] = []
  for (const chunk of chunks) {
    if (encodedLen(chunk) <= Q_BUDGET) {
      final.push(chunk)
      continue
    }
    let cur = ''
    let curEnc = 0
    for (const char of chunk) {
      const charEnc = encodedLen(char)
      if (curEnc + charEnc > Q_BUDGET && cur.length > 0) {
        final.push(cur)
        cur = ''
        curEnc = 0
      }
      cur += char
      curEnc += charEnc
    }
    if (cur.length > 0) final.push(cur)
  }
  return final
}

/**
 * Translate one text through the configured model, streaming text deltas and
 * surfacing a failure when the stream ends in an error or aborted finish.
 * @param text - the source text.
 * @param target - target language code.
 * @param llm - the LLM runtime.
 * @param selection - the default-model selection facade.
 * @returns the translated text.
 */
export async function translateModel(
  text: string,
  target: string,
  llm: { stream(options: { provider: string; model: string; messages: Message[]; maxTokens: number }): AsyncIterable<StreamChunk> },
  selection: { currentSelection(): ToolboxModelSelection },
): Promise<string> {
  const current = selection.currentSelection()
  const prompt = '请将以下文本翻译为' + (TARGET_NAMES[target] ?? target)
    + '，只输出译文，不要任何解释或额外内容：\n\n' + text
  const messages: Message[] = [{
    id: 'toolbox-translate-' + Date.now() as Message['id'],
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-host-toolbox' },
  }]
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: current.provider,
    model: current.model,
    messages,
    maxTokens: 4096,
  })) {
    assembler.push(chunk)
  }
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    throw new Error('模型翻译失败：' + assembler.finish.failure.message)
  }
  const translated = (assembler.blocks() as ContentBlock[])
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (translated.length === 0) throw new Error('模型未返回译文')
  return translated
}

const HEX = '0123456789abcdef'

/** Generate a random hex string of the given length. */
function randomHex(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += HEX[Math.floor(Math.random() * 16)]
  return out
}

/** Generate one random (version 4) UUID. */
export function uuidV4(): string {
  const s = randomHex(32)
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-' + '8' + s.slice(17, 20) + '-' + s.slice(20)
}

/** Generate one time-ordered (version 1) UUID with a pseudo-random node. */
export function uuidV1(): string {
  const ticks = (BigInt(Date.now()) + 12219292800000n) * 10000n
  const timeLow = ticks & 0xffffffffn
  const timeMid = (ticks >> 32n) & 0xffffn
  const timeHigh = ((ticks >> 48n) & 0xfffn) | 0x1000n
  const clockSequence = BigInt(Math.floor(Math.random() * 0x4000) | 0x8000)
  const hex = (value: bigint, width: number): string => value.toString(16).padStart(width, '0')
  return hex(timeLow, 8) + '-' + hex(timeMid, 4) + '-' + hex(timeHigh, 4) + '-' + hex(clockSequence, 4) + '-' + randomHex(12)
}
