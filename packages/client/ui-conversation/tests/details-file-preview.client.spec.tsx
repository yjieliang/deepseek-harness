// @vitest-environment jsdom
/**
 * DetailsFilePreview acceptance: fetches the target file through the injected
 * readFile into local state, renders the shared ReadBlock with line numbers,
 * shows a truncation notice and an "open in system" hand-off, and stays correct
 * when a slower earlier read lands after a re-target or on failure.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DetailsFilePreviewProps } from '../src/client/skeleton/DetailsFilePreview.tsx'
import { DetailsFilePreview } from '../src/client/skeleton/DetailsFilePreview.tsx'
import { zh } from '../src/client/locales.ts'

// Mirrors the real lookup chain (conversation namespace, then common).
const t: DetailsFilePreviewProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const readFile = vi.fn<(path: string) => Promise<{ path: string; content: string; truncated: boolean; lang: string | null }>>()

function preview(overrides: Partial<DetailsFilePreviewProps> = {}) {
  return render(<DetailsFilePreview
    path="/w/alpha/src/main.ts"
    lang="ts"
    openInSystem={() => {}}
    readFile={readFile}
    t={t}
    {...overrides}
  />)
}

describe('DetailsFilePreview', () => {
  it('shows a loading state, then the line-numbered file content', async () => {
    readFile.mockResolvedValue({ path: '/w/alpha/src/main.ts', content: 'const a = 1\nconst b = 2\n', truncated: false, lang: 'ts' })
    const view = preview()
    expect(screen.getByText('正在读取文件…')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    // ReadBlock splits lines into highlighted runs, so match the whole flow.
    expect(view.container.textContent).toContain('const a = 1')
    expect(view.container.textContent).toContain('const b = 2')
    // Line-numbered gutter present (both rows carry file line numbers).
    expect(view.container.querySelectorAll('[data-read] [class*="line"]')).toBeTruthy()
    expect(screen.queryByText(/仅显示前/)).toBeNull()
  })

  it('shows a truncation notice and the open-in-system hand-off', async () => {
    readFile.mockResolvedValue({ path: '/w/alpha/big.ts', content: 'const a = 1\n', truncated: true, lang: 'ts' })
    const openInSystem = vi.fn()
    const view = preview({ path: '/w/alpha/big.ts', openInSystem })
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('仅显示前')
    fireEvent.click(screen.getByText('在系统默认应用中打开'))
    expect(openInSystem).toHaveBeenCalledWith('/w/alpha/big.ts')
  })

  it('shows an error state and retries the read', async () => {
    readFile.mockRejectedValueOnce(new Error('binary')).mockResolvedValueOnce({ path: '/w/alpha/a.ts', content: 'ok\n', truncated: false, lang: 'ts' })
    const view = preview()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('无法读取此文件')).toBeTruthy()
    fireEvent.click(screen.getByText('重试'))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('ok')
  })

  it('offers a source/rendered toggle for Markdown and parses on render', async () => {
    readFile.mockResolvedValue({ path: '/w/alpha/note.md', content: '# 标题\n\n**加粗** 和 `code`\n\n- 条目\n', truncated: false, lang: 'md' })
    const view = preview({ path: '/w/alpha/note.md', lang: 'md' })
    await act(async () => { await Promise.resolve() })
    // Source view default: line-numbered source, toggle present.
    expect(screen.getByText('源码')).toBeTruthy()
    expect(screen.getByText('渲染预览')).toBeTruthy()
    expect(view.container.textContent).toContain('# 标题')
    // Switch to rendered: the heading is parsed (no '#' literal), bold + list parse.
    fireEvent.click(screen.getByText('渲染预览'))
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('标题')
    expect(view.container.textContent).not.toContain('# 标题')
    expect(view.container.querySelector('strong')).toBeTruthy()
    expect(view.container.querySelector('li')).toBeTruthy()
  })

  it('hides the rendered toggle for a non-Markdown source', async () => {
    readFile.mockResolvedValue({ path: '/w/alpha/main.ts', content: 'const a = 1\n', truncated: false, lang: 'ts' })
    preview()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('渲染预览')).toBeNull()
    expect(screen.queryByText('源码')).toBeNull()
  })

  it('ignores a slow earlier read when the target changes mid-flight', async () => {
    let resolveFirst: (value: { path: string; content: string; truncated: boolean; lang: string | null }) => void = () => {}
    readFile.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ path: '/w/alpha/second.ts', content: 'second\n', truncated: false, lang: 'ts' })
    const view = preview({ path: '/w/alpha/first.ts' })
    // Re-target before the first read settles.
    view.rerender(<DetailsFilePreview path="/w/alpha/second.ts" lang="ts" openInSystem={() => {}} readFile={readFile} t={t} />)
    await act(async () => { resolveFirst({ path: '/w/alpha/first.ts', content: 'first\n', truncated: false, lang: 'ts' }) })
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain('second')
    expect(view.container.textContent).not.toContain('first')
  })
})
