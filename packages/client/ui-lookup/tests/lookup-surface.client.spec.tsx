// @vitest-environment jsdom
// The floating surface pieces: the action bar and the result card. Behavior
// tests over realistic props (the wiring lives in LookupOverlay).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Loads the `lookup` LocaleNamespaceMap merge into this program.
import type {} from '../src/client/contract.ts'
import type { LookupResult } from '../src/client/dictionary.ts'
import {
  LookupActionBar,
  LookupCard,
  clampSurfacePosition,
} from '../src/client/LookupSurface.tsx'
import type { LlmState } from '../src/client/LookupSurface.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Locale seat stub over the zh dictionary, mirroring the real lookup chain. */
const t = ((key: string) => zh[key as keyof typeof zh] ?? key) as unknown as TranslateNS<'lookup'>

const RECT = { top: 10, left: 20, bottom: 30, right: 200 }

describe('clampSurfacePosition', () => {
  const viewport = { width: 1200, height: 800 }

  it('anchors below the selection and clamps into the viewport', () => {
    expect(clampSurfacePosition(RECT, viewport, 360, 480)).toEqual({ left: 20, top: 38 })
    expect(clampSurfacePosition({ ...RECT, left: 1100 }, viewport, 360, 480)).toEqual({ left: 832, top: 38 })
  })

  it('flips above the selection when below does not fit', () => {
    const nearBottom = { top: 700, left: 100, bottom: 720, right: 300 }
    expect(clampSurfacePosition(nearBottom, viewport, 360, 480)).toEqual({ left: 100, top: 212 })
  })
})

describe('LookupActionBar', () => {
  it('renders the action and fires on click', () => {
    const onLookup = vi.fn()
    render(<LookupActionBar rect={RECT} busy={false} t={t} onLookup={onLookup} />)
    const button = screen.getByRole('button', { name: '翻译 / 名词介绍' })
    fireEvent.click(button)
    expect(onLookup).toHaveBeenCalledTimes(1)
  })

  it('disables the action while a lookup is running', () => {
    render(<LookupActionBar rect={RECT} busy t={t} onLookup={() => {}} />)
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
  })
})

describe('LookupCard', () => {
  const base = (): {
    word: string
    result: undefined
    busy: boolean
    anchor: typeof RECT
    t: typeof t
    onClose: ReturnType<typeof vi.fn<() => void>>
    onExplain: ReturnType<typeof vi.fn<() => void>>
  } => ({
    word: 'seam',
    result: undefined,
    busy: false,
    anchor: RECT,
    t,
    onClose: vi.fn<() => void>(() => {}),
    onExplain: vi.fn<() => void>(() => {}),
  })

  it('anchors the card at the selection rect that opened it', () => {
    render(<LookupCard {...base()} llm={{ status: 'idle' }} />)
    const card = document.querySelector('[data-lookup-card]') as HTMLElement
    expect(card.style.left).toBe('20px')
    expect(card.style.top).toBe('38px')
  })

  it('shows the loading note while a lookup runs', () => {
    render(<LookupCard {...base()} result={undefined} busy llm={{ status: 'idle' }} />)
    expect(screen.getByRole('status').textContent).toContain('查询中…')
  })

  it('shows the failure note when a lookup produced no result object', () => {
    render(<LookupCard {...base()} result={undefined} llm={{ status: 'idle' }} />)
    expect(screen.getByRole('status').textContent).toContain('查询失败')
  })

  it('shows the empty note when the result carries no facet', () => {
    render(<LookupCard {...base()} result={{ word: 'seam', direction: 'en-zh', errors: [] }} llm={{ status: 'idle' }} />)
    expect(screen.getByText('没有找到该词的释义')).toBeTruthy()
  })

  it('renders every facet of a full result', () => {
    const result: LookupResult = {
      word: 'seam',
      direction: 'en-zh',
      translation: '接缝',
      phonetic: '/siːm/',
      meanings: [{ partOfSpeech: 'noun', definitions: ['a line where two pieces of fabric meet'] }],
      intro: 'A seam is a line where two pieces of material are joined.',
      introUrl: 'https://en.wikipedia.org/wiki/Seam',
      errors: [],
    }
    render(<LookupCard {...base()} result={result} llm={{ status: 'idle' }} />)
    expect(screen.getByText('接缝')).toBeTruthy()
    expect(screen.getByText('/siːm/')).toBeTruthy()
    expect(screen.getByText('a line where two pieces of fabric meet')).toBeTruthy()
    expect(screen.getByText('A seam is a line where two pieces of material are joined.')).toBeTruthy()
    expect(screen.getByRole('link', { name: '来源' }).getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Seam')
  })

  it('lists per-source failures', () => {
    const result: LookupResult = { word: 'seam', direction: 'en-zh', errors: ['HTTP 500', 'HTTP 404'] }
    render(<LookupCard {...base()} result={result} llm={{ status: 'idle' }} />)
    expect(screen.getByText('HTTP 500 · HTTP 404')).toBeTruthy()
  })

  it('offers the model explanation and fires it', () => {
    const props = base()
    render(<LookupCard {...props} result={undefined} llm={{ status: 'idle' }} />)
    fireEvent.click(screen.getByRole('button', { name: '详细解释' }))
    expect(props.onExplain).toHaveBeenCalledTimes(1)
  })

  it('renders the ready model explanation', () => {
    const llm: LlmState = {
      status: 'ready',
      result: { word: 'seam', translation: '接缝', explanation: 'A seam is the line where two pieces of fabric are joined.' },
    }
    render(<LookupCard {...base()} result={undefined} llm={llm} />)
    expect(screen.getByText('A seam is the line where two pieces of fabric are joined.')).toBeTruthy()
  })

  it('shows the retry path after an explanation failure', () => {
    const props = base()
    render(<LookupCard {...props} result={undefined} llm={{ status: 'error', message: 'boom' }} />)
    expect(screen.getByText('详细解释生成失败，请重试')).toBeTruthy()
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '详细解释' }))
    expect(props.onExplain).toHaveBeenCalledTimes(1)
  })

  it('closes on the header button', () => {
    const props = base()
    render(<LookupCard {...props} result={undefined} llm={{ status: 'idle' }} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
