/**
 * Browser-safe canonical session URI and inline mention grammar.
 *
 * Shared by the Host resolver and the Web client so the canonical
 * `dsh-session:` mention format has one encoding authority. It imports no
 * Node builtins, so a browser bundle can carry it privately.
 * @module @deepseek-ai/dsh-session-reference/grammar
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** URI scheme reserved for DeepSeek Harness session snapshots. */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

/** RFC 4648 §5 base64url alphabet, no padding. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Encode bytes as unpadded base64url, byte-for-byte identical to
 * `Buffer.from(bytes).toString('base64url')`, without importing a Node builtin.
 * @param bytes - the raw bytes to encode.
 * @returns the base64url string without trailing `=`.
 */
function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    // The loop bound guarantees the leading byte; only the trailing pair may be absent.
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] ?? -1
    const b2 = bytes[i + 2] ?? -1
    out += BASE64URL_ALPHABET[b0 >> 2]
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    if (b1 >= 0) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    if (b2 >= 0) out += BASE64URL_ALPHABET[b2 & 0x3f]
  }
  return out
}

/**
 * Encode any JavaScript session-id string as a canonical lossless URI.
 * @param sessionId - opaque session id to serialize.
 * @returns canonical `dsh-session:` URI.
 */
export function encodeSessionReferenceUri(sessionId: SessionId): string {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(sessionId)))
  return `${SESSION_REFERENCE_SCHEME}${payload}`
}

/** Escape `\` and `]` so a label round-trips through the Markdown mention body. */
function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

/**
 * Render a host-neutral Markdown mention carrying the canonical URI.
 * @param reference - structured id and optional display label.
 * @returns escaped `@[label](uri)` mention.
 */
export function formatSessionReferenceMention(
  reference: { sessionId: SessionId; label?: string },
): string {
  const label = escapeLabel(reference.label ?? reference.sessionId)
  return `@[${label}](${encodeSessionReferenceUri(reference.sessionId)})`
}
