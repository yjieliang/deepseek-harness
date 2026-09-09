/**
 * Frozen service contract of the slash pipeline. Types only. The
 * InputTriggerService implementation publishes this face as `ctx.inputTriggers`; sources
 * see registerSource alone, the conversation wiring layer resolves its
 * per-session controller through sessionOf.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerSource, ReferenceAppearance } from '../types.ts'
import type { InputTriggerController } from './controller.ts'

/** The `ctx.inputTriggers` service face. */
export interface InputTriggerServiceContract {
  /**
   * Register one trigger source; duplicate trigger/name pairs throw.
   * @param src - source that discovers and resolves slash or reference candidates.
   * @returns effect disposer removing this source.
   */
  registerSource(src: InputTriggerSource): () => void
  /**
   * Resolve the lazy controller owned by one session scope.
   * @param actx - session-scoped Client context.
   * @returns controller that dies with that scope.
   */
  sessionOf(actx: ClientContext): InputTriggerController
}

/** One contributed reference appearance kind: the inserted value plus where its plain-text tokens appear. */
export interface ReferenceAppearanceRegistration {
  /** The inserted {@link ReferenceInsert.appearance} value this registration names. */
  readonly kind: ReferenceAppearance
  /**
   * Token prefixes following `@` whose plain-text occurrences render this
   * kind (e.g. `'code:'` for `@code:` tokens); longest prefix wins. Absent
   * for kinds that never appear as plain-text tokens.
   */
  readonly tokenPrefixes?: readonly string[]
}

/** The `ctx.referenceAppearances` service face: the contributed-kind registry behind plain-text reference scanning. */
export interface ReferenceAppearanceContract {
  /**
   * Register one appearance kind; duplicate kinds throw.
   * @param registration - the kind plus its optional token prefixes.
   * @returns effect disposer removing this registration.
   */
  register(registration: ReferenceAppearanceRegistration): () => void
  /**
   * Map the text following `@` in a plain-text reference token to its kind:
   * the first registration with a matching prefix wins, and within one
   * registration the longest prefix wins.
   * @param tokenAfterAt - the token text after the leading `@`.
   * @returns the matching kind, or undefined when no registered prefix matches.
   */
  kindForToken(tokenAfterAt: string): ReferenceAppearance | undefined
}
