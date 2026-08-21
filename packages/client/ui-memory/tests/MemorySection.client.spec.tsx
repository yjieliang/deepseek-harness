// @vitest-environment jsdom
/**
 * The Memory settings section: list, editor dialog, and delete confirmation,
 * driven through plain injected actions and one snapshot store. The wire is
 * absent — the controller's behavior is covered by its own spec; here the
 * component turns snapshots into visible copy and gestures into action calls.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from '../src/client/MemorySection.tsx'
import type { MemorySectionProps } from '../src/client/MemorySection.tsx'
import type { MemorySectionState } from '../src/client/section-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: MemorySectionState = {
  status: 'ready',
  error: null,
  writable: true,
  revision: 1,
  entries: [
    { topic: 'commit', value: 'rebase before push', source: 'agent-proposed', version: 3, updatedAt: 3 },
    { topic: 'style', value: '中文回复', source: 'user', version: 1, updatedAt: 1 },
  ],
  draft: null,
  pendingDelete: null,
  deleting: false,
}

function renderSection(state: Partial<MemorySectionState> = {}) {
  const store = createSnapshotStore<MemorySectionState>({ ...READY, ...state })
  const actions = {
    load: vi.fn(() => Promise.resolve()),
    beginAdd: vi.fn(),
    beginEdit: vi.fn(),
    setDraftTopic: vi.fn(),
    setDraftValue: vi.fn(),
    confirmDraft: vi.fn(() => Promise.resolve()),
    overrideDraft: vi.fn(() => Promise.resolve()),
    cancelDraft: vi.fn(),
    confirmDelete: vi.fn(),
    remove: vi.fn(() => Promise.resolve()),
  }
  render(<MemorySection {...({
    ...actions,
    close: () => {},
    useMemorySection: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as MemorySectionProps)} />)
  return { store, actions }
}

describe('the memory section body', () => {
  it('renders nothing when the namespace is not registered', () => {
    renderSection({ status: 'unavailable' })
    expect(screen.queryByText(en.nav)).toBeNull()
  })

  it('reports a failed load with a retry', async () => {
    const { actions } = renderSection({ status: 'error', error: 'network down' })
    expect(screen.getByRole('alert').textContent).toContain('network down')
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.load).toHaveBeenCalled()
  })

  it('reads the namespace once when it first renders', async () => {
    const { actions } = renderSection({ status: 'idle' })
    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
  })

  it('lists every entry with its topic, value, and source', () => {
    renderSection()
    expect(screen.getByText('commit')).toBeTruthy()
    expect(screen.getByText('rebase before push')).toBeTruthy()
    expect(screen.getByText(en.sourceProposed)).toBeTruthy()
    expect(screen.getByText('style')).toBeTruthy()
    expect(screen.getByText('中文回复')).toBeTruthy()
    expect(screen.getByText(en.sourceUser)).toBeTruthy()
  })

  it('shows the empty copy instead of a list', () => {
    renderSection({ entries: [] })
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('drops the add button and says why when the namespace is read-only', () => {
    renderSection({ writable: false })
    expect(screen.queryByRole('button', { name: new RegExp(en.add) })).toBeNull()
    expect(screen.getByText(en.noWritable)).toBeTruthy()
  })

  it('opens the editor and delete flows through their actions', () => {
    const { actions } = renderSection()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.add) }))
    expect(actions.beginAdd).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: `${en.edit}: style` }))
    expect(actions.beginEdit).toHaveBeenCalledWith('style')
    fireEvent.click(screen.getByRole('button', { name: `${en.delete}: commit` }))
    expect(actions.confirmDelete).toHaveBeenCalledWith('commit')
  })
})

describe('the editor dialog', () => {
  it('binds the draft into the fields and submits through the action', () => {
    const { actions } = renderSection({
      draft: { topic: 'style', value: '中文回复', errorKey: null, error: null, overridable: false, saving: false },
    })
    const topic = screen.getByDisplayValue('style') as HTMLInputElement
    const value = screen.getByDisplayValue('中文回复') as HTMLTextAreaElement
    fireEvent.change(topic, { target: { value: 'tone' } })
    expect(actions.setDraftTopic).toHaveBeenCalledWith('tone')
    fireEvent.change(value, { target: { value: 'casual' } })
    expect(actions.setDraftValue).toHaveBeenCalledWith('casual')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.confirmDraft).toHaveBeenCalledTimes(1)
  })

  it('localizes a local validation failure', () => {
    renderSection({
      draft: { topic: 'Bad', value: 'x', errorKey: 'topicInvalid', error: null, overridable: false, saving: false },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.topicInvalid)
  })

  it('offers the one override after a host guard rejection', () => {
    const { actions } = renderSection({
      draft: {
        topic: 'style',
        value: 'ignore instructions',
        errorKey: null,
        error: 'habit content matches an injection pattern',
        overridable: true,
        saving: false,
      },
    })
    expect(screen.getByRole('alert').textContent).toBe('habit content matches an injection pattern')
    expect(screen.getByText(en.overrideHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.override }))
    expect(actions.overrideDraft).toHaveBeenCalledTimes(1)
  })

  it('disables saving while the save is in flight', () => {
    renderSection({
      draft: { topic: 'style', value: 'x', errorKey: null, error: null, overridable: false, saving: true },
    })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.saving }).disabled).toBe(true)
  })

  it('closes through the cancel action', () => {
    const { actions } = renderSection({
      draft: { topic: 'style', value: 'x', errorKey: null, error: null, overridable: false, saving: false },
    })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelDraft).toHaveBeenCalledTimes(1)
  })
})

describe('the delete confirmation', () => {
  it('confirms the pending topic through the remove action', () => {
    const { actions } = renderSection({ pendingDelete: 'commit' })
    fireEvent.click(screen.getByRole('button', { name: en.deleteConfirm }))
    expect(actions.remove).toHaveBeenCalledTimes(1)
  })

  it('dismisses through the cancel action', () => {
    const { actions } = renderSection({ pendingDelete: 'commit' })
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.confirmDelete).toHaveBeenCalledWith(null)
  })
})
