/**
 * Developer toolbox sidebar trigger: the footer action above Settings. Icon-only
 * 🧰 in the 56px rail, icon plus label in the wide column; toggles the shared
 * panel open state.
 */

import type { ToolboxTriggerProps } from './contract.ts'
import css from './ToolboxPanel.module.css'

/**
 * Render the sidebar foot trigger for the developer toolbox.
 * @param props - composed slot props.
 * @returns the trigger button.
 */
export function ToolboxTrigger({ wide, useToolboxUi, toggle, t }: ToolboxTriggerProps) {
  const state = useToolboxUi(snapshot => snapshot)
  const label = state.open ? t('close') : t('triggerLabel')
  return (
    <button
      type="button"
      className={wide ? css.triggerWide : css.trigger}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span className={css.icon} aria-hidden>🧰</span>
      {wide && <span className={css.label}>{t('triggerLabel')}</span>}
    </button>
  )
}
