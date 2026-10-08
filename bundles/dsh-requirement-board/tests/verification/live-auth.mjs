#!/usr/bin/env node
/**
 * Run the author's `tests/live.mjs` **unmodified** against a live instance whose
 * board API sits behind the platform's request-trust door, by carrying the same
 * session credential a browser gets when it opens the GUI with its bootstrap
 * token.
 *
 * The author's file is not edited: this wrapper loads the bootstrap page with
 * `?token=`, keeps the returned session cookie, attaches it to every `fetch`
 * the suite makes, and then imports `../live.mjs` with the base URL already in
 * `process.argv[2]` — the argument form the suite documents.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     tests/verification/live-auth.mjs http://127.0.0.1:3108 <bootstrap-token>
 *
 * Without the token the suite runs as an unauthenticated client; that reading is
 * taken separately by invoking `tests/live.mjs <base-url>` directly.
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3108').replace(/\/$/, '')
const TOKEN = process.argv[3] ?? process.env.RB_LIVE_TOKEN ?? ''

if (TOKEN === '') {
  console.error('live-auth: pass the bootstrap token as argv[3] (the URL the instance prints) or RB_LIVE_TOKEN')
  process.exit(2)
}

const page = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' })
const setCookies = typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : []
const cookie = setCookies.map(entry => entry.split(';')[0]).join('; ')
console.log(`live-auth: bootstrap page status=${page.status} cookie=${cookie === '' ? '(none)' : cookie.split('=')[0]}`)
if (cookie === '') {
  console.error('live-auth: the bootstrap page set no cookie; nothing to carry')
  process.exit(2)
}

const realFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers ?? {})
  headers.set('cookie', cookie)
  return realFetch(input, { ...init, headers })
}

process.argv = [process.argv[0], 'tests/live.mjs', BASE]
await import(new URL('../live.mjs', import.meta.url))
