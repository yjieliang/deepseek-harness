// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import { ToolboxPanel } from '../src/client/ToolboxPanel.tsx'
import { zh } from '../src/client/locales.ts'

/** Stub the translate function over zh copy; keys outside the surface fall through. */
const t: ComponentProps<typeof ToolboxPanel>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_m, name: string) => name in params ? String(params[name]) : _m)
}

/** Build composed props over a shared open store, with vi.fn Remote callbacks. */
function makePanelProps(open = true) {
  const store = createSnapshotStore({ open })
  return {
    useToolboxUi: ((selector: (snapshot: { open: boolean }) => { open: boolean }) =>
      selector(store.getSnapshot())) as never,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    translate: vi.fn(async () => ({ text: '译文' })),
    uuid: vi.fn(async () => ({ v1: ['a'], v4: ['b'] })),
    toggle: vi.fn(() => store.set({ open: !store.getSnapshot().open })),
    close: vi.fn(() => store.set({ open: false })),
    t,
  }
}

afterEach(cleanup)

describe('ToolboxPanel', () => {
  it('formats JSON with the chosen indent', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    const input = screen.getByPlaceholderText('在此粘贴 JSON 文本…')
    fireEvent.change(input, { target: { value: '{"a":1,"b":[2,3]}' } })
    fireEvent.click(screen.getByText('格式化'))
    expect(screen.getByText(/"a": 1/)).toBeTruthy()
    expect(screen.getByText(/"b": \[/)).toBeTruthy()
  })

  it('shows a validation error for malformed JSON', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    const input = screen.getByPlaceholderText('在此粘贴 JSON 文本…')
    fireEvent.change(input, { target: { value: '{bad json' } })
    fireEvent.click(screen.getByText('校验'))
    expect(screen.getByText(/JSON 解析错误/)).toBeTruthy()
  })

  it('converts a timestamp to a formatted date in the time widget', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    fireEvent.click(screen.getByText('时间'))
    // Select UTC so the expected wall-clock is deterministic regardless of runner TZ.
    const tzSelects = screen.getAllByDisplayValue('本地时区')
    fireEvent.change(tzSelects[0]!, { target: { value: 'UTC' } })
    const input = screen.getByPlaceholderText('1787565892901')
    fireEvent.change(input, { target: { value: '1700000000' } })
    fireEvent.click(screen.getAllByRole('button').filter(b => b.textContent === '转换')[0]!)
    expect(screen.getByText(/2023-11-14 22:13:20/)).toBeTruthy()
  })

  it('calls the injected translate Remote on the translate tab', async () => {
    const props = makePanelProps()
    render(<ToolboxPanel {...props} />)
    fireEvent.click(screen.getByText('翻译'))
    const input = screen.getByPlaceholderText('输入要翻译的大段文本…')
    fireEvent.change(input, { target: { value: 'hello world' } })
    const translateButton = screen.getAllByRole('button').filter(b => b.textContent === '翻译').pop()
    expect(translateButton).toBeTruthy()
    fireEvent.click(translateButton as HTMLElement)
    await vi.waitFor(() => expect(props.translate).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('译文')).toBeTruthy()
  })

  it('calls the injected uuid Remote on the uuid tab', async () => {
    const props = makePanelProps()
    render(<ToolboxPanel {...props} />)
    fireEvent.click(screen.getByText('UUID'))
    fireEvent.click(screen.getByText('生成'))
    await vi.waitFor(() => expect(props.uuid).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('b')).toBeTruthy()
  })

  it('converts a byte value between units in the bytes widget', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    fireEvent.click(screen.getByText('字节'))
    const input = screen.getByPlaceholderText('数值，如 2048 或 1.5')
    fireEvent.change(input, { target: { value: '2048' } })
    // Default from MB → to GB is already set; convert directly.
    fireEvent.click(screen.getAllByRole('button').filter(b => b.textContent === '转换').pop() as HTMLElement)
    expect(screen.getByText(/2\.048 GB/)).toBeTruthy()
  })

  it('validates and describes a cron expression in the cron widget', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    fireEvent.click(screen.getByText('Cron'))
    const input = screen.getByPlaceholderText('分 时 日 月 周 [年] · 如 */5 * * * *')
    fireEvent.change(input, { target: { value: '*/5 * * * *' } })
    fireEvent.click(screen.getByText('描述'))
    expect(screen.getByText(/✓ 合法/)).toBeTruthy()
    expect(screen.getByText(/每5分钟/)).toBeTruthy()
  })

  it('reports an invalid cron expression', () => {
    render(<ToolboxPanel {...makePanelProps()} />)
    fireEvent.click(screen.getByText('Cron'))
    const input = screen.getByPlaceholderText('分 时 日 月 周 [年] · 如 */5 * * * *')
    fireEvent.change(input, { target: { value: '60 * * * *' } })
    fireEvent.click(screen.getByText('校验'))
    expect(screen.getByText(/✗ 无效/)).toBeTruthy()
  })
})
