/**
 * The copy-name action: a `sidebar.workspaces.session.menu.item` row that puts
 * the row's Session name on the clipboard. The write and its notice live in
 * the injected callback, because the row unmounts with the menu it dismissed.
 */
import { IconCopyOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CopySessionNameInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 250): copy the Session name. A Session without a name has
 * nothing to copy, so the row is absent — the hover card withholds the same
 * copy rather than writing a localized placeholder.
 * @param props - owner share, the copy share, and the menu open state.
 * @returns the row, or null for a nameless Session.
 */
export function CopySessionNameMenuItem(props: SessionMenuItemProps<CopySessionNameInjected>) {
  const { displayTitle, useMenuOpenState, copySessionName, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  if (displayTitle.trim() === '') return null
  return (
    <MenuItemButton
      icon={<IconCopyOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        copySessionName(displayTitle)
      }}
    >
      {t('menu.copySessionName')}
    </MenuItemButton>
  )
}
