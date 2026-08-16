/**
 * Memory settings section: the list of global user habits plus an editor
 * dialog (add or edit one entry) and a delete confirmation. Everything reads
 * through the injected controller; the section itself holds no data.
 *
 * The namespace's own validation stays on the host: a save the host refuses
 * shows the host's text on the dialog, and a guard rejection offers one
 * "save anyway" — the human confirmation the guard exists to require.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconEditOutline16, IconPlusOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryDraft, MemorySectionState } from './section-store.ts'
import type { MemorySettingsKey } from './locales.ts'
import css from './MemorySection.module.css'

/** Registration-side business face for the memory section. */
export interface MemorySectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useMemorySection. */
    memorySection: SnapshotStore<MemorySectionState>
  }
  /** Read the namespace; called once when the section first renders. */
  load: () => Promise<void>
  /** Open the editor over a fresh entry. */
  beginAdd: () => void
  /** Open the editor over one committed entry. */
  beginEdit: (topic: string) => void
  /** Type the draft topic. */
  setDraftTopic: (topic: string) => void
  /** Type the draft value. */
  setDraftValue: (value: string) => void
  /** Submit the draft. */
  confirmDraft: () => Promise<void>
  /** Re-submit after a guard rejection, persisting the confirmation. */
  overrideDraft: () => Promise<void>
  /** Close the editor, discarding the draft. */
  cancelDraft: () => void
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (topic: string | null) => void
  /** Delete the entry awaiting confirmation. */
  remove: () => Promise<void>
}

/** Full component props. */
export type MemorySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.memory'>
  & InjectFace<MemorySectionInjected>

/** Editor dialog props: the draft plus the actions that mutate it. */
interface DraftDialogProps {
  draft: MemoryDraft | null
  /** Whether the draft targets a committed topic (true = edit). */
  editing: boolean
  t: (key: MemorySettingsKey) => string
  actions: Pick<MemorySectionInjected,
    'cancelDraft' | 'confirmDraft' | 'overrideDraft' | 'setDraftTopic' | 'setDraftValue'>
}

/** The editor dialog: topic, value, and the failure paths of a save. */
function DraftDialog({ draft, editing, t, actions }: DraftDialogProps): ReactNode {
  const message = draft === null
    ? null
    : draft.errorKey !== null ? t(draft.errorKey) : draft.error
  return (
    <Modal
      open={draft !== null}
      onClose={() => { actions.cancelDraft() }}
      title={draft === null ? t('addTitle') : editing ? t('editTitle') : t('addTitle')}
      closeLabel={t('close')}
      description={draft === null ? t('addIntro') : editing ? t('editIntro') : t('addIntro')}
      className={css.dialog as string}
      footer={(
        <>
          <Button
            variant="outline"
            disabled={draft?.saving === true}
            onClick={() => { actions.cancelDraft() }}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={draft === null || draft.saving}
            onClick={() => { void actions.confirmDraft() }}
          >
            {draft?.saving === true ? t('saving') : t('save')}
          </Button>
        </>
      )}
    >
      {draft === null
        ? null
        : (
          <div className={css.dialogFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('topic')}</span>
              <input
                className={css.input}
                value={draft.topic}
                autoFocus
                spellCheck={false}
                placeholder={t('topicPlaceholder')}
                onChange={(event) => { actions.setDraftTopic(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('value')}</span>
              <textarea
                className={css.textarea}
                value={draft.value}
                rows={5}
                spellCheck={false}
                placeholder={t('valuePlaceholder')}
                onChange={(event) => { actions.setDraftValue(event.target.value) }}
              />
            </label>
            {message === null ? null : <p className={css.error} role="alert">{message}</p>}
            {draft.error !== null && draft.overridable
              ? (
                <p className={css.overrideHint}>
                  {t('overrideHint')}
                  <button
                    type="button"
                    className={css.overrideButton}
                    onClick={() => { void actions.overrideDraft() }}
                  >
                    {t('override')}
                  </button>
                </p>
              )
              : null}
          </div>
        )}
    </Modal>
  )
}

/**
 * Render the Memory settings section content column.
 * @param props - composed slot props.
 * @returns the section, or null when the deployment has no habits namespace.
 */
export function MemorySection(props: MemorySectionProps): ReactNode {
  const { useMemorySection, t, load } = props
  const state = useMemorySection(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'unavailable') return null
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const detail = state.error ?? ''
    return (
      <div className={css.section}>
        <p className={css.error} role="alert">{`${t('error')} ${detail}`}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const draft = state.draft
  const editing = draft !== null && state.entries.some(entry => entry.topic === draft.topic)

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
      {state.writable
        ? (
          <div className={css.actions}>
            <Button
              variant="outline"
              disabled={draft !== null}
              onClick={() => { props.beginAdd() }}
            >
              <IconPlusOutline16 size={14} />
              {t('add')}
            </Button>
          </div>
        )
        : <p className={css.intro}>{t('noWritable')}</p>}
      {state.entries.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : (
          <ul className={css.cards}>
            {state.entries.map(entry => (
              <li key={entry.topic} className={css.card}>
                <div className={css.cardHead}>
                  <code className={css.cardTopic}>{entry.topic}</code>
                  <span className={css.badge}>
                    {entry.source === 'agent-proposed' ? t('sourceProposed') : t('sourceUser')}
                  </span>
                </div>
                <p className={css.cardValue}>{entry.value}</p>
                {state.writable
                  ? (
                    <div className={css.cardFoot}>
                      <button
                        type="button"
                        className={css.iconButton}
                        data-tip={t('edit')}
                        aria-label={`${t('edit')}: ${entry.topic}`}
                        onClick={() => { props.beginEdit(entry.topic) }}
                      >
                        <IconEditOutline16 />
                      </button>
                      <button
                        type="button"
                        className={`${css.iconButton} ${css.iconDanger}`}
                        data-tip={t('delete')}
                        aria-label={`${t('delete')}: ${entry.topic}`}
                        onClick={() => { props.confirmDelete(entry.topic) }}
                      >
                        <IconTrashOutline16 />
                      </button>
                    </div>
                  )
                  : null}
              </li>
            ))}
          </ul>
        )}
      <DraftDialog
        draft={draft}
        editing={editing}
        t={t}
        actions={{
          cancelDraft: props.cancelDraft,
          confirmDraft: props.confirmDraft,
          overrideDraft: props.overrideDraft,
          setDraftTopic: props.setDraftTopic,
          setDraftValue: props.setDraftValue,
        }}
      />
      <Modal
        open={state.pendingDelete !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { props.confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void props.remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory section copy. */
    'settings.memory': MemorySettingsKey
  }
}
