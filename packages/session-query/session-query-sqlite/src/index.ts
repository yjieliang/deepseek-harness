/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  type SqliteQueryRoute,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  containsCjk,
  escapeLikePattern,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  routeSqliteQuery,
  sanitizeFtsText,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

// One transient source change gets a retry; repeated churn fails rather than monopolizing the queue.
const STABLE_OBSERVATION_ATTEMPTS = 2

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedSession>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding, routeSqliteQuery(normalized.query))
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding, routeSqliteQuery(normalized.query))
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const observation = await this._observeStable(persistedById, signal)
    assertNotAborted(signal)
    const persistentChanges = observation.persistenceBinding.service === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => entry.loaded !== undefined)
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : persistedRows.filter(row => !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity
    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) {
          /* v8 ignore next -- observation loads every entry whose revision differs */
          if (entry.loaded === undefined) throw new Error(`missing loaded revision for session "${entry.header.id}"`)
          this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration)
        }
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    return observation.persistenceBinding
  }

  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      if (persistence !== undefined) {
        try {
          const canReuseIndexed = this._lastPersistenceIdentity === undefined
            || this._lastPersistenceIdentity === persistenceBinding.identity
          const listOptions = signal === undefined ? undefined : { signal }
          const before = await persistence.list(listOptions)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
            // Skip work already shadowed by a live owner. The cold read is
            // non-mutating (interrupted turns are balanced in memory only), so
            // an owner attaching after this check cannot cause side effects;
            // the live-membership retry below makes the returned observation
            // live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            assertNotAborted(signal)
            const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
            assertNotAborted(signal)
            assertSessionHeadersCompatible(entry.header, loaded.header)
            entry.loaded = observeSession(loaded.header, loaded.inheritedEventCount, loaded.events)
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after)) continue
          if (this._persistenceBinding !== persistenceBinding) continue
        } catch (error: unknown) {
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (!sameSessionIds(initiallyLive, live)) continue
      return { persistenceBinding, persisted, live }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      // The companion index stores no session column, so it is pruned by the
      // primary rowids while those rows still exist.
      db.prepare(
        'DELETE FROM persisted_docs_cjk WHERE rowid IN (SELECT rowid FROM persisted_docs WHERE session_id = ?)',
      ).run(id)
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare(
        'DELETE FROM temp.live_docs_cjk WHERE rowid IN (SELECT rowid FROM temp.live_docs WHERE session_id = ?)',
      ).run(id)
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCjk = db.prepare('INSERT INTO persisted_docs_cjk (rowid, text) VALUES (?, ?)')
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      const { lastInsertRowid } = insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
      // Only CJK-bearing documents can answer a trigram query, so the companion
      // index stays a strict subset keyed by the primary table's rowid.
      if (containsCjk(text)) insertCjk.run(lastInsertRowid, text)
    }
  }

  private _replaceLiveSession(entry: ObservedSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertCjk = db.prepare('INSERT INTO temp.live_docs_cjk (rowid, text) VALUES (?, ?)')
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      const { lastInsertRowid } = insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
      if (containsCjk(text)) insertCjk.run(lastInsertRowid, text)
    }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
    route: SqliteQueryRoute,
  ): SearchRow[] {
    const selected = selectedDocumentsSql(
      route,
      request.query,
      persistenceBinding.service !== undefined,
    )
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selected.params,
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
    route: SqliteQueryRoute,
  ): SearchRow[] {
    const selected = selectedDocumentsSql(
      route,
      request.query,
      persistenceBinding.service !== undefined,
    )
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selected.params,
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

/** Suffix of the contentless trigram companion index over CJK-bearing documents. */
const CJK_INDEX_SUFFIX = '_cjk'

/**
 * Routes that reduce their candidate branch with a `WHERE` predicate.
 *
 * The additive routes are excluded on purpose: in this statement's shape their widening
 * cannot be written as one predicate, so they select their rows through a row-id union
 * instead. Narrowing the type here keeps that separation a compile error rather than a
 * runtime one.
 */
type PredicateRoute = Exclude<SqliteQueryRoute, 'primary-cjk-trigram' | 'ascii-substring'>
/** The routes spelled as a row-id union rather than a predicate. */
type UnionRoute = Exclude<SqliteQueryRoute, PredicateRoute>

/**
 * Whether a route drives its scan from a row-id union prelude.
 * @param route - engine chosen for this query.
 * @returns true for the two additive routes.
 */
function isUnionRouteSql(route: SqliteQueryRoute): route is UnionRoute {
  return route === 'primary-cjk-trigram' || route === 'ascii-substring'
}

/**
 * WITH-clause prelude for a union route's two candidates, or an empty string for every
 * other route.
 *
 * The widening cannot be spelled as one predicate **in this statement's shape**.
 * `primary MATCH ? OR <probe>` is rejected with "unable to use function MATCH in the
 * requested context" once the branch also joins the session header, unions the live
 * branch, and guards the live shadow — which is precisely the statement this engine
 * builds. A bare `SELECT` over the same table with the same `OR` does construct, so
 * the blocker is that combination rather than `OR` on its own; independent review
 * isolated it. `MATCH` is separately always illegal inside a `CASE`, and illegal as a
 * direct arm on both sides of an `OR`.
 *
 * So the two engines produce their row ids separately — each engine's test a top-level
 * conjunct of its own SELECT — and `UNION` (not `UNION ALL`) drives the scan, so a
 * document both engines select is visited exactly once.
 *
 * `persisted_primary`/`live_primary` exist because `highlight()` marks only the rows
 * the same query selected through the FTS table's own `MATCH`. Marking them
 * `MATERIALIZED` keeps the planner from flattening them into the outer query, which
 * has no `MATCH` at all; review dropped materialization and saw the output unchanged,
 * so treat it as a plan-level guarantee rather than a currently observable
 * requirement. Each CTE is keyed by the primary rowid and joined with `LEFT JOIN`, so
 * the primary marking survives for the rows that have one and stays NULL for the rows
 * only the widening found, which fall back to literal substring marking.
 *
 * The two union routes share this shape and differ only in their second engine: the
 * additive route probes the companion trigram index with a `MATCH`, while the short-word
 * route scans the primary text with `instr()`.
 * @returns the four CTE definitions, in declaration order, or an empty string.
 */
function additivePreludeCtes(route: SqliteQueryRoute): string {
  const widening = route === 'primary-cjk-trigram'
    ? 'SELECT rowid AS rid FROM persisted_docs_cjk WHERE persisted_docs_cjk MATCH ?'
    : route === 'ascii-substring'
      ? 'SELECT rowid AS rid FROM persisted_docs WHERE instr(text, ?) > 0'
      : undefined
  const liveWidening = route === 'primary-cjk-trigram'
    ? 'SELECT rowid AS rid FROM temp.live_docs_cjk WHERE live_docs_cjk MATCH ?'
    : route === 'ascii-substring'
      ? 'SELECT rowid AS rid FROM temp.live_docs WHERE instr(text, ?) > 0'
      : undefined
  if (widening === undefined || liveWidening === undefined) return ''
  return `persisted_primary AS MATERIALIZED (
      SELECT rowid AS rid, highlight(persisted_docs, 0, ?, ?) AS marked_text
      FROM persisted_docs WHERE persisted_docs MATCH ?
    ),
    persisted_targets AS (
      SELECT rowid AS rid FROM persisted_docs WHERE persisted_docs MATCH ?
      UNION
      ${widening}
    ),
    live_primary AS MATERIALIZED (
      SELECT rowid AS rid, highlight(live_docs, 0, ?, ?) AS marked_text
      FROM temp.live_docs WHERE live_docs MATCH ?
    ),
    live_targets AS (
      SELECT rowid AS rid FROM temp.live_docs WHERE live_docs MATCH ?
      UNION
      ${liveWidening}
    ),
    `
}

/**
 * Bindings for {@link additivePreludeCtes}, in declaration order.
 *
 * The primary `MATCH` is bound three times per branch — once for the marking CTE, once
 * for the target union, once for the live-shadow guard the outer statement adds — and
 * the widening once. The two `highlight()` calls contribute two markers each.
 * @param route - engine chosen for this query.
 * @param expression - quoted FTS5 phrase for the primary engine.
 * @param query - normalized caller query, bound to the short-word route's `instr()` probe.
 * @returns the prelude's bindings, or an empty array for every other route.
 */
function additivePreludeBindings(
  route: SqliteQueryRoute,
  expression: string,
  query: string,
): Array<string | number> {
  if (route === 'primary-cjk-trigram') {
    return [
      FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression,
      expression, expression,
      FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression,
      expression, expression,
    ]
  }
  if (route === 'ascii-substring') {
    return [
      FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression,
      expression, query,
      FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression,
      expression, query,
    ]
  }
  return []
}

/**
 * FROM clause selecting one branch's candidate rows.
 *
 * Every other route scans the primary table directly and lets the predicate reduce
 * it. The additive route instead scans the row-id union and joins back to the primary
 * table by rowid, which keeps the scan proportional to the matched set.
 * @param route - engine chosen for this query.
 * @param alias - candidate branch table alias (`pd` or `ld`).
 * @returns the branch's FROM and JOIN clauses, without a WHERE.
 */
function candidateSourceSql(route: SqliteQueryRoute, alias: 'pd' | 'ld'): string {
  if (isUnionRouteSql(route)) {
    return alias === 'pd'
      ? `FROM persisted_targets AS pt
      JOIN persisted_docs AS pd ON pd.rowid = pt.rid
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      LEFT JOIN persisted_primary AS ppm ON ppm.rid = pt.rid`
      : `FROM live_targets AS lt
      JOIN temp.live_docs AS ld ON ld.rowid = lt.rid
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      LEFT JOIN live_primary AS lpm ON lpm.rid = lt.rid`
  }
  return alias === 'pd'
    ? `FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id`
    : `FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id`
}

/**
 * Marker expression for one candidate branch.
 *
 * `highlight()` alone belongs to the primary route, because FTS5 marks only the rows the
 * same table's `MATCH` selected within the same statement. Neither CJK route carries a
 * `MATCH` on the text table: `cjk-substring` reduces candidates with `LIKE`, and
 * `cjk-trigram` reduces them with a probe against the companion trigram index, which is
 * `content=''` and therefore cannot be highlighted either. Both would otherwise hand the
 * caller `marked_text` byte-identical to the document — a `match_count` of zero, and a
 * snippet cut from the head of the document instead of around the word that matched — so
 * both mark the literal query exactly as the additive route's fallback does.
 *
 * `primary-cjk-trigram` needs its own shape: a row can be selected by the companion
 * probe alone, so a companion-only row falls back to that same literal marking while a
 * row the primary `MATCH` selected keeps the marking precomputed in the joined CTE.
 *
 * Neither this expression nor the predicate it accompanies may carry `MATCH` in the
 * additive route: in this statement's shape the additive predicate cannot hold one
 * (SQLite reports "unable to use function MATCH in the requested context"), which is
 * what forces the row-id union in {@link additivePreludeCtes} instead of a plain
 * `primary OR companion` predicate.
 * @param route - engine chosen for this query.
 * @param alias - candidate branch table alias (`pd` or `ld`).
 * @param ftsTable - FTS5 table name to pass to `highlight()`.
 * @returns SQL that yields text with `FTS_HIGHLIGHT_START`/`_END` around matches.
 */
function markedTextSql(route: SqliteQueryRoute, alias: string, ftsTable: string): string {
  if (route === 'cjk-substring' || route === 'cjk-trigram') return literalMarkerSql(alias)
  if (isUnionRouteSql(route)) {
    // A row the primary index matched carries its `highlight()` text from the joined
    // CTE; a row only the widening found has none, so it falls back to literal
    // substring marking. `highlight()` cannot be called here at all: SQLite refuses a
    // `MATCH` inside an `OR`, which is why neither this expression nor the predicate
    // may contain one — see {@link additivePreludeCtes}.
    const marked = alias === 'pd' ? 'ppm' : 'lpm'
    return `COALESCE(${marked}.marked_text, ${literalMarkerSql(alias)})`
  }
  return `highlight(${ftsTable}, 0, ?, ?)`
}

/**
 * Literal substring marking, the shape every route that cannot call `highlight()` shares.
 *
 * The needle is the caller's query verbatim, never a `%query%` `LIKE` pattern: `replace()`
 * is a literal substitution, so the pattern a `LIKE` predicate is bound to never occurs
 * in a document and injects no marker at all. Both passes replace the query rather than
 * the text they just wrote, so the second still finds the needle; consuming it in the
 * first pass would leave a lone start marker — a `match_count` of 1 describing text that
 * no longer shows what matched.
 * @param alias - candidate branch table alias (`pd` or `ld`).
 * @returns SQL whose `?` placeholders are, in order, the needle, the needle followed by
 *   the end marker, the needle again, and the start marker followed by the needle.
 */
function literalMarkerSql(alias: string): string {
  return `replace(replace(${alias}.text, ?, ?), ?, ?)`
}

/**
 * Predicate selecting one branch's matching documents.
 *
 * The persisted branch carries the persistence-visibility placeholder; the live
 * branch does not, because a live row is visible by definition and the statement
 * consumes the visibility flag exactly once per candidate branch. The companion
 * index stores no text and cannot carry companion columns, so the CJK route joins
 * it by primary rowid. A contentless FTS5 `MATCH` must name a bare table name,
 * never a schema-qualified one, which is why the temp companion is matched as
 * `live_docs_cjk` while being referenced as `temp.live_docs_cjk`.
 * @param route - engine chosen for this query.
 * @param alias - candidate branch table alias (`pd` or `ld`).
 * @param ftsTable - FTS5 table name for the `MATCH` left-hand side.
 * @returns SQL fragment for the branch `WHERE` clause.
 */
function candidatePredicateSql(route: PredicateRoute, alias: string, ftsTable: string): string {
  const live = alias !== 'pd'
  switch (route) {
    case 'primary':
      return live ? `${ftsTable} MATCH ?` : `${ftsTable} MATCH ? AND ? = 1`
    case 'cjk-trigram': {
      const companion = `${ftsTable}${CJK_INDEX_SUFFIX}`
      const probe = `${alias}.rowid IN (SELECT rowid FROM ${alias === 'pd' ? '' : 'temp.'}${companion} WHERE ${companion} MATCH ?)`
      return live ? probe : `${probe} AND ? = 1`
    }
    case 'cjk-substring':
      return `${alias}.text LIKE ? ESCAPE '\\'`
    /* v8 ignore next 2 -- unreachable while the route union and its switches stay in sync */
    default:
      return unreachableRoute(route)
  }
}

/* v8 ignore next -- unreachable while the route union and its switches stay in sync */
function unreachableRoute(route: never): never {
  throw new SessionQueryError(
    `session-search query route "${String(route)}" is unsupported`,
    'SESSION_QUERY_INVALID_QUERY',
  )
}

/**
 * Marked-text bindings for one branch.
 *
 * Every route whose marking is the literal fallback binds the caller's query itself,
 * because none of them can hand `highlight()` the `MATCH` it needs — see
 * {@link markedTextSql}; only the primary route binds the marker pair. Each list is
 * ordered to match its expression exactly.
 *
 * The literal substitution is case-sensitive, matching like for like. A query whose case
 * differs from the document (`dsh` against `本次DSH会话检索修复已完成`) is still
 * selected — the trigram engine folds case exactly as `unicode61` does — but reaches
 * the caller unmarked, so its snippet starts at the head of the document.
 * @param route - engine chosen for this query.
 * @param query - normalized caller query.
 * @returns values consumed by {@link markedTextSql} in declaration order.
 */
function markedTextBindings(route: SqliteQueryRoute, query: string): Array<string | number> {
  if (route !== 'primary') {
    return [query, `${query}${FTS_HIGHLIGHT_END}`, query, `${FTS_HIGHLIGHT_START}${query}`]
  }
  return [FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END]
}

/**
 * Predicate bindings for one branch.
 *
 * The persisted branch consumes the visibility flag after the phrase; the live
 * branch consumes only the phrase, mirroring {@link candidatePredicateSql}.
 * @param route - engine chosen for this query.
 * @param live - whether this is the `temp.live_docs` branch.
 * @param expression - quoted FTS5 phrase, unused by the substring route.
 * @param visible - persistence-visibility flag, unused by the substring route.
 * @param likePattern - escaped `%query%` pattern, unused by the FTS5 routes.
 * @returns values consumed by {@link candidatePredicateSql} in declaration order.
 */
function candidatePredicateBindings(
  route: PredicateRoute,
  live: boolean,
  expression: string,
  visible: number,
  likePattern: string,
): Array<string | number> {
  if (route === 'cjk-substring') return [likePattern]
  return live ? [expression] : [expression, visible]
}

/**
 * Build the candidate-selection SQL and its bindings for one route.
 *
 * Column list, live/persisted union, `match_count` derivation, and the ranking in
 * `_querySessions`/`_queryEvents` are identical across routes; only the source, the
 * predicate, and the marked-text expression change, and each route supplies its own
 * exact binding list, so no positional arithmetic is shared between routes.
 *
 * The additive route needs one more difference: its persisted branch gates on the
 * visibility flag inside its `WHERE` instead of inside a predicate, because its rows
 * arrive from a row-id union rather than from a `MATCH` on the branch table. The flag
 * is still consumed exactly once per branch.
 * @param route - engine chosen for this query.
 * @param query - normalized caller query.
 * @param persistenceVisible - whether persisted documents are visible to callers.
 * @returns complete statement text and its ordered bindings.
 */
function selectedDocumentsSql(
  route: SqliteQueryRoute,
  query: string,
  persistenceVisible: boolean,
): { sql: string; params: Array<string | number> } {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  const likePattern = `%${escapeLikePattern(query)}%`
  const markerBytes = Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8')

  const union = isUnionRouteSql(route)
  const persistedPredicate = union
    ? '? = 1'
    : candidatePredicateSql(route, 'pd', 'persisted_docs')
  const liveWhere = union
    ? ''
    : `
      WHERE ${candidatePredicateSql(route, 'ld', 'live_docs')}`
  // Called for every route, exactly like `additivePreludeCtes`: it contributes
  // bindings only where it contributes SQL.
  const preludeBindings = additivePreludeBindings(route, expression, query)

  const sql = `WITH ${additivePreludeCtes(route)}candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        ${markedTextSql(route, 'pd', 'persisted_docs')} AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      ${candidateSourceSql(route, 'pd')}
      WHERE ${persistedPredicate}
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        ${markedTextSql(route, 'ld', 'live_docs')} AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      ${candidateSourceSql(route, 'ld')}${liveWhere}
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`

  const params = union
    ? [
      ...preludeBindings,
      ...markedTextBindings(route, query),
      visible,
      // The live branch's `persisted` projection reads the same visibility flag, so
      // the statement consumes it once here, exactly as the other routes do.
      visible,
      ...markedTextBindings(route, query),
      FTS_HIGHLIGHT_START,
      markerBytes,
    ]
    : [
      ...preludeBindings,
      ...markedTextBindings(route, query),
      // The persisted branch consumes the phrase and then the visibility flag; the
      // live branch consumes only the phrase, and its `persisted` projection reads the
      // same flag through the `visible` binding below. Both are ordered as the SQL
      // reads them.
      ...candidatePredicateBindings(route, false, expression, visible, likePattern),
      visible,
      ...markedTextBindings(route, query),
      ...candidatePredicateBindings(route, true, expression, visible, likePattern),
      FTS_HIGHLIGHT_START,
      markerBytes,
    ]
  assertStatementArity(sql, params)
  return { sql, params }
}

/**
 * Refuse a candidate statement whose placeholders and bindings disagree.
 *
 * Every route lists its bindings explicitly rather than deriving them positionally, so a
 * route that consumes the visibility flag a different number of times than its predicate
 * contributes is exactly the mistake this catches. Without it the mismatch is silent:
 * SQLite binds the extra placeholder to NULL and the route returns no rows at all, which
 * reads like a recall bug rather than a wiring bug. Exported so the regression can be
 * pinned directly instead of only through a route that happens to expose it.
 * @param sql - the complete candidate statement.
 * @param params - the bindings the statement will be executed with.
 * @returns nothing; the statement is rejected when the counts disagree.
 */
export function assertStatementArity(sql: string, params: readonly (string | number)[]): void {
  const placeholders = (sql.match(/\?/g) ?? []).length
  if (placeholders !== params.length) {
    throw new SessionQueryError(
      `session-search candidate statement arity mismatch: ${placeholders} placeholders but ${params.length} bindings`,
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
}

function observeLive(session: Session): ObservedSession {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
}

function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || first.revision !== second.revision
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionIds(
  before: ReadonlySet<SessionId>,
  after: ReadonlyMap<SessionId, ObservedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const id of before) {
    if (!after.has(id)) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine
