/**
 * Knowledge-base overlay panel: browse, search, read, edit, and trash the
 * library through the injected kb Remote callbacks. Rendered only while the
 * shared open state is true; every hook runs before that conditional return.
 */

import { useEffect, useState } from 'react'
import type { KbDocSummary, KbStatusFilter, KbTrashEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KbPanelProps } from './contract.ts'
import { kbMarkdown } from './markdown.ts'
import css from './KbPanel.module.css'

/** Human text for a rejected call. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One status chip; raw codes are the labels, matching the list rows. */
const STATUSES: readonly KbStatusFilter[] = ['all', 'inbox', 'filed', 'archived']

/**
 * Render the knowledge-base browse/edit overlay.
 * @param props - composed slot props.
 * @returns the overlay, or null while the panel is closed.
 */
export function KbPanel({
  list, search, get, dirs, save, create, remove, trash, restore, purge, assetUrl, toggle, useKbUi, t,
}: KbPanelProps) {
  const state = useKbUi(snapshot => snapshot)
  const [docs, setDocs] = useState<KbDocSummary[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<KbStatusFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [dirList, setDirList] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [showTrash, setShowTrash] = useState(false)
  const [trashDocs, setTrashDocs] = useState<KbTrashEntry[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDir, setNewDir] = useState('00-inbox')
  const [lastError, setLastError] = useState<string | null>(null)

  /** Reload the list for a query + status filter. */
  const loadList = (q: string, st: KbStatusFilter): void => {
    if (q.trim().length === 0) {
      void list({ status: st }).then(setDocs).catch(error => setLastError(messageOf(error)))
    } else {
      void search(q).then(setDocs).catch(error => setLastError(messageOf(error)))
    }
  }

  useEffect(() => {
    void dirs().then(setDirList).catch(() => {})
    loadList('', 'all')
  }, [])

  /** Load one document into the view pane. */
  const openDocument = (path: string): void => {
    setSelected(path)
    setEditing(false)
    void get(path).then((result) => {
      setContent(result.content)
      setMeta(result.meta)
      setBacklinks(result.backlinks)
      setDraft(result.content)
      setLastError(null)
    }).catch(error => setLastError(messageOf(error)))
  }

  /** Persist the draft and leave the editor. */
  const saveCurrent = (): void => {
    if (selected === null) return
    void save({ path: selected, content: draft }).then(() => {
      setContent(draft)
      setEditing(false)
      setLastError(null)
    }).catch(error => setLastError(messageOf(error)))
  }

  /** Leave the editor, discarding unsaved draft changes. */
  const cancelEditing = (): void => {
    setEditing(false)
    setDraft(content)
  }

  if (!state.open) return null

  /** Directory of the selected document, library-relative ('' for root docs). */
  const docDir = selected === null
    ? ''
    : selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : ''

  const shownDocs = showTrash ? trashDocs : docs
  return (
    <div className={css.overlay} onClick={toggle}>
      <div className={css.panel} onClick={event => event.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>📚 {t('panel.title')}</span>
          <input
            className={css.search}
            placeholder={t('panel.searchPlaceholder')}
            value={query}
            onChange={(event) => { setQuery(event.target.value); loadList(event.target.value, 'all') }}
          />
          {STATUSES.map(st => (
            <button
              key={st}
              type="button"
              className={status === st ? css.chipActive : css.chip}
              onClick={() => { setStatus(st); loadList(query, st) }}
            >
              {st}
            </button>
          ))}
          <button type="button" className={css.headerBtn} onClick={() => setCreateOpen(!createOpen)}>
            {t('panel.new')}
          </button>
          <button
            type="button"
            className={css.headerBtn}
            onClick={() => {
              if (!showTrash) void trash().then(setTrashDocs).catch(error => setLastError(messageOf(error)))
              setShowTrash(!showTrash)
            }}
          >
            {showTrash ? t('panel.back') : t('panel.trash')}
          </button>
          <button type="button" className={css.closeBtn} aria-label={t('panel.close')} onClick={toggle}>
            ✕
          </button>
        </div>

        {createOpen && (
          <div className={css.createBar}>
            <input
              className={css.createTitle}
              placeholder={t('panel.newTitlePlaceholder')}
              value={newTitle}
              onChange={event => setNewTitle(event.target.value)}
            />
            <select className={css.createDir} value={newDir} onChange={event => setNewDir(event.target.value)}>
              {dirList.map(dir => <option key={dir} value={dir}>{dir}</option>)}
            </select>
            <button
              type="button"
              className={css.primaryBtn}
              onClick={() => {
                if (newTitle.trim().length === 0) return
                void create({ title: newTitle.trim(), directory: newDir }).then((result) => {
                  setCreateOpen(false)
                  setNewTitle('')
                  loadList('', 'all')
                  openDocument(result.path)
                }).catch(error => setLastError(messageOf(error)))
              }}
            >
              {t('panel.create')}
            </button>
            <button type="button" className={css.ghostBtn} onClick={() => setCreateOpen(false)}>
              {t('panel.cancel')}
            </button>
          </div>
        )}

        {lastError !== null && (
          <div className={css.errorBar} role="alert">⚠ {lastError}</div>
        )}

        <div className={css.body}>
          <div className={css.list}>
            {shownDocs.length === 0
              ? <div className={css.empty}>{showTrash ? t('panel.trashEmpty') : t('panel.empty')}</div>
              : shownDocs.map(entry => (
                <div
                  key={entry.path}
                  className={!showTrash && selected === entry.path ? css.itemActive : css.item}
                  onClick={() => { if (!showTrash) openDocument(entry.path) }}
                >
                  <div className={css.itemTitle}>
                    <span>{entry.title || ('name' in entry ? entry.name : '') || entry.path}</span>
                    {showTrash && (
                      <span className={css.trashActions}>
                        <button
                          type="button"
                          className={css.primaryBtn}
                          onClick={(event) => {
                            event.stopPropagation()
                            void restore(entry.path, '00-inbox')
                              .then(() => trash())
                              .then(setTrashDocs)
                              .catch(error => setLastError(messageOf(error)))
                          }}
                        >
                          {t('panel.restore')}
                        </button>
                        <button
                          type="button"
                          className={css.ghostBtn}
                          onClick={(event) => {
                            event.stopPropagation()
                            void purge(entry.path)
                              .then(() => trash())
                              .then(setTrashDocs)
                              .catch(error => setLastError(messageOf(error)))
                          }}
                        >
                          {t('panel.purge')}
                        </button>
                      </span>
                    )}
                  </div>
                  <div className={css.itemMeta}>
                    {('status' in entry ? entry.status : 'trash')
                      + ('updated' in entry && entry.updated !== '' ? ' · ' + entry.updated : '')}
                    {'tags' in entry && entry.tags.length > 0 ? ' · ' + entry.tags.slice(0, 3).join(',') : ''}
                  </div>
                </div>
              ))}
          </div>

          <div className={css.view}>
            {showTrash
              ? <div className={css.empty}>{t('panel.trashHint')}</div>
              : selected === null
                ? <div className={css.emptyView}>{t('panel.emptyView')}</div>
                : (
                  <>
                    <div className={css.toolbar}>
                      {editing
                        ? (
                          <>
                            <button type="button" className={css.primaryBtn} onClick={saveCurrent}>
                              {t('panel.save')}
                            </button>
                            <button type="button" className={css.ghostBtn} onClick={cancelEditing}>
                              {t('panel.cancelEdit')}
                            </button>
                            <span className={css.editHint}>{t('panel.editing')}</span>
                          </>
                        )
                        : (
                          <>
                            <button type="button" className={css.primaryBtn} onClick={() => setEditing(true)}>
                              {t('panel.edit')}
                            </button>
                            <button
                              type="button"
                              className={css.ghostBtn}
                              onClick={() => {
                                void remove(selected).then(() => {
                                  setSelected(null)
                                  loadList('', 'all')
                                }).catch(error => setLastError(messageOf(error)))
                              }}
                            >
                              {t('panel.delete')}
                            </button>
                          </>
                        )}
                    </div>
                    <div className={css.metaBar}>
                      {meta !== null && typeof meta.status === 'string' ? meta.status : ''}
                      {backlinks.length > 0
                        ? '  ·  ' + t('panel.backlinks') + ': ' + backlinks.length + ' 篇'
                        : ''}
                    </div>
                    {editing
                      ? (
                        <div className={css.editor}>
                          <textarea
                            className={css.textarea}
                            value={draft}
                            onChange={event => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.ctrlKey && event.key === 's') {
                                event.preventDefault()
                                saveCurrent()
                              }
                            }}
                          />
                          <div className={css.preview}>
                            <MarkdownText text={kbMarkdown(draft, docDir, assetUrl)} />
                          </div>
                        </div>
                      )
                      : (
                        <div className={css.content}>
                          <MarkdownText text={kbMarkdown(content, docDir, assetUrl)} />
                        </div>
                      )}
                  </>
                )}
          </div>
        </div>
      </div>
    </div>
  )
}
