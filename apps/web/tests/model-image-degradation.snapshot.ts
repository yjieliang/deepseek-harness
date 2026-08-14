// @vitest-environment jsdom
// Text-only model switching over an image-bearing session, over the BUILT
// client graph: the minimal assembled graph plus the model seat's plugin
// chain (input-trigger → commands → model-selection). Opens the fixture
// history session carrying the turn-72 image pair, switches its model through
// the composer seat, and pins the admitted text-only switch with its
// degradation toast — the fixture transport mirrors the host's
// `imagesDegraded` flag over its own modality table.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { ASSEMBLED_PLUGINS, installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

/** The minimal graph plus the model seat's plugin chain. */
const PLUGINS: readonly (WebBootEntry & { bundlePath: string })[] = [
  ...ASSEMBLED_PLUGINS,
  { id: '@deepseek-ai/dsh-client-ui-input-trigger', bundlePath: 'packages/client/ui-input-trigger/lib/client.js', url: '/plugins/ui-input-trigger.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale'] },
  { id: '@deepseek-ai/dsh-client-ui-commands', bundlePath: 'packages/client/ui-commands/lib/client.js', url: '/plugins/ui-commands.js', rev: 'fx', inject: ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-input-trigger', '@deepseek-ai/dsh-client-ui-conversation'] },
  { id: '@deepseek-ai/dsh-client-ui-model-selection', bundlePath: 'packages/client/ui-model-selection/lib/client.js', url: '/plugins/ui-model-selection.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-commands', '@deepseek-ai/dsh-api-remotes'] },
]

/** Open the fixture history session (the alpha log carrying the turn-72 image pair). */
async function openFixtureSession(): Promise<void> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (group === null || group === undefined) throw new Error('fixture Workspace group missing')
  if (group.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(within(group).getByText('fixture'))
    await waitFor(() => {
      expect(group.getAttribute('aria-expanded')).toBe('true')
    })
  }
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
  // The seat appears only after the session view mounts and the seat's plugin
  // chain resolves its first directory load; anchor on the history gallery
  // first (the image-display lane's readiness signal), then wait for the seat.
  await waitFor(() => {
    expect(document.querySelectorAll('[data-align] img').length).toBeGreaterThan(0)
  }, { timeout: 10_000 })
  await waitFor(() => { seatTrigger() }, { timeout: 15_000 })
}

/**
 * The seat's trigger button. jsdom's a11y-visibility computation hides the
 * composer subtree (the image-display lane's note), so the seat and its menu
 * are queried via DOM; the toast portals out and stays role-queryable.
 */
function seatTrigger(): HTMLElement {
  const button = [...document.querySelectorAll('button')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? '').startsWith('Select model'))
  if (button === undefined) throw new Error('model seat trigger missing')
  return button
}

/** Open the composer model seat and pick a model row by its visible name. */
async function chooseModel(name: string): Promise<void> {
  fireEvent.click(seatTrigger())
  const cell = await waitFor(() => {
    const found = [...document.querySelectorAll('[role="menuitem"]')]
      .find(el => el.textContent?.includes('Model'))
    if (found === undefined) throw new Error('model menu cell missing')
    return found as HTMLElement
  }, { timeout: 10_000 })
  fireEvent.click(cell)
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('[role="menuitemradio"]')]
      .find(el => el.textContent?.includes(name))
    if (found === undefined) throw new Error(`model row "${name}" missing`)
    return found as HTMLElement
  }, { timeout: 10_000 })
  fireEvent.click(row)
}

it('admits a text-only switch over an image-bearing session and announces the degradation', async () => {
  mountAssembledApp(PLUGINS)
  await openFixtureSession()

  // An image-capable target over the same history carries no notice.
  await chooseModel('GPT-5')
  await waitFor(() => {
    expect(seatTrigger().getAttribute('aria-label')).toContain('Select model, current GPT-5')
  })
  expect(screen.queryByRole('alert')).toBeNull()

  // The text-only target is admitted over the image pair; the seat names the loss.
  await chooseModel('DeepSeek-V4-Pro')
  const toast = await screen.findByRole('alert', {}, { timeout: 10_000 })
  expect(toast.textContent).toBe(
    'Model switched; it does not accept image input, so session images are replaced with placeholder text',
  )
  await waitFor(() => {
    expect(seatTrigger().getAttribute('aria-label')).toContain('Select model, current DeepSeek-V4-Pro')
  })
})
