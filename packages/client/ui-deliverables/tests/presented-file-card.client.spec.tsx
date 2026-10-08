// @vitest-environment jsdom
/** Explicit file actions preserve their destination, availability, and independent failure state. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { PresentedFileCard } from '../src/client/PresentedFileCard.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Install a replaceable browser clipboard and hand back the undo. */
function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

/** Settle writeClipboard's own await, then the .then that lands the success chrome. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const props = () => ({
  cwd: undefined,
  file: { path: 'out/report.pdf', description: 'Final report', seq: 4, index: 1 },
  host: { name: 'remote-desktop', available: true, fileManager: 'finder' as const },
  phase: undefined,
  onPreview: vi.fn(),
  actions: <button type="button">Native file action</button>,
  t: makeTranslate(en, commonEn),
})
it('localizes reveal failures and accurately reports a directory-only action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase="revealError" t={makeTranslate(zh)} />)
  expect(view.getByText(zh['presented.revealError'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(en['presented.directoryOpened'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(view.getByText(en['presented.revealed'])).toBeTruthy()
})


it('shows the basename while retaining the full location for hover and actions', () => {
  const p = props()
  const path = '/work/reports/result.pdf'
  const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path }} />)
  expect(view.getByTitle(path)).toBeTruthy()
  expect(view.getByText('result.pdf')).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} cwd="/work" />)
  expect(view.getByTitle('/work/out/report.pdf')).toBeTruthy()
  expect(view.getByText('report.pdf')).toBeTruthy()
})

it.each([
  ['Quarterly summary (.pdf)', 'Quarterly summary'],
  ['季度总结（PDF）', '季度总结'],
] as const)('omits a trailing parenthesized file suffix from %s', (description, expected) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, description }} />)
  expect(view.getByText(expected)).toBeTruthy()
  expect(view.queryByText(description)).toBeNull()
})


it.each([en, zh])('distinguishes directory-only progress and errors in each locale', (dictionary) => {
  const p = { ...props(), t: makeTranslate(dictionary) }
  const view = render(<PresentedFileCard {...p} phase="revealing" />)
  expect(view.getByText(dictionary['presented.revealing'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealing" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryOpening'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealError" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryError'])).toBeTruthy()
})


it('renders the supplied action independently from the card preview', () => {
  const p = props()
  const native = vi.fn()
  const view = render(<PresentedFileCard {...p} actions={<button type="button" onClick={native}>Native file action</button>} />)
  fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
  expect(native).toHaveBeenCalledOnce()
  expect(p.onPreview).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledOnce()
})

it('copies the resolved absolute path, confirms once, and restores the control', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const restoreClipboard = installClipboard(writeText)
  try {
    const p = props()
    const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path: 'out/report.pdf' }} />)
    fireEvent.click(view.getByRole('button', { name: en['presented.copyPath'] }))
    expect(writeText).toHaveBeenCalledWith('/work/out/report.pdf')
    await settle()
    // A second activation inside the confirmation window neither re-copies nor stacks a timer.
    fireEvent.click(view.getByRole('button', { name: commonEn.copied }))
    expect(writeText).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(view.getByRole('button', { name: en['presented.copyPath'] })).toBeTruthy()
  } finally {
    restoreClipboard()
    vi.useRealTimers()
  }
})

it('keeps the copy control on the copy label when the clipboard refuses the write', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
  const restoreClipboard = installClipboard(writeText)
  try {
    const p = props()
    const view = render(<PresentedFileCard {...p} cwd={'C:\\work'} file={{ ...p.file, path: 'out\\report.pdf' }} />)
    fireEvent.click(view.getByRole('button', { name: en['presented.copyPath'] }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('C:\\work\\out\\report.pdf')
    expect(view.getByRole('button', { name: en['presented.copyPath'] })).toBeTruthy()
  } finally {
    restoreClipboard()
  }
})
