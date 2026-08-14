// LookupSurface: presentational pieces of the word-lookup overlay — the
// floating action bar and the result card. Pure props in, DOM out; the
// selection wiring and fetch orchestration live in LookupOverlay.

import type { ReactNode } from 'react'
import type { LookupExplainResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LookupResult } from './dictionary.ts'
import css from './LookupSurface.module.css'

/** Viewport-space rectangle of the text selection. */
export interface SelectionRect {
  top: number
  left: number
  bottom: number
  right: number
}

/** Model-generated explanation state of the card's detail section. */
export type LlmState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: LookupExplainResult }
  | { status: 'error'; message: string }

/** Clamp an anchored floating surface into the viewport; flip above the selection when below does not fit. */
export function clampSurfacePosition(
  rect: SelectionRect,
  viewport: { width: number; height: number },
  width: number,
  height: number,
): { left: number; top: number } {
  const left = Math.max(8, Math.min(rect.left, viewport.width - width - 8))
  const below = rect.bottom + 8
  if (below + height <= viewport.height) return { left, top: below }
  return { left, top: Math.max(8, rect.top - height - 8) }
}

/** Floating action bar anchored at the selection end. */
export function LookupActionBar({ rect, busy, t, onLookup }: {
  rect: SelectionRect
  busy: boolean
  t: TranslateNS<'lookup'>
  onLookup: () => void
}): ReactNode {
  const viewport = typeof window === 'undefined'
    ? { width: 1200, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight }
  const position = clampSurfacePosition(rect, viewport, 200, 36)
  return (
    <div className={css.bar} data-lookup-surface data-lookup-bar style={{ left: position.left, top: position.top }}>
      <button type="button" className={css.barButton} onClick={onLookup} disabled={busy}>
        {t('action.lookup')}
      </button>
    </div>
  )
}

/** One definition line inside a part-of-speech group. */
function MeaningGroup({ meaning }: {
  meaning: NonNullable<LookupResult['meanings']>[number]
}): ReactNode {
  return (
    <li className={css.meaningGroup}>
      <span className={css.partOfSpeech}>{meaning.partOfSpeech}</span>
      <ol className={css.definitions}>
        {meaning.definitions.map((definition, index) => (
          <li key={index} className={css.definition}>{definition}</li>
        ))}
      </ol>
    </li>
  )
}

/** Model-generated explanation section (the mixed fallback of option C). */
function LlmSection({ llm, t, onExplain }: {
  llm: LlmState
  t: TranslateNS<'lookup'>
  onExplain: () => void
}): ReactNode {
  switch (llm.status) {
    case 'idle':
      return (
        <button type="button" className={css.explainButton} onClick={onExplain}>
          {t('card.explain')}
        </button>
      )
    case 'loading':
      return <div className={css.explainNote} role="status">{t('card.explaining')}</div>
    case 'ready': {
      const { result } = llm
      return (
        <div className={css.explainBody}>
          {result.translation !== '' && (
            <p className={css.explainLine}>
              <span className={css.explainLabel}>{t('card.translation')}</span>
              {result.translation}
            </p>
          )}
          <p className={css.explainLine}>{result.explanation}</p>
        </div>
      )
    }
    case 'error':
      return (
        <div className={css.explainNote} role="status">
          <span>{t('card.explainFailed')}</span>
          <button type="button" className={css.explainRetry} onClick={onExplain}>{t('card.explain')}</button>
          <p className={css.explainError}>{llm.message}</p>
        </div>
      )
  }
}

/** The lookup result card, anchored near the selection that opened it. */
export function LookupCard({ word, result, busy, llm, anchor, t, onClose, onExplain }: {
  word: string
  result: LookupResult | undefined
  busy: boolean
  llm: LlmState
  anchor: SelectionRect
  t: TranslateNS<'lookup'>
  onClose: () => void
  onExplain: () => void
}): ReactNode {
  const hasContent = result !== undefined
    && (result.translation !== undefined || (result.meanings?.length ?? 0) > 0 || result.intro !== undefined)
  const viewport = typeof window === 'undefined'
    ? { width: 1200, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight }
  const position = clampSurfacePosition(anchor, viewport, 360, 480)
  return (
    <div
      className={css.card}
      data-lookup-surface
      data-lookup-card
      role="dialog"
      aria-label={t('card.title')}
      style={{ left: position.left, top: position.top }}
    >
      <div className={css.cardHeader}>
        <span className={css.cardWord}>{word}</span>
        <button type="button" className={css.closeButton} onClick={onClose} aria-label={t('card.close')}>
          ✕
        </button>
      </div>
      <div className={css.cardBody}>
        {busy && <div className={css.note} role="status">{t('card.loading')}</div>}
        {!busy && result === undefined && <div className={css.note} role="status">{t('card.failed')}</div>}
        {!busy && result !== undefined && !hasContent && <div className={css.note}>{t('card.noResult')}</div>}
        {!busy && result !== undefined && hasContent && (
          <>
            {result.translation !== undefined && (
              <p className={css.facetLine}>
                <span className={css.facetLabel}>{t('card.translation')}</span>
                {result.translation}
              </p>
            )}
            {result.phonetic !== undefined && <p className={css.phonetic}>{result.phonetic}</p>}
            {(result.meanings?.length ?? 0) > 0 && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('card.meanings')}</h3>
                <ul className={css.meaningList}>
                  {result.meanings?.map((meaning, index) => (
                    <MeaningGroup key={index} meaning={meaning} />
                  ))}
                </ul>
              </section>
            )}
            {result.intro !== undefined && (
              <section className={css.section}>
                <h3 className={css.sectionTitle}>{t('card.intro')}</h3>
                <p className={css.intro}>{result.intro}</p>
                {result.introUrl !== undefined && (
                  <a className={css.sourceLink} href={result.introUrl} target="_blank" rel="noreferrer">
                    {t('card.source')}
                  </a>
                )}
              </section>
            )}
          </>
        )}
        {/* The model explanation stays reachable even when every free source
            failed — it is the quality fallback, not a fifth facet. */}
        {!busy && (
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('card.explain')}</h3>
            <LlmSection llm={llm} t={t} onExplain={onExplain} />
          </section>
        )}
        {!busy && result !== undefined && result.errors.length > 0 && (
          <p className={css.errors}>{result.errors.join(' · ')}</p>
        )}
      </div>
    </div>
  )
}
