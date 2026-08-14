// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { KbDocSummary, KbStatsResult } from '@deepseek-ai/dsh-api-remotes/client'
import { KbPanel } from '../src/client/KbPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is kb ∪ common; the stub mirrors the real lookup chain.
const t: ComponentProps<typeof KbPanel>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const DOCS: KbDocSummary[] = [
  {
    path: '10-技术/2026-08-13-甲.md',
    title: '甲文档',
    summary: '甲的摘要',
    tags: ['AI'],
    status: 'filed',
    updated: '2026-08-13',
    pinned: true,
  },
  {
    path: '00-inbox/2026-08-10-乙.md',
    title: '乙文档',
    summary: '乙的摘要',
    tags: [],
    status: 'inbox',
    updated: '2026-08-10',
    pinned: false,
  },
]

const STATS: KbStatsResult = {
  total: 2,
  byStatus: { inbox: 1, filed: 1, archived: 0 },
  dirs: ['00-inbox', '10-技术', '90-归档'],
  archiveDir: '90-归档',
}

interface Props {
  panel: ReturnType<typeof makePanelProps>
}

/** Build the composed props over one shared open store, wired to vi.fn callbacks. */
function makePanelProps() {
  const store = createSnapshotStore({ open: true })
  return {
    useKbUi: ((selector: (snapshot: { open: boolean }) => { open: boolean }) =>
      selector(store.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    list: vi.fn(async () => DOCS),
    search: vi.fn(async () => ({ hits: DOCS, total: 2 })),
    get: vi.fn(async (path: string) => ({
      path,
      content: '正文内容',
      meta: { title: '甲文档', tags: ['AI'], status: 'filed' as const },
      backlinks: ['00-inbox/2026-08-10-乙.md'],
      version: 'v1',
    })),
    dirs: vi.fn(async () => ['00-inbox', '10-技术', '90-归档']),
    save: vi.fn(async () => ({ path: 'x', conflict: false })),
    create: vi.fn(async () => ({ path: '00-inbox/2026-08-15-新.md' })),
    move: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    trash: vi.fn(async () => []),
    restore: vi.fn(async () => undefined),
    purge: vi.fn(async () => undefined),
    stats: vi.fn(async () => STATS),
    tags: vi.fn(async () => [{ tag: 'AI', count: 1 }]),
    createDir: vi.fn(async () => undefined),
    renameDir: vi.fn(async () => undefined),
    assetUrl: vi.fn((path: string) => `/asset/${path}`),
    toggle: vi.fn(),
    close: vi.fn(),
    t,
  }
}

function renderPanel(panel: Props['panel']): void {
  render(<KbPanel {...panel} />)
}

afterEach(cleanup)

describe('KbPanel three-column workspace', () => {
  it('renders status navigation with counts, the directory tree, and pinned-first cards', async () => {
    const panel = makePanelProps()
    renderPanel(panel)

    expect(await screen.findByText('收集箱')).toBeTruthy()
    expect(screen.getByText('已归档')).toBeTruthy()
    expect(screen.getByText('已存档')).toBeTruthy()
    expect(screen.getByText(/10-技术/)).toBeTruthy()
    expect(screen.getByText('甲文档')).toBeTruthy()
    expect(screen.getByText('甲的摘要')).toBeTruthy()
    // The pinned document renders under the pinned group.
    expect(screen.getByText('置顶')).toBeTruthy()
    expect(panel.list).toHaveBeenCalled()
    expect(panel.stats).toHaveBeenCalled()
    expect(panel.tags).toHaveBeenCalled()
  })

  it('opens a document into the view with metadata and backlinks', async () => {
    const panel = makePanelProps()
    renderPanel(panel)

    fireEvent.click(await screen.findByText('甲文档'))
    expect(await screen.findByRole('heading', { name: '甲文档' })).toBeTruthy()
    expect(screen.getByText('正文内容')).toBeTruthy()
    expect(screen.getByText('反链（1）')).toBeTruthy()
    expect(screen.getByText(/00-inbox\/2026-08-10-乙\.md/)).toBeTruthy()
  })

  it('pins a document through the card menu', async () => {
    const panel = makePanelProps()
    renderPanel(panel)

    const cardTitle = (await screen.findAllByText('乙文档'))[0]
    const card = cardTitle?.closest<HTMLElement>('[data-kb-menu]')
    if (card === null || card === undefined) throw new Error('card container missing')
    fireEvent.click(withinCard(card))
    const pinButton = (await screen.findAllByText('置顶'))
      .find(el => el.closest('[data-kb-menu]') !== null)
    if (pinButton === undefined) throw new Error('pin menu item missing')
    fireEvent.click(pinButton)
    await waitFor(() => {
      expect(panel.save).toHaveBeenCalledWith({ path: '00-inbox/2026-08-10-乙.md', pinned: true })
    })
  })

  it('edits a document and saves through Ctrl+S path', async () => {
    const panel = makePanelProps()
    renderPanel(panel)

    fireEvent.click(await screen.findByText('甲文档'))
    fireEvent.click(await screen.findByText('编辑'))
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('editor textarea missing')
    fireEvent.change(textarea, { target: { value: '修改后的正文' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(panel.save).toHaveBeenCalledWith({ path: '10-技术/2026-08-13-甲.md', content: '修改后的正文' })
    })
  })

  it('shows the search total and routes a query through search', async () => {
    const panel = makePanelProps()
    renderPanel(panel)

    const input = await screen.findByPlaceholderText('搜索知识库…')
    fireEvent.change(input, { target: { value: '甲' } })
    await waitFor(() => {
      expect(panel.search).toHaveBeenCalledWith('甲')
      expect(screen.getByText('共 2 条')).toBeTruthy()
    })
  })
})

/** The card's ⋯ menu button. */
function withinCard(card: HTMLElement | null): HTMLElement {
  const button = card?.querySelector<HTMLElement>('button[aria-label="⋯"]')
  if (button === null || button === undefined) throw new Error('card menu button missing')
  return button
}
