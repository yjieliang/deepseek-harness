/**
 * Knowledge-base panel: a near-fullscreen three-column workspace over the
 * injected kb Remote callbacks. Left column navigates the library's three
 * classification axes (status, directory tree, tags) plus the trash; the
 * middle column lists documents as cards under pinned and date groups; the
 * right column reads and edits one document with an operable metadata bar and
 * a backlinks panel. Trash mode swaps the right column for a read-only
 * preview with restore/purge.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  KbDocSummary, KbStatsResult, KbStatusFilter, KbTagCount, KbTrashEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconBrowseOutline16,
  IconChevronRightOutline14,
  IconCloseFill14,
  IconCloseOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  IconTriangleRightFill14,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { KbPanelProps } from './contract.ts'
import { kbMarkdown } from './markdown.ts'
import css from './KbPanel.module.css'

/** Human text for a rejected call. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One directory-tree node; path is the library-relative directory. */
interface DirNode {
  name: string
  path: string
  children: DirNode[]
}

/** Build the directory tree from the sorted flat directory list. */
function dirTreeOf(dirs: readonly string[]): DirNode[] {
  const root: DirNode[] = []
  const byPath = new Map<string, DirNode>()
  for (const dir of dirs) {
    let parent = root
    let path = ''
    for (const part of dir.split('/')) {
      path = path === '' ? part : `${path}/${part}`
      let node = byPath.get(path)
      if (node === undefined) {
        node = { name: part, path, children: [] }
        byPath.set(path, node)
        parent.push(node)
      }
      parent = node.children
    }
  }
  return root
}

/** Date group of one `updated` ISO date, relative to today. */
function dateGroupOf(updated: string): 'today' | 'yesterday' | 'week' | 'earlier' {
  if (updated.length === 0) return 'earlier'
  const then = new Date(updated + 'T00:00:00Z').getTime()
  if (!Number.isFinite(then)) return 'earlier'
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const day = 24 * 60 * 60 * 1000
  if (then >= today) return 'today'
  if (then >= today - day) return 'yesterday'
  if (then >= today - 7 * day) return 'week'
  return 'earlier'
}

/** Directory of one document path, library-relative ('' for root docs). */
function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** Tag array of one parsed frontmatter meta record. */
function tagsOf(meta: Record<string, unknown> | null): string[] {
  const tags = meta?.['tags']
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
}

const SEARCH_DEBOUNCE_MS = 300

/**
 * Render the knowledge-base panel.
 * @param props - composed slot props.
 * @returns the panel, or null while closed.
 */
export function KbPanel({
  list, search, get, dirs, save, create, move, remove, trash, restore, purge, stats, tags,
  refresh, createDir, renameDir, assetUrl, close, useKbUi, t,
}: KbPanelProps) {
  const state = useKbUi(snapshot => snapshot)
  const [docs, setDocs] = useState<KbDocSummary[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<KbStatusFilter>('all')
  const [dir, setDir] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [searchTotal, setSearchTotal] = useState<number | null>(null)
  const [statsInfo, setStatsInfo] = useState<KbStatsResult | null>(null)
  const [dirList, setDirList] = useState<string[]>([])
  const [tagList, setTagList] = useState<KbTagCount[]>([])
  const [allTags, setAllTags] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [showTrash, setShowTrash] = useState(false)
  const [trashDocs, setTrashDocs] = useState<KbTrashEntry[]>([])
  const [trashSelected, setTrashSelected] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDir, setNewDir] = useState('00-inbox')
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [moveFor, setMoveFor] = useState<string | null>(null)
  const [dirEdit, setDirEdit] = useState<{ mode: 'create' | 'rename'; parent: string } | null>(null)
  const [dirEditValue, setDirEditValue] = useState('')
  const [lastError, setLastError] = useState<string | null>(null)
  const [purgeConfirming, setPurgeConfirming] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const tree = useMemo(() => dirTreeOf(dirList), [dirList])
  const byStatus = statsInfo?.byStatus ?? { inbox: 0, filed: 0, archived: 0 }
  const archiveDir = statsInfo?.archiveDir ?? '90-归档'

  /** Reserved top-level directories that offer no create/rename affordances. */
  const reservedRoots = useMemo(() => new Set(['00-inbox', '01-inbox', '_meta', 'templates', archiveDir]), [archiveDir])

  /** Reload the document list for the current query + filters. */
  const loadList = (q: string, st: KbStatusFilter, directory: string | null, selectedTag: string | null): void => {
    setLastError(null)
    if (q.trim().length > 0) {
      void search(q).then((result) => {
        setDocs(result.hits)
        setSearchTotal(result.total)
      }).catch((error: unknown) => { setLastError(messageOf(error)) })
      return
    }
    setSearchTotal(null)
    void list({
      ...st === 'all' ? {} : { status: st },
      ...directory === null ? {} : { directory },
      ...selectedTag === null ? {} : { tag: selectedTag },
    }).then(setDocs).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Schedule a list reload so rapid keystrokes do not flood the search RPC. */
  const scheduleSearch = (q: string, st: KbStatusFilter, directory: string | null, selectedTag: string | null): void => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      loadList(q, st, directory, selectedTag)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Reload every read surface with the current query + filters. */
  const reloadAll = (): void => {
    void dirs().then(setDirList).catch(() => {})
    void stats().then(setStatsInfo).catch(() => {})
    void tags().then(setTagList).catch(() => {})
    loadList(query, status, dir, tag)
  }

  useEffect(() => {
    reloadAll()
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current)
    }
    // Inject callbacks are stable per registration; run once per mount.
  }, [])

  /** Rebuild the engine index and reload whenever the panel opens, so external changes appear. */
  useEffect(() => {
    if (!state.open) return
    void refresh().then(reloadAll).catch((error: unknown) => { setLastError(messageOf(error)) })
    // Re-run on every open; the closure carries the latest filters.
  }, [state.open])

  /** Dismiss any open card menu or move picker on outside interaction. */
  useEffect(() => {
    const dismiss = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      if (!target.closest('[data-kb-menu]')) {
        setMenuFor(null)
        setMoveFor(null)
      }
    }
    document.addEventListener('mousedown', dismiss)
    return () => { document.removeEventListener('mousedown', dismiss) }
  }, [])

  /** Open one document into the view pane. */
  const openDocument = (path: string): void => {
    setSelected(path)
    setEditing(false)
    setTagDraft('')
    setLastError(null)
    void get(path).then((result) => {
      setContent(result.content)
      setMeta(result.meta)
      setBacklinks(result.backlinks)
      setDraft(result.content)
    }).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Persist the draft and leave the editor. */
  const saveCurrent = (): void => {
    if (selected === null) return
    void save({ path: selected, content: draft }).then(() => {
      setContent(draft)
      setEditing(false)
      loadList(query, status, dir, tag)
    }).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Move the selected document into another directory and keep the view on it. */
  const moveSelected = (targetDirectory: string): void => {
    if (selected === null) return
    void move({ path: selected, targetDirectory }).then((result) => {
      setSelected(result.to)
      setStatus('all')
      setDir(targetDirectory)
      setTag(null)
      loadList(query, 'all', targetDirectory, null)
      refreshAux()
      void get(result.to).then((r) => { setMeta(r.meta) }).catch(() => {})
    }).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Refresh the navigation-side indexes (tags, status counts) after a mutation. */
  const refreshAux = (): void => {
    void tags().then(setTagList).catch(() => {})
    void stats().then(setStatsInfo).catch(() => {})
  }

  /** Replace the selected document's tags through the field-patch save. */
  const saveTags = (next: string[]): void => {
    if (selected === null) return
    void save({ path: selected, tags: next }).then(() => {
      loadList(query, status, dir, tag)
      refreshAux()
      void get(selected).then((result) => { setMeta(result.meta) }).catch(() => {})
    }).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Delete the selected document into the trash. */
  const deleteSelected = (): void => {
    if (selected === null) return
    void remove(selected).then(() => {
      setSelected(null)
      loadList(query, status, dir, tag)
      refreshAux()
    }).catch((error: unknown) => { setLastError(messageOf(error)) })
  }

  /** Switch the list scope, clearing competing axes. */
  const pickStatus = (st: KbStatusFilter): void => {
    setStatus(st)
    setDir(null)
    setTag(null)
    loadList(query, st, null, null)
  }
  const pickDir = (path: string): void => {
    setStatus('all')
    setDir(path)
    setTag(null)
    loadList(query, 'all', path, null)
  }
  const pickTag = (name: string | null): void => {
    setStatus('all')
    setDir(null)
    setTag(name)
    loadList(query, 'all', null, name)
  }

  if (!state.open) return null

  const STATUS_LABELS: Record<'inbox' | 'filed' | 'archived', string> = {
    inbox: t('nav.inbox'),
    filed: t('nav.filed'),
    archived: t('nav.archived'),
  }
  const GROUP_LABELS: Record<'today' | 'yesterday' | 'week' | 'earlier', string> = {
    today: t('list.today'),
    yesterday: t('list.yesterday'),
    week: t('list.thisWeek'),
    earlier: t('list.earlier'),
  }

  const shownTags = allTags ? tagList : tagList.slice(0, 8)
  const filtered = query.trim().length === 0 && (status !== 'all' || dir !== null || tag !== null)
  const pinned = docs.filter(doc => doc.pinned)
  const unpinned = docs.filter(doc => !doc.pinned)
  const groups = (['today', 'yesterday', 'week', 'earlier'] as const)
    .map(group => ({ group, docs: unpinned.filter(doc => dateGroupOf(doc.updated) === group) }))
    .filter(entry => entry.docs.length > 0)

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (createOpen) {
        setCreateOpen(false)
      } else if (query.length > 0) {
        setQuery('')
        loadList('', status, dir, tag)
      } else if (editing) {
        setEditing(false)
        setDraft(content)
      } else {
        close()
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault()
      searchRef.current?.focus()
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 's' && editing) {
      event.preventDefault()
      saveCurrent()
    }
  }

  const trashEntry = showTrash ? trashDocs.find(entry => entry.path === trashSelected) ?? null : null

  return (
    <div className={css.overlay} onClick={close} onKeyDown={onKeyDown}>
      <div className={css.panel} onClick={(event) => { event.stopPropagation() }}>
        <div className={css.header}>
          <span className={css.title}>{t('panel.title')}</span>
          <div className={css.searchWrap}>
            <span className={css.searchIcon}>
              <IconSearchOutline16 size={14} />
            </span>
            <input
              ref={searchRef}
              className={css.search}
              placeholder={t('panel.searchPlaceholder')}
              value={query}
              onChange={(event) => {
                const next = event.target.value
                setQuery(next)
                scheduleSearch(next, status, dir, tag)
              }}
            />
            {searchTotal !== null && (
              <span className={css.searchTotal}>{t('search.total', { count: searchTotal })}</span>
            )}
            {query.length === 0 && (
              <span className={css.searchHint}>
                <kbd className={css.kbd}>{t('panel.searchShortcut')}</kbd>
              </span>
            )}
            {query.length > 0 && (
              <button
                type="button"
                className={css.searchClear}
                aria-label={t('panel.clearSearch')}
                onClick={() => {
                  setQuery('')
                  loadList('', status, dir, tag)
                  searchRef.current?.focus()
                }}
              >
                <IconCloseFill14 size={12} />
              </button>
            )}
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.primaryBtn} onClick={() => { setCreateOpen(!createOpen) }}>
              <IconPlusOutline16 size={14} />
              {t('panel.new')}
            </button>
            <span className={css.headerDivider} />
            <button
              type="button"
              className={css.iconBtn}
              aria-label={t('panel.refresh')}
              title={t('panel.refresh')}
              onClick={() => {
                void refresh().then(reloadAll).catch((error: unknown) => { setLastError(messageOf(error)) })
              }}
            >
              <IconRefreshOutline16 size={14} />
            </button>
            <button
              type="button"
              className={css.iconBtn}
              aria-label={t('panel.close')}
              title={t('panel.close')}
              onClick={close}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
        </div>

        {createOpen && (
          <div className={css.createBar}>
            <input
              className={css.createTitle}
              placeholder={t('create.title')}
              autoFocus
              value={newTitle}
              onChange={(event) => { setNewTitle(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newTitle.trim().length > 0) {
                  void create({ title: newTitle.trim(), directory: newDir }).then((result) => {
                    setCreateOpen(false)
                    setNewTitle('')
                    loadList(query, status, dir, tag)
                    refreshAux()
                    openDocument(result.path)
                  }).catch((error: unknown) => { setLastError(messageOf(error)) })
                }
              }}
            />
            <select
              className={css.createDir}
              aria-label={t('create.directory')}
              value={newDir}
              onChange={(event) => { setNewDir(event.target.value) }}
            >
              {dirList.map(entry => <option key={entry} value={entry}>{entry}</option>)}
            </select>
            <button
              type="button"
              className={css.primaryBtn}
              onClick={() => {
                if (newTitle.trim().length === 0) return
                void create({ title: newTitle.trim(), directory: newDir }).then((result) => {
                  setCreateOpen(false)
                  setNewTitle('')
                  loadList(query, status, dir, tag)
                  refreshAux()
                  openDocument(result.path)
                }).catch((error: unknown) => { setLastError(messageOf(error)) })
              }}
            >
              {t('create.create')}
            </button>
            <button type="button" className={css.ghostBtn} onClick={() => { setCreateOpen(false) }}>
              {t('create.cancel')}
            </button>
            <span className={css.createHint}>{t('create.hint')}</span>
          </div>
        )}

        {lastError !== null && (
          <div className={css.errorBar} role="alert">
            <span className={css.errorIcon}>
              <IconWarningOutline16 size={14} />
            </span>
            {t('error.action', { message: lastError })}
          </div>
        )}

        <div className={css.body}>
          <nav className={css.nav} aria-label={t('panel.title')}>
            <div className={css.navSection}>
              {(['inbox', 'filed', 'archived'] as const).map(st => (
                <button
                  key={st}
                  type="button"
                  className={!showTrash && status === st ? css.navItemActive : css.navItem}
                  onClick={() => { setShowTrash(false); pickStatus(st) }}
                >
                  <span className={css.navLabel}>{STATUS_LABELS[st]}</span>
                  <span className={css.navCount}>{byStatus[st]}</span>
                </button>
              ))}
            </div>

            <div className={css.navHeading}>{t('nav.directories')}</div>
            <div className={css.navSection}>
              {tree.map(node => (
                <DirRow
                  key={node.path}
                  node={node}
                  depth={0}
                  active={!showTrash && dir === node.path}
                  collapsed={collapsed}
                  reserved={reservedRoots}
                  dirEdit={dirEdit}
                  dirEditValue={dirEditValue}
                  onDirEditValue={setDirEditValue}
                  onDirEdit={setDirEdit}
                  onToggle={(path) => {
                    const next = new Set(collapsed)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    setCollapsed(next)
                  }}
                  onPick={(path) => { setShowTrash(false); pickDir(path) }}
                  onCreateDir={(parent, name) => {
                    setDirEdit(null)
                    setDirEditValue('')
                    void createDir({ directory: parent === '' ? name : `${parent}/${name}` })
                      .then(() => dirs()).then(setDirList)
                      .catch((error: unknown) => { setLastError(messageOf(error)) })
                  }}
                  onRename={(path, name) => {
                    setDirEdit(null)
                    setDirEditValue('')
                    void renameDir({ directory: path, name })
                      .then(() => { void dirs().then(setDirList); loadList(query, status, dir, tag) })
                      .catch((error: unknown) => { setLastError(messageOf(error)) })
                  }}
                />
              ))}
            </div>

            {tagList.length > 0 && (
              <>
                <div className={css.navHeading}>{t('nav.tags')}</div>
                <div className={css.navSection}>
                  {shownTags.map(entry => (
                    <button
                      key={entry.tag}
                      type="button"
                      className={!showTrash && tag === entry.tag ? css.navItemActive : css.navItem}
                      onClick={() => { setShowTrash(false); pickTag(entry.tag) }}
                    >
                      <span className={css.navLabel}>#{entry.tag}</span>
                      <span className={css.navCount}>{entry.count}</span>
                    </button>
                  ))}
                  {tagList.length > 8 && (
                    <button
                      type="button"
                      className={css.navLink}
                      onClick={() => { setAllTags(!allTags) }}
                    >
                      {allTags ? '− ' : '＋ '}{t('nav.allTags')}
                    </button>
                  )}
                </div>
              </>
            )}

            <div className={css.navFooter}>
              <button
                type="button"
                className={showTrash ? css.navItemActive : css.navItem}
                onClick={() => {
                  setShowTrash(!showTrash)
                  setSelected(null)
                  setTrashSelected(null)
                  if (!showTrash) void trash().then(setTrashDocs).catch((error: unknown) => { setLastError(messageOf(error)) })
                }}
              >
                <span className={css.navLabel}>
                  <IconTrashOutline16 size={14} className={css.treeIcon} />
                  {t('nav.trash')}
                </span>
              </button>
            </div>
          </nav>

          <section className={css.list}>
            {showTrash ? (
              trashDocs.length === 0
                ? (
                  <div className={css.empty}>
                    <span className={css.emptyIcon}>
                      <IconTrashOutline16 size={32} />
                    </span>
                    {t('trash.empty')}
                  </div>
                )
                : trashDocs.map(entry => (
                  <div
                    key={entry.path}
                    className={trashSelected === entry.path ? css.itemActive : css.item}
                    onClick={() => { setTrashSelected(entry.path) }}
                  >
                    <div className={css.itemTitle}>{entry.title || entry.name}</div>
                    <div className={css.itemMeta}>{entry.name}</div>
                  </div>
                ))
            ) : docs.length === 0
              ? (
                <div className={css.empty}>
                  <span className={css.emptyIcon}>
                    <IconBrowseOutline16 size={32} />
                  </span>
                  <span>{filtered ? t('list.emptyFiltered') : t('panel.empty')}</span>
                  {filtered && (
                    <button
                      type="button"
                      className={css.navLink}
                      onClick={() => { setStatus('all'); setDir(null); setTag(null); loadList(query, 'all', null, null) }}
                    >
                      {t('list.clearFilter')}
                    </button>
                  )}
                  {!filtered && (
                    <button
                      type="button"
                      className={`${css.primaryBtn} ${css.emptyAction}`}
                      onClick={() => { setCreateOpen(true) }}
                    >
                      <IconPlusOutline16 size={14} />
                      {t('panel.new')}
                    </button>
                  )}
                </div>
              )
              : (
                <>
                  {pinned.length > 0 && (
                    <div className={css.group}>
                      <div className={css.groupTitle}>{t('list.pinned')}</div>
                      {pinned.map(doc => (
                        <DocCard
                          key={doc.path}
                          doc={doc}
                          active={selected === doc.path}
                          open={() => { openDocument(doc.path) }}
                          menuFor={menuFor}
                          moveFor={moveFor}
                          dirList={dirList}
                          t={t}
                          onMenu={(path) => { setMenuFor(menuFor === path ? null : path); setMoveFor(null) }}
                          onPin={path => void save({ path, pinned: !(docs.find(doc => doc.path === path)?.pinned ?? false) })
                            .then(() => { loadList(query, status, dir, tag) })
                            .catch((error: unknown) => { setLastError(messageOf(error)) })}
                          onMovePick={(path) => { setMoveFor(moveFor === path ? null : path) }}
                          onMoveTo={(path, targetDirectory) => {
                            setMoveFor(null)
                            setMenuFor(null)
                            void move({ path, targetDirectory }).then(() => { loadList(query, status, dir, tag); refreshAux() })
                              .catch((error: unknown) => { setLastError(messageOf(error)) })
                          }}
                          onDelete={path => void remove(path).then(() => {
                            setMenuFor(null)
                            if (selected === path) setSelected(null)
                            loadList(query, status, dir, tag)
                            refreshAux()
                          }).catch((error: unknown) => { setLastError(messageOf(error)) })}
                        />
                      ))}
                    </div>
                  )}
                  {groups.map(({ group, docs: groupDocs }) => (
                    <div className={css.group} key={group}>
                      <div className={css.groupTitle}>{GROUP_LABELS[group]}</div>
                      {groupDocs.map(doc => (
                        <DocCard
                          key={doc.path}
                          doc={doc}
                          active={selected === doc.path}
                          open={() => { openDocument(doc.path) }}
                          menuFor={menuFor}
                          moveFor={moveFor}
                          dirList={dirList}
                          t={t}
                          onMenu={(path) => { setMenuFor(menuFor === path ? null : path); setMoveFor(null) }}
                          onPin={path => void save({ path, pinned: !(docs.find(doc => doc.path === path)?.pinned ?? false) })
                            .then(() => { loadList(query, status, dir, tag) })
                            .catch((error: unknown) => { setLastError(messageOf(error)) })}
                          onMovePick={(path) => { setMoveFor(moveFor === path ? null : path) }}
                          onMoveTo={(path, targetDirectory) => {
                            setMoveFor(null)
                            setMenuFor(null)
                            void move({ path, targetDirectory }).then(() => { loadList(query, status, dir, tag); refreshAux() })
                              .catch((error: unknown) => { setLastError(messageOf(error)) })
                          }}
                          onDelete={path => void remove(path).then(() => {
                            setMenuFor(null)
                            if (selected === path) setSelected(null)
                            loadList(query, status, dir, tag)
                            refreshAux()
                          }).catch((error: unknown) => { setLastError(messageOf(error)) })}
                        />
                      ))}
                    </div>
                  ))}
                </>
              )}
          </section>

          <section className={css.view}>
            {showTrash ? (
              trashEntry === null
                ? (
                  <div className={css.emptyView}>
                    <span className={css.emptyIcon}>
                      <IconTrashOutline16 size={32} />
                    </span>
                    {t('trash.hint')}
                  </div>
                )
                : (
                  <article className={css.trashView}>
                    {purgeConfirming === trashEntry.path
                      ? (
                        <div className={css.confirmBar}>
                          <span className={css.confirmHint}>{t('trash.purgeConfirm')}</span>
                          <button
                            type="button"
                            className={css.ghostBtn}
                            onClick={() => { setPurgeConfirming(null) }}
                          >
                            {t('menu.cancel')}
                          </button>
                          <button
                            type="button"
                            className={css.dangerBtn}
                            onClick={() => {
                              void purge(trashEntry.path)
                                .then(() => trash())
                                .then((next) => { setTrashDocs(next); setTrashSelected(null); setPurgeConfirming(null); refreshAux() })
                                .catch((error: unknown) => { setLastError(messageOf(error)) })
                            }}
                          >
                            <IconTrashOutline16 size={14} />
                            {t('trash.purge')}
                          </button>
                        </div>
                      )
                      : (
                        <div className={css.toolbar}>
                          <button
                            type="button"
                            className={css.primaryBtn}
                            onClick={() => void restore(trashEntry.path)
                              .then(() => trash())
                              .then((next) => { setTrashDocs(next); setTrashSelected(null); refreshAux() })
                              .catch((error: unknown) => { setLastError(messageOf(error)) })}
                          >
                            {t('trash.restore')}
                          </button>
                          <button
                            type="button"
                            className={css.ghostBtn}
                            onClick={() => { setPurgeConfirming(trashEntry.path) }}
                          >
                            {t('trash.purge')}
                          </button>
                        </div>
                      )}
                    <h1 className={css.docTitle}>{trashEntry.title || trashEntry.name}</h1>
                    <div className={css.trashBody}>
                      {/* Trash previews render the body as-is; relative image
                        references resolve against the library root and may 404. */}
                      <MarkdownText text={kbMarkdown(trashEntry.body, '', assetUrl)} />
                    </div>
                  </article>
                )
            ) : selected === null
              ? (
                <div className={css.emptyView}>
                  <span className={css.emptyIcon}>
                    <IconBrowseOutline16 size={32} />
                  </span>
                  {t('panel.emptyView')}
                </div>
              )
              : (
                <article className={css.article}>
                  <div className={css.viewHeader}>
                    <div className={css.crumbs}>
                      {dirOf(selected) !== '' && (
                        <button
                          type="button"
                          className={css.crumb}
                          onClick={() => { pickDir(dirOf(selected)) }}
                        >
                          {dirOf(selected)}
                        </button>
                      )}
                      {dirOf(selected) !== '' && (
                        <span className={css.crumbSep}>
                          <IconChevronRightOutline14 size={12} />
                        </span>
                      )}
                      <button
                        type="button"
                        className={css.crumb}
                        onClick={() => { setShowTrash(false); pickStatus('all') }}
                      >
                        {t('panel.back')}
                      </button>
                    </div>
                    <div className={css.toolbar}>
                      {editing
                        ? (
                          <>
                            <button type="button" className={css.primaryBtn} onClick={saveCurrent}>
                              {t('view.save')}
                            </button>
                            <button
                              type="button"
                              className={css.ghostBtn}
                              onClick={() => { setEditing(false); setDraft(content) }}
                            >
                              {t('view.cancelEdit')}
                            </button>
                            <span className={css.editHint}>{t('view.editing')}</span>
                          </>
                        )
                        : (
                          <>
                            <button type="button" className={css.primaryBtn} onClick={() => { setEditing(true) }}>
                              <IconEditOutline16 size={14} />
                              {t('view.edit')}
                            </button>
                            <button type="button" className={css.ghostBtn} onClick={deleteSelected}>
                              <IconTrashOutline16 size={14} />
                              {t('view.delete')}
                            </button>
                          </>
                        )}
                    </div>
                  </div>
                  <h1 className={css.docTitle}>{docs.find(doc => doc.path === selected)?.title ?? selected}</h1>
                  <div className={css.metaBar}>
                    <label className={css.metaField}>
                      <span>{t('view.moveTo')}</span>
                      <select value={dirOf(selected)} onChange={(event) => { moveSelected(event.target.value) }}>
                        {dirList.map(entry => <option key={entry} value={entry}>{entry}</option>)}
                      </select>
                    </label>
                    <span className={css.metaField}>
                      <span>{t('view.tags')}</span>
                      <span className={css.tagChips}>
                        {tagsOf(meta).map(name => (
                          <button
                            key={name}
                            type="button"
                            className={css.tagChip}
                            onClick={() => { saveTags(tagsOf(meta).filter(tagName => tagName !== name)) }}
                            title={name}
                          >
                            #{name}
                            <IconCloseFill14 size={10} />
                          </button>
                        ))}
                        <input
                          className={css.tagInput}
                          placeholder={t('view.tagPlaceholder')}
                          value={tagDraft}
                          onChange={(event) => { setTagDraft(event.target.value) }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && tagDraft.trim().length > 0) {
                              const next = [...tagsOf(meta), tagDraft.trim()]
                              setTagDraft('')
                              saveTags(next)
                            }
                          }}
                        />
                      </span>
                    </span>
                  </div>
                  {editing
                    ? (
                      <div className={css.editor}>
                        <textarea
                          className={css.textarea}
                          value={draft}
                          onChange={(event) => { setDraft(event.target.value) }}
                          onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                              event.preventDefault()
                              saveCurrent()
                            }
                          }}
                        />
                        <div className={css.preview}>
                          <MarkdownText text={kbMarkdown(draft, dirOf(selected), assetUrl)} />
                        </div>
                      </div>
                    )
                    : (
                      <div className={css.content}>
                        <MarkdownText text={kbMarkdown(content, dirOf(selected), assetUrl)} />
                      </div>
                    )}
                  {backlinks.length > 0 && (
                    <div className={css.backlinks}>
                      <div className={css.backlinksTitle}>{t('view.backlinks', { count: backlinks.length })}</div>
                      {backlinks.map(path => (
                        <button
                          key={path}
                          type="button"
                          className={css.backlink}
                          onClick={() => { openDocument(path) }}
                        >
                          <IconChevronRightOutline14 size={10} />
                          {path}
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              )}
          </section>
        </div>
      </div>
    </div>
  )
}

/** One directory-tree row with recursive children and inline create/rename. */
function DirRow({
  node, depth, active, collapsed, reserved, dirEdit, dirEditValue, onDirEditValue, onDirEdit,
  onToggle, onPick, onCreateDir, onRename,
}: {
  node: DirNode
  depth: number
  active: boolean
  collapsed: ReadonlySet<string>
  reserved: ReadonlySet<string>
  dirEdit: { mode: 'create' | 'rename'; parent: string } | null
  dirEditValue: string
  onDirEditValue: (value: string) => void
  onDirEdit: (edit: { mode: 'create' | 'rename'; parent: string } | null) => void
  onToggle: (path: string) => void
  onPick: (path: string) => void
  onCreateDir: (parent: string, name: string) => void
  onRename: (path: string, name: string) => void
}) {
  const isCollapsed = collapsed.has(node.path)
  const hasChildren = node.children.length > 0
  const editable = !reserved.has(node.path.split('/')[0] ?? '')
  const editing = dirEdit !== null && dirEdit.parent === node.path
  return (
    <div className={css.treeRow}>
      <div
        className={active ? css.treeItemActive : css.treeItem}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => { onPick(node.path) }}
      >
        {hasChildren && (
          <button
            type="button"
            className={css.treeToggle}
            aria-label={isCollapsed ? 'expand' : 'collapse'}
            onClick={(event) => { event.stopPropagation(); onToggle(node.path) }}
          >
            <IconTriangleRightFill14 size={10} className={isCollapsed ? undefined : css.treeToggleExpanded} />
          </button>
        )}
        <span className={css.treeIcon}>
          {hasChildren
            ? (isCollapsed ? <IconFolderClose16 size={14} /> : <IconFolderOpen16 size={14} />)
            : <IconFolderClose16 size={14} />}
        </span>
        <span className={css.treeName}>{node.name}</span>
        {editable && (
          <span className={css.treeActions}>
            {editing && dirEdit.mode === 'rename' && (
              <input
                className={css.treeInput}
                autoFocus
                defaultValue={node.name}
                onClick={(event) => { event.stopPropagation() }}
                onChange={(event) => { onDirEditValue(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && dirEditValue.trim().length > 0) {
                    onRename(node.path, dirEditValue.trim())
                  } else if (event.key === 'Escape') {
                    onDirEdit(null)
                  }
                }}
              />
            )}
            <button
              type="button"
              className={css.treeAction}
              title="rename"
              onClick={(event) => {
                event.stopPropagation()
                if (editing) onDirEdit(null)
                else {
                  onDirEditValue(node.name)
                  onDirEdit({ mode: 'rename', parent: node.path })
                }
              }}
            >
              <IconEditOutline16 size={12} />
            </button>
            <button
              type="button"
              className={css.treeAction}
              title="new subdirectory"
              onClick={(event) => {
                event.stopPropagation()
                if (editing) onDirEdit(null)
                else {
                  onDirEditValue('')
                  onDirEdit({ mode: 'create', parent: node.path })
                }
              }}
            >
              <IconPlusOutline16 size={12} />
            </button>
          </span>
        )}
      </div>
      {editing && dirEdit.mode === 'create' && (
        <input
          className={css.treeInput}
          style={{ marginLeft: 8 + depth * 14 + 22 }}
          autoFocus
          placeholder="目录名"
          value={dirEditValue}
          onChange={(event) => { onDirEditValue(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirEditValue.trim().length > 0) {
              onCreateDir(node.path, dirEditValue.trim())
            } else if (event.key === 'Escape') {
              onDirEdit(null)
            }
          }}
        />
      )}
      {hasChildren && !isCollapsed && node.children.map(child => (
        <DirRow
          key={child.path}
          node={child}
          depth={depth + 1}
          active={active}
          collapsed={collapsed}
          reserved={reserved}
          dirEdit={dirEdit}
          dirEditValue={dirEditValue}
          onDirEditValue={onDirEditValue}
          onDirEdit={onDirEdit}
          onToggle={onToggle}
          onPick={onPick}
          onCreateDir={onCreateDir}
          onRename={onRename}
        />
      ))}
    </div>
  )
}

/** One document card with its hover menu (pin / move / delete). */
function DocCard({
  doc, active, open, menuFor, moveFor, dirList, t, onMenu, onPin, onMovePick, onMoveTo, onDelete,
}: {
  doc: KbDocSummary
  active: boolean
  open: () => void
  menuFor: string | null
  moveFor: string | null
  dirList: readonly string[]
  t: KbPanelProps['t']
  onMenu: (path: string) => void
  onPin: (path: string) => void
  onMovePick: (path: string) => void
  onMoveTo: (path: string, targetDirectory: string) => void
  onDelete: (path: string) => void
}) {
  return (
    <div
      className={active ? css.itemActive : css.item}
      data-kb-menu=""
      onClick={open}
    >
      <div className={css.itemTitle}>
        <span className={css.itemTitleText}>{doc.title}</span>
        <button
          type="button"
          className={css.itemMenu}
          aria-label="⋯"
          onClick={(event) => { event.stopPropagation(); onMenu(doc.path) }}
        >
          <IconEllipsisOutline16 size={14} />
        </button>
      </div>
      {doc.summary.length > 0 && <div className={css.itemSummary}>{doc.summary}</div>}
      <div className={css.itemMeta}>
        {doc.tags.slice(0, 3).map(name => <span key={name} className={css.itemTag}>#{name}</span>)}
        {doc.updated.length > 0 && <span className={css.itemDate}>{doc.updated}</span>}
      </div>
      {menuFor === doc.path && (
        <div className={css.menu} data-kb-menu="" onClick={(event) => { event.stopPropagation() }}>
          {!moveFor && (
            <button type="button" className={css.menuItem} onClick={() => { onPin(doc.path) }}>
              {doc.pinned ? t('menu.unpin') : t('menu.pin')}
            </button>
          )}
          <button type="button" className={css.menuItem} onClick={() => { onMovePick(doc.path) }}>
            {t('menu.move')}
          </button>
          {moveFor === doc.path && (
            <div className={css.menuMove}>
              <select
                className={css.menuSelect}
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value.length > 0) onMoveTo(doc.path, event.target.value)
                }}
              >
                <option value="" disabled>{t('menu.movePlaceholder')}</option>
                {dirList.filter(entry => entry !== dirOf(doc.path)).map(entry => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </select>
            </div>
          )}
          {!moveFor && (
            <button type="button" className={css.menuItemDanger} onClick={() => { onDelete(doc.path) }}>
              {t('menu.delete')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
