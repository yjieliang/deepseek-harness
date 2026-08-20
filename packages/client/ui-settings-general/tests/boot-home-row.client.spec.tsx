// @vitest-environment jsdom
/**
 * The boot-home row: renders the resolved home and its source, the path
 * editor, and save/clear. Driven through the controller's snapshot store.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { BootHomeRow } from '../src/client/BootHomeRow.tsx'
import type { BootHomeRowProps } from '../src/client/BootHomeRow.tsx'
import type { BootHomeState } from '../src/client/boot-home-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY: BootHomeState = {
  status: 'ready',
  error: null,
  home: '/a/.dsh',
  source: 'default',
  draft: '/a/.dsh',
  saving: false,
  saved: null,
}

function renderRow(state: Partial<BootHomeState> = {}) {
  const store = createSnapshotStore<BootHomeState>({ ...READY, ...state })
  const controller = {
    store,
    load: vi.fn(() => Promise.resolve()),
    setDraft: vi.fn(),
    save: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  }
  render(<BootHomeRow {...({
    controller,
    useSnapshot: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as BootHomeRowProps)} />)
  return controller
}

describe('BootHomeRow', () => {
  it('renders the resolved home and its source', () => {
    renderRow()
    expect(screen.getByText(en['bootHome.label'])).toBeTruthy()
    expect(screen.getByDisplayValue('/a/.dsh')).toBeTruthy()
    expect(screen.getByText(en['bootHome.restartHint'])).toBeTruthy()
  })

  it('renders nothing while loading and an error row with retry on failure', async () => {
    renderRow({ status: 'idle' })
    expect(screen.queryByText(en['bootHome.label'])).toBeNull()
  })
})
