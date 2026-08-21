/**
 * Knowledge-base sidebar trigger: the footer action above Settings. Icon plus
 * label and a document-count badge in the wide column, icon-only on the 56px
 * rail; toggles the shared panel open state.
 */

import { useEffect, useState } from 'react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KbTriggerProps } from './contract.ts'
import css from './KbTrigger.module.css'

/**
 * Render the sidebar foot trigger for the knowledge-base panel.
 * @param props - composed slot props.
 * @returns the trigger button.
 */
export function KbTrigger({ wide, useKbUi, toggle, t, stats }: KbTriggerProps) {
  const state = useKbUi(snapshot => snapshot)
  const [count, setCount] = useState<number | null>(null)

  // Refresh the document count once on mount; a failed read just hides the
  // badge rather than blocking the trigger. Inject callbacks are stable per
  // registration, so this runs once per mount.
  useEffect(() => {
    let alive = true
    void stats().then((result) => {
      if (alive) setCount(result.total)
    }).catch(() => {
      if (alive) setCount(null)
    })
    return () => { alive = false }
  }, [])

  const label = state.open ? t('trigger.close') : t('trigger.open')
  return (
    <button
      type="button"
      className={wide ? css.triggerWide : css.trigger}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span className={css.icon} aria-hidden><IconDataOutline16 size={16} /></span>
      {wide && <span className={css.label}>{t('trigger.label')}</span>}
      {wide && count !== null && <span className={css.count}>{count}</span>}
    </button>
  )
}
