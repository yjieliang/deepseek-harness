/** General-settings row for the harness home (DSH_HOME): shows where data lives, and lets a person set the next-boot override. */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BootHomeController, BootHomeState, BootHomeSource } from './boot-home-controller.ts'
import type { SettingsKey } from './locales.ts'
import css from './BootHomeRow.module.css'

/** Registrant-owned dependencies of {@link BootHomeRow}. */
export interface BootHomeRowInjected {
  /** State owner: the resolved home plus the next-boot override actions. */
  controller: BootHomeController
  /** Bound selector hook for the controller snapshot. */
  useSnapshot: SnapshotSelectorHook<BootHomeState>
}

/** General-item owner share, localized copy, and the registrant's state face. */
export type BootHomeRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & BootHomeRowInjected

/** Localized source label. */
function sourceText(source: BootHomeSource, t: (key: SettingsKey) => string): string {
  switch (source) {
    case 'default': return t('bootHome.source.default')
    case 'env': return t('bootHome.source.env')
    case 'boot-file': return t('bootHome.source.file')
    case 'configured': return t('bootHome.source.configured')
  }
}

/**
 * Render the harness-home row: the resolved home and its source, an editor
 * for the next boot, and the save/clear actions.
 * @param props - general-item owner props, localized copy, and injected state.
 * @returns the row, or null before the host answers.
 */
export function BootHomeRow({ controller, useSnapshot, t }: BootHomeRowProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  useEffect(() => {
    void controller.load()
  }, [controller])

  if (state.status === 'loading' || state.status === 'idle') return null
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const detail = state.error ?? ''
    return (
      <div className={css.row}>
        <p className={css.error} role="alert">{`${t('bootHome.error')} ${detail}`}</p>
        <button type="button" className={css.ghost} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const saveDisabled = state.saving || state.draft.trim() === state.home
  return (
    <div className={css.row}>
      <label className={css.label} htmlFor="boot-home-input">
        <span className={css.title}>{t('bootHome.label')}</span>
        <span className={css.current}>
          {t('bootHome.current')} {state.home} · {sourceText(state.source, t)}
        </span>
      </label>
      <input
        id="boot-home-input"
        className={css.input}
        value={state.draft}
        spellCheck={false}
        placeholder={t('bootHome.placeholder')}
        onChange={(event) => { controller.setDraft(event.target.value) }}
      />
      <div className={css.actions}>
        <button
          type="button"
          className={css.primary}
          disabled={saveDisabled}
          onClick={() => { void controller.save() }}
        >
          {t('bootHome.save')}
        </button>
        <button
          type="button"
          className={css.ghost}
          disabled={state.saving}
          onClick={() => { void controller.clear() }}
        >
          {t('bootHome.clear')}
        </button>
      </div>
      {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
      {state.saved === 'env-wins'
        ? <p className={css.hint} role="status">{t('bootHome.envWins')}</p>
        : state.saved === 'saved-restart'
          ? <p className={css.hint} role="status">{t('bootHome.saved-restart')}</p>
          : state.saved === 'cleared-restart'
            ? <p className={css.hint} role="status">{t('bootHome.cleared-restart')}</p>
            : null}
      <p className={css.hint}>{t('bootHome.restartHint')}</p>
    </div>
  )
}
