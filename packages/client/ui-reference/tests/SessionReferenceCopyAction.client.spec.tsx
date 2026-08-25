// @vitest-environment jsdom
/**
 * Session-reference copy action: the session-header button writes this
 * session's canonical mention to the clipboard, shows one-shot success
 * feedback, and refuses to claim success when the host declines the write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference/grammar'
import { SessionReferenceCopyAction, type SessionReferenceCopyActionProps } from '../src/client/SessionReferenceCopyAction.tsx'
import { zh } from '../src/client/locales.ts'

const SESSION = 'session-42' as SessionId
const t: SessionReferenceCopyActionProps['t'] = makeTranslate(zh)

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function props(title: string | undefined): SessionReferenceCopyActionProps {
  const state = {
    ids: [SESSION],
    byId: title === undefined ? {} : { [SESSION]: { id: SESSION, title } },
    current: SESSION,
  } as unknown as SessionListState
  function useSessions<T>(select: (snapshot: SessionListState) => T): T {
    return select(state)
  }
  return { sessionId: SESSION, useSessions, t } as unknown as SessionReferenceCopyActionProps
}

describe('SessionReferenceCopyAction', () => {
  it('renders the copy-reference button with its accessible name', () => {
    render(<SessionReferenceCopyAction {...props('My title')} />)
    expect(screen.getByRole('button', { name: zh['copy.aria'] })).toBeDefined()
  })

  it('writes the canonical mention once per feedback window', async () => {
    render(<SessionReferenceCopyAction {...props('My title')} />)
    const button = screen.getByRole('button', { name: zh['copy.aria'] })
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(formatSessionReferenceMention({ sessionId: SESSION, label: 'My title' }))

    // A second click inside the feedback window is a guarded no-op.
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledTimes(1)

    // After the window, a fresh click copies again.
    act(() => { vi.advanceTimersByTime(1_000) })
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('falls back to the session id as the mention label without a title', async () => {
    render(<SessionReferenceCopyAction {...props(undefined)} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['copy.aria'] }))
    })
    expect(writeText).toHaveBeenCalledWith(formatSessionReferenceMention({ sessionId: SESSION }))
  })

  it('stays re-clickable when the host declines the write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<SessionReferenceCopyAction {...props('My title')} />)
    const button = screen.getByRole('button', { name: zh['copy.aria'] })
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledTimes(1)
    // No success feedback, so no guard: the next click retries.
    await act(async () => { fireEvent.click(button) })
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('clears the pending feedback timer on unmount', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { unmount } = render(<SessionReferenceCopyAction {...props('My title')} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['copy.aria'] }))
    })
    unmount()
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })
})
