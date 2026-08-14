// LookupOverlay: the shell.overlay occupant for word lookup. Document-level
// listeners read the current text selection; a non-empty selection shows the
// floating action bar at the selection end; the bar opens the result card.
// All state is component-local (per the four-share rule: only the component
// knows it). The model-generated explanation arrives through the injected
// `explain` callback, which closes over the caller's ctx in apply.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { defaultLookupSources, lookupWord } from './dictionary.ts'
import type { LookupResult } from './dictionary.ts'
import { LookupActionBar, LookupCard } from './LookupSurface.tsx'
import type { LlmState, SelectionRect } from './LookupSurface.tsx'
import type { LookupOverlayProps } from './contract.ts'

/** One non-empty selection: its text, a context snippet, and its viewport rect. */
export interface SelectionAnchor {
  text: string
  context: string
  rect: SelectionRect
}

/** Max characters of the surrounding element text handed to the explanation. */
const MAX_CONTEXT_CHARS = 240

/**
 * Read the current document selection.
 * @returns the selected text, a context snippet, and the selection rect, or
 * null when collapsed, empty, or zero-sized.
 */
export function readSelection(): SelectionAnchor | null {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().trim()
  if (text.length === 0) return null
  const range = selection.getRangeAt(0)
  if (range.collapsed) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const node = range.startContainer.parentElement
  const context = node === null
    ? ''
    : node.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_CHARS)
  return {
    text,
    context,
    rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
  }
}

/** Overlay state: the selection anchor (bar) and the open card. */
interface CardState {
  word: string
  context: string
  /** The selection rect that opened the card; anchors its position. */
  rect: SelectionRect
  result?: LookupResult
}

/**
 * The word-lookup overlay: bar + card anchored to text selections anywhere in
 * the app (the conversation is the primary surface).
 * @param props - root runtime share, locale seat, and the injected explain call.
 * @returns the floating surface, or nothing while no selection is active.
 */
export function LookupOverlay({ t, explain }: LookupOverlayProps): ReactNode {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  const [card, setCard] = useState<CardState | null>(null)
  const [cardBusy, setCardBusy] = useState(false)
  const [llm, setLlm] = useState<LlmState>({ status: 'idle' })
  const lookupAbort = useRef<AbortController | null>(null)
  const llmAbort = useRef<AbortController | null>(null)
  // Per-surface lookup cache: re-selecting the same word skips the free APIs
  // entirely (they rate-limit aggressively; the overlay lives for the app
  // session, so a plain component ref is the right lifetime).
  const cacheRef = useRef(new Map<string, LookupResult>())

  useEffect(() => {
    const closeAll = (): void => {
      setAnchor(null)
      setCard(null)
      setLlm({ status: 'idle' })
      lookupAbort.current?.abort()
      llmAbort.current?.abort()
    }
    const onMouseUp = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-lookup-surface]') !== null) return
      const selection = readSelection()
      if (selection === null) {
        closeAll()
        return
      }
      setAnchor(selection)
      setCard(null)
      setLlm({ status: 'idle' })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeAll()
    }
    const onScroll = (): void => {
      // The selection rect goes stale on scroll; the open card is a deliberate
      // fixed surface and survives, so only the transient bar closes.
      setAnchor(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      lookupAbort.current?.abort()
      llmAbort.current?.abort()
    }
  }, [])

  const runLookup = async (selection: SelectionAnchor): Promise<void> => {
    const key = selection.text.toLowerCase()
    const cached = cacheRef.current.get(key)
    if (cached !== undefined) {
      setAnchor(null)
      setCard({ word: selection.text, context: selection.context, rect: selection.rect, result: cached })
      setCardBusy(false)
      return
    }
    lookupAbort.current?.abort()
    const controller = new AbortController()
    lookupAbort.current = controller
    setAnchor(null)
    setCardBusy(true)
    const result = await lookupWord(selection.text, defaultLookupSources, controller.signal)
    cacheRef.current.set(key, result)
    setCard({ word: selection.text, context: selection.context, rect: selection.rect, result })
    setCardBusy(false)
  }

  const runExplain = async (word: string, context: string): Promise<void> => {
    llmAbort.current?.abort()
    const controller = new AbortController()
    llmAbort.current = controller
    setLlm({ status: 'loading' })
    try {
      const result = await explain(word, context, controller.signal)
      setLlm({ status: 'ready', result })
    } catch (error) {
      setLlm({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <>
      {anchor !== null && (
        <LookupActionBar
          rect={anchor.rect}
          busy={cardBusy}
          t={t}
          onLookup={() => { void runLookup(anchor) }}
        />
      )}
      {card !== null && (
        <LookupCard
          word={card.word}
          result={card.result}
          busy={cardBusy}
          llm={llm}
          anchor={card.rect}
          t={t}
          onClose={() => {
            setCard(null)
            setLlm({ status: 'idle' })
          }}
          onExplain={() => { void runExplain(card.word, card.context) }}
        />
      )}
    </>
  )
}
