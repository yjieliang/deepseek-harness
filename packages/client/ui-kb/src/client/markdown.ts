/**
 * Knowledge-base Markdown preprocessing: the library documents use Obsidian
 * syntax (`![[file|alt]]` embeds and `[[wiki links]]`) and relative image
 * references, while the shared MarkdownText renderer only accepts absolute
 * HTTP(S) image destinations. This module rewrites the body for rendering:
 * embeds become standard images, and every local image reference resolves
 * against the document's directory to an absolute `/dsh-kb/...` URL.
 */

/** Resolve one image reference to a renderable destination. */
function imageUrl(ref: string, docDir: string, assetUrl: (path: string) => string): string {
  const trimmed = ref.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const rel = trimmed.replace(/^\/+/, '')
  const resolved = rel.includes('/') ? rel : (docDir === '' ? rel : docDir + '/' + rel)
  return assetUrl(resolved)
}

/**
 * Rewrite a document body so MarkdownText can render it: Obsidian `![[...]]`
 * embeds become standard image syntax and relative image references become
 * absolute `/dsh-kb/...` URLs. Plain `[[wiki links]]` stay literal.
 * @param body - the raw Markdown body.
 * @param docDir - directory of the document, library-relative ('' for root docs).
 * @param assetUrl - resolves one library-relative asset path to an absolute URL.
 * @returns the renderable Markdown.
 */
export function kbMarkdown(body: string, docDir: string, assetUrl: (path: string) => string): string {
  return body
    // Obsidian embeds: ![[file|alt]] or ![[file]] — treat every embed as an image.
    .replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
      const [file = '', alt] = inner.split(/[|#]/)
      return `![${alt === undefined ? file : alt}](${imageUrl(file, docDir, assetUrl)})`
    })
    // Standard images with angle-bracketed destinations.
    .replace(/!\[([^\]]*)\]\(<([^)>]+)>\)/g, (_match, alt: string, ref: string) =>
      `![${alt}](${imageUrl(ref, docDir, assetUrl)})`)
    // Standard images with plain destinations.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, ref: string) =>
      `![${alt}](${imageUrl(ref, docDir, assetUrl)})`)
}
