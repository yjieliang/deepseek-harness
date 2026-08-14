import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId } from '../src/brand.ts'
import type { ContentBlock } from '../src/types.ts'
import { contentHasImage, degradeImages, IMAGE_OMITTED_PLACEHOLDER } from '../src/content.ts'

const IMAGE: ContentBlock = {
  type: 'image',
  attachment: {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
  },
}

describe('degradeImages', () => {
  it('replaces a top-level image block with the placeholder text', () => {
    expect(degradeImages([IMAGE])).toEqual([{ type: 'text', text: IMAGE_OMITTED_PLACEHOLDER }])
  })

  it('replaces images nested inside tool-result content, preserving the result envelope', () => {
    const nested: ContentBlock = {
      type: 'tool-result',
      toolCallId: CallId('call-1'),
      content: [{ type: 'text', text: 'see ' }, IMAGE],
      isError: true,
    }
    expect(degradeImages([nested])).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('call-1'),
      content: [{ type: 'text', text: 'see ' }, { type: 'text', text: IMAGE_OMITTED_PLACEHOLDER }],
      isError: true,
    }])
  })

  it('passes text and unknown declaration-merged blocks through untouched', () => {
    const text: ContentBlock = { type: 'text', text: 'plain' }
    const chart = { type: 'chart', data: 'x' } as unknown as ContentBlock
    const result = degradeImages([text, chart])
    expect(result[0]).toBe(text)
    expect(result[1]).toBe(chart)
    expect(contentHasImage(result)).toBe(false)
  })
})
