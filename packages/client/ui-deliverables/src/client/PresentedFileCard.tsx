/** File identity, Sidebar preview, copy-path control, and contributed native actions for one delivery. */
import { useCallback, useState, type ReactNode } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  FileTypeIcon, fileExtension, IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PresentedHost } from '../presented.ts'
import { PRESENTED_SUCCESS_HOLD_MS, PRESENTED_SUCCESS_FADE_MS, type PresentedOpenPhase } from './present-open.ts'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

/** How long the copied check stays in place after a successful path write, in ms. */
const COPY_FEEDBACK_MS = 1000

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * The copy control writes the file's resolved absolute path; it stays available
 * without a Host desktop, unlike the contributed native actions.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, host, onPreview, actions, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: PresentedOpenPhase | undefined
  host: PresentedHost | null
  onPreview: () => void
  actions: ReactNode
} & PropsLocale<typeof NS>) {
  const succeeded = phase === 'opened' || phase === 'revealed'
  const reveal = host?.fileManager ?? 'directory'
  const name = basename(file.path)
  const location = resolveWorkspacePath(cwd, file.path)
  const metadata = fileExtension(name).toUpperCase() || t('presented.file')
  const [copied, setCopied] = useState(false)
  const copyLocation = useCallback(() => {
    if (copied) return
    void writeClipboard(location).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, COPY_FEEDBACK_MS)
    })
  }, [copied, location])
  const status = phase === undefined
    ? cardDescription(file.description, metadata)
    : t(reveal === 'directory' && phase === 'revealed' ? 'presented.directoryOpened'
      : reveal === 'directory' && phase === 'revealing' ? 'presented.directoryOpening'
        : reveal === 'directory' && phase === 'revealError' ? 'presented.directoryError' : `presented.${phase}`)
  return <div className={css.file} data-presented-file>
    <button type="button" className={css.cardPreview} title={location}
      aria-label={t('presented.previewCard', { name: file.path })} onClick={onPreview} />
    <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
    <div className={css.fileBody}>
      <div className={css.details}>
        <span className={css.fileName}>{name}</span>
        <span className={css.description} data-presented-description role={phase === undefined ? undefined : 'status'}
          data-error={phase === 'error' || phase === 'revealError' || phase === 'nativeUnavailable' ? true : undefined}>
          <span className={css.secondaryText} data-success={succeeded || undefined}
            style={succeeded ? { animationDelay: `${PRESENTED_SUCCESS_HOLD_MS}ms`, animationDuration: `${PRESENTED_SUCCESS_FADE_MS}ms` } : undefined}>
            {status}
          </span>
          <span className={css.previewHint}>{t('presented.preview')}</span>
        </span>
      </div>
      <div className={css.actions}>
        <Tooltip label={copied ? t('copied') : t('presented.copyPath')} side="bottom">
          <button type="button" className={css.iconAction} data-presented-copy
            aria-label={copied ? t('copied') : t('presented.copyPath')} onClick={copyLocation}>
            {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
          </button>
        </Tooltip>
        {actions}
      </div>
    </div>
  </div>
}
