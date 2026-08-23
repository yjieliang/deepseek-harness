// DetailsFilePreview: the in-page file surface of the right details column.
// Reads the target path from the chat store's previewFile field (path + lang
// pair, never the content) and pulls the file text through the injected
// workspaces.readFile callback into component-local state, then renders it
// through the shared ReadBlock (line numbers, syntax highlight, expand) so a
// preview matches the read-tool card exactly, or through MarkdownText when the
// reader switches to a rendered view. The rendered view is offered for text
// that reads as Markdown, and turns the file's source into parsed GFM (wiki
// links stay literal — the knowledge-base panel owns double-link navigation).
// A truncation flag shows a banner instead of silently cutting the reader's
// view; a read failure keeps the error copy and a Retry. Content never enters
// a persisted store.

import { useEffect, useMemo, useState } from 'react'
import { Button, MarkdownText, ReadBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DetailsInjected } from '../contract/slots.ts'
import css from './DetailsFilePreview.module.css'

/** Full preview props: the injected read callback plus the standard locale seat. */
export type DetailsFilePreviewProps = {
  /** Absolute host path to preview (already cwd-resolved). */
  path: string
  /** Highlighter language hint from the Host (null = plain text). */
  lang: string | null
  /** Open the path in the system default application. */
  openInSystem: (path: string) => void
} & Pick<DetailsInjected, 'readFile'> & PropsLocale<'conversation'>

/** Split a file's text into one-numbered-line rows ReadBlock can render. */
function linesOf(content: string): ReadBlockLine[] {
  const text = content.split(/\r?\n/)
  // ReadBlock appends a trailing empty line for a file that ends in a newline;
  // keep the count exact so the "N of M" window note stays honest.
  const last = text.at(-1) ?? ''
  const rows = last === '' ? text.slice(0, -1) : text
  return rows.map((row, index) => ({ number: index + 1, text: row }))
}

/** Whether a language hint reads as Markdown (the rendered view's subject). */
function isMarkdown(lang: string | null): boolean {
  return lang === 'md' || lang === 'markdown' || lang === 'mdx'
}

/** One preview: fetch, guard against stale reads, and render the file. */
export function DetailsFilePreview({ path, lang, openInSystem, readFile, t }: DetailsFilePreviewProps) {
  const [state, setState] = useState<{
    kind: 'loading' | 'ready' | 'error'
    content: string
    truncated: boolean
  }>({ kind: 'loading', content: '', truncated: false })
  // Monotonic request id: a slower earlier read must not overwrite a later
  // path's result after the panel re-targets.
  const requestRef = useMemo(() => ({ id: 0 }), [])
  // Source vs rendered view; resets to source whenever the target path changes.
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    const id = ++requestRef.id
    setState({ kind: 'loading', content: '', truncated: false })
    setRendered(false)
    readFile(path).then(
      (result) => {
        if (id !== requestRef.id) return
        setState({ kind: 'ready', content: result.content, truncated: result.truncated })
      },
      () => {
        if (id !== requestRef.id) return
        setState({ kind: 'error', content: '', truncated: false })
      },
    )
  }, [path, readFile, requestRef])

  const lines = useMemo(
    () => (state.kind === 'ready' ? linesOf(state.content) : []),
    [state.kind, state.content],
  )
  const totalLines = lines.length
  // The rendered view makes sense only for Markdown source.
  const markdown = state.kind === 'ready' && isMarkdown(lang)

  return (
    <div className={css.root}>
      {state.kind === 'loading' && <p className={css.status}>{t('filePreview.loading')}</p>}
      {state.kind === 'error' && (
        <div className={css.error}>
          <p className={css.status}>{t('filePreview.loadFailed')}</p>
          <Button variant="outline" className={css.retry} onClick={() => {
            const id = ++requestRef.id
            setState({ kind: 'loading', content: '', truncated: false })
            readFile(path).then(
              (result) => {
                if (id !== requestRef.id) return
                setState({ kind: 'ready', content: result.content, truncated: result.truncated })
              },
              () => {
                if (id !== requestRef.id) return
                setState({ kind: 'error', content: '', truncated: false })
              },
            )
          }}>
            {t('retry')}
          </Button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          {markdown && (
            <div className={css.modeBar} role="tablist" aria-label={t('filePreview.title')}>
              <button
                type="button"
                role="tab"
                aria-selected={!rendered}
                className={rendered ? css.modeTab : css.modeTabActive}
                onClick={() => { setRendered(false) }}
              >
                {t('filePreview.source')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rendered}
                className={rendered ? css.modeTabActive : css.modeTab}
                onClick={() => { setRendered(true) }}
              >
                {t('filePreview.rendered')}
              </button>
            </div>
          )}
          {rendered && markdown
            ? (
              <>
                {state.truncated && <p className={css.truncated}>{t('filePreview.truncated', { size: `${state.content.length} 字符` })}</p>}
                <MarkdownText text={state.content} />
              </>
            )
            : (
              <>
                {state.truncated && <p className={css.truncated}>{t('filePreview.truncated', { size: `${state.content.length} 字符` })}</p>}
                <ReadBlock
                  label={path}
                  lines={lines}
                  totalLines={totalLines}
                  lang={lang ?? undefined}
                  className={css.block}
                />
              </>
            )}
          <button type="button" className={css.openInSystem} onClick={() => { openInSystem(path) }}>
            {t('filePreview.openInSystem')}
          </button>
        </>
      )}
    </div>
  )
}
