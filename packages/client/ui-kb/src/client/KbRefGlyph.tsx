/**
 * The knowledge-base occupant of the conversation reference-glyph chain
 * slots: the data glyph beside `@kb:` chips in the composer and the
 * transcript. The selector elects only the `kb` kind, so the core
 * session/file/folder glyphs stay with the conversation package's built-in
 * catalog.
 */
import type { ReactNode } from 'react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceAppearance } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { KB_APPEARANCE } from './reference-source.ts'

/** Owner currency of the conversation reference-glyph chain slots. */
export interface ReferenceGlyphOwner {
  readonly kind: ReferenceAppearance
  readonly size?: number
  readonly className?: string | undefined
}

/**
 * Pure chain selector: this occupant elects only the `kb` kind.
 * @param owner - the dispatched glyph request.
 * @returns the owner as the matched carrier, or null to pass the turn on.
 */
export const selectKbGlyph = (owner: ReferenceGlyphOwner): ReferenceGlyphOwner | null =>
  owner.kind === KB_APPEARANCE ? owner : null

/**
 * Render the knowledge-base reference glyph.
 * @param props - glyph size and CSS class from the dispatched owner.
 * @returns The current-color data glyph.
 */
export function KbRefGlyph({ size = 16, className }: ReferenceGlyphOwner): ReactNode {
  return <IconDataOutline16 size={size} className={className} />
}
