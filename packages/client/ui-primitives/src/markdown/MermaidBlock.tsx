/**
 * Mermaid diagrams for settled untrusted Markdown. A ```mermaid fence renders
 * as SVG, and keeps the ordinary code block while the diagram chunk loads,
 * when the source is malformed, and when mermaid's own text-size and edge
 * guards refuse it — a diagram never becomes an error surface or blank space.
 *
 * Mermaid's `strict` security level sanitizes labels and disables click
 * callbacks, so model-authored source reaches the DOM as the library's own
 * sanitized SVG output (the same sanctioned injection path as Shiki's HTML arm
 * in CodeBlock) and cannot navigate or attach handlers. Palette colors come
 * from the active theme's `--dsw-*` tokens, and the presenter's palette
 * selector re-renders a mounted diagram instead of leaving the previous
 * theme's colors inside the SVG.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import type { MarkdownCodeLabels } from './render.tsx'
import css from './MermaidBlock.module.css'

/** The palette selector `ui-layout`'s theme presenter toggles on `<body>` for every dark theme. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Mermaid base-theme variables mapped onto the theme tokens that own each
 * role. A token the active theme does not define stays absent, so mermaid's own
 * base default applies instead of a literal color from this module.
 */
const PALETTE_TOKENS = {
  primaryColor: '--dsw-alias-bg-layer-2',
  primaryTextColor: '--dsw-alias-label-primary',
  primaryBorderColor: '--dsw-alias-border-l2',
  lineColor: '--dsw-alias-label-secondary',
  secondaryColor: '--dsw-alias-bg-layer-1',
  tertiaryColor: '--dsw-alias-bg-layer-1',
  clusterBkg: '--dsw-alias-bg-layer-1',
  clusterBorder: '--dsw-alias-border-l1',
  edgeLabelBackground: '--dsw-alias-bg-base',
  noteBkgColor: '--dsw-alias-bg-layer-1',
  noteTextColor: '--dsw-alias-label-primary',
  noteBorderColor: '--dsw-alias-border-l2',
  fontFamily: '--dsw-font-family',
} as const

type MermaidApi = typeof import('mermaid')['default']

let mermaidModule: Promise<MermaidApi> | undefined
let diagramSequence = 0

/**
 * Load mermaid once per page. Nothing imports the library until a settled
 * fence actually renders a diagram, so a document without diagrams — and every
 * other Markdown surface — pays no part of it. A failed chunk keeps the code
 * block for the rest of the session rather than retrying every render.
 * @returns The mermaid API object.
 */
function loadMermaid(): Promise<MermaidApi> {
  mermaidModule ??= import('mermaid').then(module => module.default)
  return mermaidModule
}

/** @returns Every palette variable the active theme defines. */
function paletteVariables(): Record<string, string> {
  const styles = getComputedStyle(document.body)
  const variables: Record<string, string> = {}
  for (const [name, token] of Object.entries(PALETTE_TOKENS)) {
    const value = styles.getPropertyValue(token).trim()
    if (value !== '') variables[name] = value
  }
  return variables
}

/** @returns Whether the palette selector currently marks the dark theme. */
function darkPalette(): boolean {
  return document.body.hasAttribute(DARK_ATTRIBUTE)
}

const paletteListeners = new Set<() => void>()
let paletteObserver: MutationObserver | undefined

/**
 * Notify every mounted diagram when the palette selector flips; one observer
 * serves the document and disconnects with its last listener.
 * @param listener - Re-render callback for one mounted diagram.
 * @returns The disposer releasing that listener.
 */
function observePalette(listener: () => void): () => void {
  paletteListeners.add(listener)
  paletteObserver ??= new MutationObserver(() => {
    for (const current of [...paletteListeners]) current()
  })
  paletteObserver.observe(document.body, { attributeFilter: [DARK_ATTRIBUTE] })
  return () => {
    paletteListeners.delete(listener)
    if (paletteListeners.size > 0) return
    paletteObserver?.disconnect()
    paletteObserver = undefined
  }
}

/**
 * Render one diagram under the current palette.
 * @param code - The fence source.
 * @returns The SVG markup, or a rejection the caller answers with the code block.
 */
async function renderDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    // The rejected source keeps the code block; mermaid must not also append
    // its own error graphic to the document body.
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: paletteVariables(),
  })
  diagramSequence += 1
  const { svg } = await mermaid.render(`dsh-mermaid-${String(diagramSequence)}`, code)
  return svg
}

/** One ```mermaid fence's source and the code chrome its fallback keeps. */
export interface MermaidBlockProps {
  /** Fence source without the info string. */
  code: string
  /** Localized code-card labels for the loading and failure fallback. */
  labels: MarkdownCodeLabels
}

/**
 * Render one settled ```mermaid fence as a diagram.
 * @param props - Fence source and the fallback code card's labels.
 * @returns The diagram, or the code block it falls back to.
 */
export function MermaidBlock({ code, labels }: MermaidBlockProps): ReactNode {
  const [dark, setDark] = useState(darkPalette)
  const [svg, setSvg] = useState<string | undefined>(undefined)
  useEffect(() => observePalette(() => { setDark(darkPalette()) }), [])
  useEffect(() => {
    let live = true
    setSvg(undefined)
    void renderDiagram(code).then(
      (rendered) => { if (live) setSvg(rendered) },
      // Malformed source, an over-limit graph, or an unavailable chunk keeps the
      // source readable in place; the diagram itself reports no error.
      () => { if (live) setSvg(undefined) },
    )
    return () => { live = false }
  }, [code, dark])
  if (svg === undefined) {
    // The newline matches the settled fence arm, whose CodeBlock trims it off display.
    return (
      <CodeBlock
        code={`${code}\n`}
        lang="mermaid"
        copyLabel={labels.copyLabel}
        copiedLabel={labels.copiedLabel}
        toolbarLabels={labels.toolbarLabels}
      />
    )
  }
  return <div className={css.diagram} data-mermaid-diagram dangerouslySetInnerHTML={{ __html: svg }} />
}
