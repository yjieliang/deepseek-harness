/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock } from './types.ts'

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/**
 * Stable model-visible text replacing one image block when the routed model
 * does not accept image input. Adapters on text-only wire routes substitute
 * this exact string instead of failing the request, so an image-bearing
 * session can switch to a text-only model; pinned verbatim by adapter tests.
 */
export const IMAGE_OMITTED_PLACEHOLDER = '[image omitted: the current model does not accept image input]'

/**
 * Replace every image block with {@link IMAGE_OMITTED_PLACEHOLDER} text,
 * walking nested tool-result content exactly like {@link contentHasImage}.
 * Unknown declaration-merged blocks pass through untouched.
 * @param content - typed model content blocks.
 * @returns the same blocks with each image degraded to placeholder text.
 */
export function degradeImages(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type === 'image') return { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER }
    if (block.type === 'tool-result') return { ...block, content: degradeImages(block.content) }
    return block
  })
}
