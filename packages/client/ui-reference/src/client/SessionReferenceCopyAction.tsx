/**
 * Session-header "copy reference" utility.
 *
 * Copies this session's canonical `@[label](dsh-session:…)` mention so it can
 * be pasted into another session's prompt and resolved there by the
 * session-reference service. The mention is formatted with the shared
 * browser-safe grammar, so the encoding authority stays with the Host package.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconCheckOutline16, IconCopyOutline16, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header utilities).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference/grammar'
import { NS } from './locales.ts'
import css from './SessionReferenceCopyAction.module.css'

/** How long the success check stays visible after an accepted write, in ms. */
const COPIED_FEEDBACK_MS = 1000

/** Full props for the session-header copy-reference utility. */
export type SessionReferenceCopyActionProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

/**
 * Render the copy-reference button and its one-second success feedback.
 * @param props - session-scoped runtime kit and the localized copy.
 * @returns the icon button that writes this session's mention to the clipboard.
 */
export function SessionReferenceCopyAction({ sessionId, useSessions, t }: SessionReferenceCopyActionProps) {
  const title = useSessions(state => state.byId[sessionId]?.title)
  const mention = formatSessionReferenceMention({
    sessionId,
    ...(title === undefined ? {} : { label: title }),
  })
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A still-pending feedback timer must not fire into an unmounted control.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(mention).then((accepted) => {
      if (!accepted) return
      setCopied(true)
      timerRef.current = setTimeout(() => { setCopied(false) }, COPIED_FEEDBACK_MS)
    })
  }, [copied, mention])

  return (
    <button
      type="button"
      className={css.button}
      aria-label={t('copy.aria')}
      title={t('copy.aria')}
      onClick={onCopy}
    >
      {copied ? <IconCheckOutline16 className={css.done} /> : <IconCopyOutline16 />}
    </button>
  )
}
