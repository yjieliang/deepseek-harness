/**
 * Knowledge-base sidebar trigger: the footer action above Settings. Icon plus
 * label in the wide column, icon-only on the 56px rail; toggles the shared
 * panel open state.
 */

import type { KbTriggerProps } from './contract.ts'
import css from './KbTrigger.module.css'

/**
 * Render the sidebar foot trigger for the knowledge-base panel.
 * @param props - composed slot props.
 * @returns the trigger button.
 */
export function KbTrigger({ wide, useKbUi, toggle, t }: KbTriggerProps) {
  const state = useKbUi(snapshot => snapshot)
  const label = state.open ? t('trigger.close') : t('trigger.open')
  return (
    <button
      type="button"
      className={wide ? css.triggerWide : css.trigger}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span className={css.icon} aria-hidden>📚</span>
      {wide && <span className={css.label}>{t('trigger.label')}</span>}
    </button>
  )
}
