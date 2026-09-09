/**
 * The knowledge-base `@` trigger source: one menu group behind the unified
 * input-trigger pipeline, listing library documents by title/path prefix
 * against `kb.list` (BM25 body recall would suggest every document containing
 * the query text, which is the wrong shape for input completion). A pick
 * inserts an atomic `@kb:<path>` mention; the transcript maps `@kb:` tokens
 * back to the `kb` appearance through the appearance registry.
 */
import type { KbDocSummary } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerSource, ReferenceAppearance,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { KbKey } from './locales.ts'

type Translate = (key: KbKey) => string

/** List call the source issues per query, cancellable by the request signal. */
export type KbDocLister = (signal: AbortSignal) => Promise<KbDocSummary[]>

/** Menu group name; unique per trigger — the composer picks route back through it. */
export const KB_SOURCE_NAME = 'knowledge-base'

/** The appearance kind this source inserts and renders through the reference-glyph chain slots. */
export const KB_APPEARANCE: ReferenceAppearance = 'kb'

/** Candidate cap: completion lists stay bounded regardless of library size. */
const MAX_CANDIDATES = 20

/** One candidate's opaque pick payload. */
interface KbCandidateValue {
  kind: 'kb'
  label: string
  mention: string
}

/**
 * Build the knowledge-base trigger source over one list closure.
 * @param listDocs - the cancellable `kb.list` projection.
 * @param t - the plugin's bound translate.
 * @returns the source; register it through `ctx.inputTriggers.registerSource`.
 */
export function createKbReferenceSource(listDocs: KbDocLister, t: Translate): InputTriggerSource {
  return {
    trigger: '@',
    name: KB_SOURCE_NAME,
    order: 1,
    showGroupTitle: false,
    async candidates(_session: ClientSessionContext, { query, quoted, signal }) {
      // A quoted token is an open @file path: the kb domain never contributes.
      if (quoted === true) return []
      const docs = await listDocs(signal).then(docs => docs, () => [])
      if (signal.aborted) return []
      return kbCandidates(docs, query, t)
    },
    onPick({ candidate }) {
      const value = parseCandidate(candidate.value)
      if (value === undefined) return undefined
      return {
        insert: {
          source: KB_SOURCE_NAME,
          ref: value.mention,
          label: value.label,
          appearance: KB_APPEARANCE,
          clipboardText: value.mention,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
}

/** Format a document path as an `@kb:` mention, mirroring the file mention's quote rules. */
function formatKbMention(path: string): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  return /\s/u.test(path) ? `@kb:"${path}"` : `@kb:${path}`
}

/** Filter the document list by title/path prefix and turn hits into reference candidates. */
function kbCandidates(docs: readonly KbDocSummary[], query: string, t: Translate): InputTriggerCandidate[] {
  const searchQuery = query.startsWith('kb:') ? query.slice(3) : query
  const needle = searchQuery.trim().toLowerCase()
  const hit = needle.length === 0
    ? docs
    : docs.filter(doc =>
      doc.title.toLowerCase().includes(needle) || doc.path.toLowerCase().includes(needle))
  return hit.slice(0, MAX_CANDIDATES).flatMap((doc): InputTriggerCandidate[] => {
    const mention = formatKbMention(doc.path)
    if (mention === undefined) return []
    const value: KbCandidateValue = { kind: 'kb', label: doc.title, mention }
    return [{
      name: `${t('reference.candidate')} · ${doc.title}`,
      description: doc.path,
      section: t('reference.section'),
      value: JSON.stringify(value),
    }]
  })
}

function parseCandidate(value: string | undefined): KbCandidateValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(value) as KbCandidateValue
}
