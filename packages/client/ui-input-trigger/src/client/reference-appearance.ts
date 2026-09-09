/**
 * ReferenceAppearanceService (`ctx.referenceAppearances`): the registry that
 * maps contributed {@link ReferenceInsert.appearance} kinds to their
 * plain-text `@`-token prefixes. Pure data — no rendering; the glyphs for
 * contributed kinds are chain-slot occupants owned by the contributing
 * plugin, while the conversation package's built-in catalog renders the core
 * kinds. The transcript's plain-text reference scan consumes
 * {@link kindForToken}; the composer needs no lookup (occurrence appearance
 * arrives on the insert).
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ReferenceAppearance } from '../types.ts'
import type { ReferenceAppearanceContract, ReferenceAppearanceRegistration } from './contract.ts'

/** All mutable state in one holder: registration order is the lookup order. */
interface LiveState {
  /** Registrations in insertion order; `tokenPrefixes` sorted longest-first. */
  readonly entries: ReferenceAppearanceRegistration[]
}

/** The `ctx.referenceAppearances` service (root registry; per-render lookups are pure reads). */
export class ReferenceAppearanceService extends Service implements ReferenceAppearanceContract {
  private readonly live: LiveState = { entries: [] }

  /**
   * @param ctx - owning root context (the service registers itself as `referenceAppearances`).
   */
  constructor(ctx: Context) {
    super(ctx, 'referenceAppearances')
  }

  /**
   * Register one appearance kind. Duplicate kinds throw — a kind has exactly
   * one mapping owner.
   * @param registration - the kind plus its optional token prefixes.
   * @returns the disposer (callers wrap registration in ctx.effect).
   */
  register(registration: ReferenceAppearanceRegistration): () => void {
    if (this.live.entries.some(entry => entry.kind === registration.kind)) {
      throw new Error(`reference appearance "${registration.kind}" is already registered`)
    }
    const entry = {
      ...registration,
      ...(registration.tokenPrefixes === undefined
        ? {}
        : { tokenPrefixes: [...registration.tokenPrefixes].sort((a, b) => b.length - a.length) }),
    }
    this.live.entries.push(entry)
    return () => {
      const at = this.live.entries.indexOf(entry)
      if (at >= 0) this.live.entries.splice(at, 1)
    }
  }

  /**
   * Map the text following `@` in a plain-text reference token to its
   * appearance kind: the first registration (insertion order) with a matching
   * prefix wins, and within one registration the longest prefix wins.
   * Unmatched tokens are the caller's core-domain heuristic.
   * @param tokenAfterAt - the reference token text after the leading `@`.
   * @returns the matching kind, or undefined when no prefix matches.
   */
  kindForToken(tokenAfterAt: string): ReferenceAppearance | undefined {
    for (const entry of this.live.entries) {
      for (const prefix of entry.tokenPrefixes ?? []) {
        if (tokenAfterAt.startsWith(prefix)) return entry.kind
      }
    }
    return undefined
  }
}
