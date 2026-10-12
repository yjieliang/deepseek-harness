// @vitest-environment jsdom
/**
 * ```mermaid fences render as diagrams only where the owner opts in. The arm
 * keeps the ordinary code block while the fence grows, when the library chunk
 * cannot render the source, and wherever a renderer leaves the flag off — the
 * chat transcript among them.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MermaidConfig } from 'mermaid'
import { MarkdownText } from './markdown-test-components.tsx'
import { MermaidBlock } from '../src/markdown/MermaidBlock.tsx'
import { markdownLabels } from './labels.client.ts'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<(config: MermaidConfig) => void>(),
  render: vi.fn<(id: string, text: string) => Promise<{ svg: string }>>(),
}))

vi.mock('mermaid', () => ({ default: mermaid }))

const FENCE = '```mermaid\ngraph TD\n  a-->b\n```'
const SOURCE = 'graph TD\n  a-->b'
const DIAGRAM = '<svg data-testid="diagram"><text>graph</text></svg>'

function setToken(name: string, value: string): void {
  document.body.style.setProperty(name, value)
}

function diagram(container: HTMLElement): Element | null {
  return container.querySelector('[data-mermaid-diagram]')
}

/** @returns The configuration of the most recent `initialize` call. */
function lastConfig(): MermaidConfig {
  const config = mermaid.initialize.mock.calls.at(-1)?.[0]
  if (config === undefined) throw new Error('mermaid.initialize was never called')
  return config
}

beforeEach(() => {
  mermaid.initialize.mockClear()
  mermaid.render.mockReset().mockResolvedValue({ svg: DIAGRAM })
})

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.removeAttribute('style')
})

describe('MarkdownText mermaid fences', () => {
  it('keeps the fence as a code block unless diagrams are enabled', () => {
    const view = render(<MarkdownText text={FENCE} />)

    expect(diagram(view.container)).toBeNull()
    expect(view.container.querySelector('[data-code-block-content]')?.textContent).toContain('graph TD')
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('renders a settled fence as a diagram under the active palette', async () => {
    setToken('--dsw-alias-bg-layer-2', 'rgb(244, 244, 244)')
    setToken('--dsw-alias-label-primary', 'rgb(16, 16, 16)')
    const view = render(<MarkdownText text={FENCE} diagrams />)

    await waitFor(() => { expect(diagram(view.container)).not.toBeNull() })
    expect(diagram(view.container)?.querySelector('svg')).not.toBeNull()
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^dsh-mermaid-\d+$/u), SOURCE)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
    }))
    expect(lastConfig()).toMatchObject({
      themeVariables: {
        primaryColor: 'rgb(244, 244, 244)',
        primaryTextColor: 'rgb(16, 16, 16)',
      },
    })
  })

  it('omits palette variables the active theme does not define', async () => {
    const view = render(<MarkdownText text={FENCE} diagrams />)

    await waitFor(() => { expect(diagram(view.container)).not.toBeNull() })
    expect(lastConfig().themeVariables).toEqual({})
  })

  it('swaps a growing fence for its diagram only after settlement', async () => {
    const view = render(<MarkdownText text={FENCE} streaming diagrams />)

    expect(diagram(view.container)).toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()
    view.rerender(<MarkdownText text={FENCE} diagrams />)
    await waitFor(() => { expect(diagram(view.container)).not.toBeNull() })
  })

  it('keeps the code block when the source cannot be rendered', async () => {
    mermaid.render.mockRejectedValue(new Error('syntax error'))
    const view = render(<MarkdownText text={FENCE} diagrams />)

    await waitFor(() => { expect(mermaid.render).toHaveBeenCalled() })
    expect(diagram(view.container)).toBeNull()
    expect(view.container.querySelector('[data-code-block-content]')?.textContent).toContain('graph TD')
    expect(view.getByRole('button', { name: '复制' })).toBeTruthy()
  })
})

describe('MermaidBlock palette and lifetimes', () => {
  it('re-renders a mounted diagram when the palette flips', async () => {
    setToken('--dsw-alias-label-primary', 'rgb(16, 16, 16)')
    const view = render(<MermaidBlock code={SOURCE} labels={markdownLabels.code} />)
    await waitFor(() => { expect(diagram(view.container)).not.toBeNull() })

    mermaid.initialize.mockClear()
    setToken('--dsw-alias-label-primary', 'rgb(238, 238, 238)')
    document.body.setAttribute('data-ds-dark-theme', '')
    await waitFor(() => { expect(mermaid.initialize).toHaveBeenCalledTimes(1) })
    expect(lastConfig()).toMatchObject({ themeVariables: { primaryTextColor: 'rgb(238, 238, 238)' } })
    expect(mermaid.render).toHaveBeenCalledTimes(2)
  })

  it('drops a diagram that resolves or rejects after unmount', async () => {
    let resolveRender: (value: { svg: string }) => void = () => {}
    mermaid.render.mockReturnValueOnce(new Promise((resolve) => { resolveRender = resolve }))
    const resolved = render(<MermaidBlock code={SOURCE} labels={markdownLabels.code} />)
    await waitFor(() => { expect(mermaid.render).toHaveBeenCalledTimes(1) })
    resolved.unmount()
    await act(async () => { resolveRender({ svg: DIAGRAM }) })

    let rejectRender: (reason: Error) => void = () => {}
    mermaid.render.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRender = reject }))
    const rejected = render(<MermaidBlock code={SOURCE} labels={markdownLabels.code} />)
    await waitFor(() => { expect(mermaid.render).toHaveBeenCalledTimes(2) })
    rejected.unmount()
    await act(async () => { rejectRender(new Error('syntax error')) })

    expect(document.querySelector('[data-mermaid-diagram]')).toBeNull()
  })

  it('keeps one palette observer while another diagram remains mounted', async () => {
    const first = render(<MermaidBlock code={SOURCE} labels={markdownLabels.code} />)
    const second = render(<MermaidBlock code={'graph TD\n  b-->c'} labels={markdownLabels.code} />)
    await waitFor(() => { expect(mermaid.render).toHaveBeenCalledTimes(2) })

    first.unmount()
    mermaid.initialize.mockClear()
    document.body.setAttribute('data-ds-dark-theme', '')
    await waitFor(() => { expect(mermaid.initialize).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(diagram(second.container)).not.toBeNull() })
  })
})
