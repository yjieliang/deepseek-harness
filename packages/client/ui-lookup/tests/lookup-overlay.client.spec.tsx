// @vitest-environment jsdom
// The overlay wiring: selection detection shows the action bar, the bar runs
// the lookup, Escape closes, and the model explanation flow works end to end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LookupOverlay, readSelection } from '../src/client/LookupOverlay.tsx'
import type { LookupOverlayProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const t = ((key: string) => zh[key as keyof typeof zh] ?? key) as unknown as LookupOverlayProps['t']

/** Fake DOM selection the overlay reads on mouseup. */
function fakeSelection(text: string): unknown {
  const range = {
    collapsed: false,
    getBoundingClientRect: () => ({
      top: 10, left: 20, bottom: 30, right: 200, width: 180, height: 20, x: 20, y: 10,
      toJSON: () => ({}),
    }),
    startContainer: { parentElement: { textContent: 'context around the word here' } },
  }
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  }
}

/** Scripted free-source responses; google and wikipedia return misses. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    const href = url
    if (href.includes('translate.googleapis.com')) return { ok: false, status: 404, json: async () => ({}) }
    if (href.includes('mymemory')) {
      return { ok: true, json: async () => ({ responseData: { translatedText: '接缝' } }) }
    }
    if (href.includes('dictionaryapi')) {
      return {
        ok: true,
        json: async () => ([{
          word: 'seam',
          phonetic: '/siːm/',
          meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a line where two pieces of fabric meet' }] }],
        }]),
      }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const baseProps = (): LookupOverlayProps => ({
  t,
  useSessions: () => { throw new Error('unused') },
  useWorkspaces: () => { throw new Error('unused') },
  explain: vi.fn(async () => ({
    word: 'seam',
    translation: '接缝',
    explanation: 'A seam is the line where two pieces of fabric are joined.',
  })),
})

describe('readSelection', () => {
  it('returns null for a collapsed or empty selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('  ') as Selection)
    expect(readSelection()).toBeNull()
  })

  it('reads the text, context, and rect of a real selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    expect(readSelection()).toEqual({
      text: 'seam',
      context: 'context around the word here',
      rect: { top: 10, left: 20, bottom: 30, right: 200 },
    })
  })
})

describe('LookupOverlay', () => {
  beforeEach(() => {
    stubFetch()
  })

  it('renders nothing while no selection is active', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    render(<LookupOverlay {...baseProps()} />)
    expect(document.querySelector('[data-lookup-surface]')).toBeNull()
  })

  it('shows the action bar after a selection, and Escape closes it', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...baseProps()} />)
    fireEvent.mouseUp(document.body)
    expect(screen.getByRole('button', { name: '翻译 / 名词介绍' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('[data-lookup-surface]')).toBeNull()
  })

  it('runs the lookup and renders the card anchored at the selection', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...baseProps()} />)
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    expect(await screen.findByText('接缝')).toBeTruthy()
    expect(screen.getByText('a line where two pieces of fabric meet')).toBeTruthy()
    const card = document.querySelector('[data-lookup-card]') as HTMLElement
    expect(card.style.left).toBe('20px')
    expect(card.style.top).toBe('38px')
  })

  it('reuses the cached result for a repeated selection without new fetches', async () => {
    const fetchMock = stubFetch()
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...baseProps()} />)
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    await screen.findByText('接缝')
    const firstCalls = fetchMock.mock.calls.length
    expect(firstCalls).toBe(4)
    // Same word again: the card returns from the cache with no new requests.
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    expect(await screen.findByText('接缝')).toBeTruthy()
    expect(fetchMock.mock.calls.length).toBe(firstCalls)
  })

  it('runs the model explanation from the card', async () => {
    const props = baseProps()
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...props} />)
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    const explain = await screen.findByRole('button', { name: '详细解释' })
    fireEvent.click(explain)
    expect(await screen.findByText('A seam is the line where two pieces of fabric are joined.')).toBeTruthy()
    expect(props.explain).toHaveBeenCalledWith('seam', 'context around the word here', expect.any(AbortSignal))
  })

  it('surfaces an explanation failure as the retry state', async () => {
    const props = baseProps()
    props.explain = vi.fn(async () => { throw new Error('boom') })
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...props} />)
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    const explain = await screen.findByRole('button', { name: '详细解释' })
    fireEvent.click(explain)
    expect(await screen.findByText('详细解释生成失败，请重试')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('a click without a selection closes an open card', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(fakeSelection('seam') as Selection)
    render(<LookupOverlay {...baseProps()} />)
    fireEvent.mouseUp(document.body)
    fireEvent.click(screen.getByRole('button', { name: '翻译 / 名词介绍' }))
    await screen.findByText('接缝')
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    fireEvent.mouseUp(document.body)
    await waitFor(() => {
      expect(document.querySelector('[data-lookup-card]')).toBeNull()
    })
  })
})
