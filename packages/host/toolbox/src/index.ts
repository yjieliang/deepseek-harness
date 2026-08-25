/**
 * Remote-only service exposing the developer toolbox to the browser: text
 * translation (free API + model) and UUID generation.
 *
 * The model-facing surface is deliberately absent here — this package is the
 * panel's data plane only. The translation engine lives in `toolbox.ts`.
 * @module @deepseek-ai/dsh-host-toolbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-web'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { translateFree, translateModel, uuidV1, uuidV4 } from './toolbox.ts'
import type {
  ToolboxTranslateRequest,
  ToolboxTranslateResult,
  ToolboxUuidRequest,
  ToolboxUuidResult,
} from './types.ts'

export type * from './types.ts'

/**
 * Remote-only service exposing the developer toolbox to the browser panel. One
 * host instance; translation reads the `web` (free API) and `llm` + the default
 * model (model engine) services at call time.
 */
export class ToolboxGateway extends TypertRemoteService {
  static inject = ['web', 'llm', 'agentDefaultModel']

  constructor(ctx: Context) {
    super(ctx, 'toolbox')
  }

  /**
   * Translate one text through the selected engine.
   * @param request - the text, language codes, and engine choice.
   * @param signal - caller cancellation.
   * @returns the translated text, or a folded error message.
   */
  @Remote('translate')
  async translate(request: ToolboxTranslateRequest, signal: AbortSignal): Promise<ToolboxTranslateResult> {
    signal.throwIfAborted()
    const text = String(request.text || '').trim()
    if (text.length === 0) return { text: '', error: '请输入要翻译的文本' }
    const target = String(request.target || 'zh-CN')
    const source = String(request.source || 'auto')
    try {
      const translated = request.engine === 'model'
        ? await translateModel(text, target, this.ctx.llm, this.ctx.agentDefaultModel)
        : await translateFree(text, source, target, this.ctx.web)
      return { text: translated }
    } catch (error) {
      return { text: '', error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Generate UUIDs in both v1 (time-ordered) and v4 (random) flavors.
   * @param request - the requested count, clamped to 1..100.
   * @param signal - caller cancellation.
   * @returns the generated UUIDs, or a folded error message.
   */
  @Remote('uuid')
  async uuid(request: ToolboxUuidRequest, signal: AbortSignal): Promise<ToolboxUuidResult> {
    signal.throwIfAborted()
    try {
      const count = Math.min(Math.max(Number(request.count) || 1, 1), 100)
      const v4: string[] = []
      const v1: string[] = []
      for (let i = 0; i < count; i++) {
        v4.push(uuidV4())
        v1.push(uuidV1())
      }
      return { v1, v4 }
    } catch (error) {
      return { v1: [], v4: [], error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export default ToolboxGateway
