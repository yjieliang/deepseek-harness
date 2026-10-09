/**
 * Live end-to-end check against a running Harness Web GUI.
 *
 * Unlike the two smoke tests, this one talks to the installed plugin's route on
 * a real server, so it proves the whole chain: the Loader mounted the Host row,
 * the route is registered, commands reach the service, and the SSE stream
 * pushes committed changes. It creates what it needs and deletes it again, so a
 * passing run leaves the board as it found it.
 *
 * Usage: `node tests/live.mjs [base-url] [boot-token]` (default http://127.0.0.1:3080).
 * The boot token may also arrive as `DSH_BOARD_TOKEN`.
 *
 * The board route sits behind the platform's request-trust door. A real
 * deployment's credential is the session cookie the browser receives after
 * opening the GUI with the token `dsh web` prints; this suite makes that same
 * exchange once and carries the cookie on every request. Without a token the
 * suite stops before its first call rather than reporting unauthenticated
 * failures as board behavior.
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const API = `${BASE}/api/requirement-board`
const BOOT_TOKEN = process.argv[3] ?? process.env.DSH_BOARD_TOKEN ?? ''

if (BOOT_TOKEN === '') {
  console.error('live: this suite needs a board credential: pass the boot token as the second argument (after the base URL) or set DSH_BOARD_TOKEN; a real deployment\'s credentials come from the browser login')
  process.exit(2)
}

const bootstrapPage = await fetch(`${BASE}/?token=${encodeURIComponent(BOOT_TOKEN)}`, { redirect: 'manual' })
const sessionCookie = (bootstrapPage.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
if (sessionCookie === '') {
  console.error(`live: the boot token was refused: ${BASE}/?token=… answered ${bootstrapPage.status} with no session cookie; a real deployment's credentials come from the browser login`)
  process.exit(2)
}
globalThis.fetch = (realFetch => (input, init = {}) => {
  const headers = new Headers(init.headers ?? {})
  headers.set('cookie', sessionCookie)
  return realFetch(input, { ...init, headers })
})(globalThis.fetch)

let failures = 0
let checks = 0

/** Assert a condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** GET one route and return its envelope. */
async function get(path, headers = {}) {
  const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json', ...headers } })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** POST one command and return its envelope. */
async function command(action, payload = {}, headers = {}) {
  const response = await fetch(`${API}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ action, ...payload }),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

console.log(`live check against ${BASE}`)
const created = []
let probe = null

try {
  const health = await get('/health')
  check('the health route answers', health.body?.ok === true, JSON.stringify(health.body))

  const baseline = await get('/snapshot?limit=1')
  check('the snapshot route answers', baseline.body?.ok === true, JSON.stringify(baseline.body))
  check('the route is reachable through the running server', typeof baseline.body?.data?.revision === 'number')
  check('the built-in template ships with the store', (baseline.body?.data?.templates ?? []).some(entry => entry.id === 'tpl-standard'))

  /* ------------------------------------------------------------ preflight */

  // A Host plugin is imported once per process. Editing its source does not
  // reload it: profile HMR watches no module root, and re-enabling the row only
  // re-runs the configuration while Node's ESM cache serves the old module. Every
  // assertion below reads the current source's contract, so a stale process would
  // report a dozen unrelated failures. Detect that once, loudly, and stop.
  const preflight = await command('create', { requirement: { summary: '测试简述', title: 'Live probe preflight (deleted immediately)' } })
  if (preflight.body?.ok === true) {
    const fresh = Object.hasOwn(preflight.body.data, 'lastTransition')
    await command('delete', { id: preflight.body.data.id })
    if (!fresh) {
      console.log('\nFAIL the running Host process predates the current plugin source')
      console.log('     `data.lastTransition` is missing from a create response, so the server is')
      console.log('     still running the module it imported at startup. Restart `dsh web` and')
      console.log('     re-run this check; the browser half needs no restart, only a page refresh.')
      process.exit(1)
    }
  }

  /* ------------------------------------------------------------ commands */

  const created1 = await command('create', { requirement: { summary: '测试简述', title: 'Live probe (deleted at the end)', owner: 'probe', priority: 'high', templateId: 'tpl-standard' } })
  check('create succeeds', created1.body?.ok === true, JSON.stringify(created1.body?.error))
  probe = created1.body?.data
  if (probe === null || probe === undefined) throw new Error('cannot continue without a created requirement')
  created.push(probe.id)
  check('create returns a bound flow', probe.flow?.length === 5 && probe.nodeId === 'review', JSON.stringify(probe.flow?.map(node => node.id)))
  check('create starts on the first node', probe.flow[0].status === 'active' && probe.progress.done === 0)

  const gated = await command('transition', { id: probe.id, transition: 'advance', expectedRev: probe.rev })
  check('advance is refused while the checklist is incomplete', gated.status === 409 && gated.body?.error?.code === 'completion-not-met', `${gated.status} ${JSON.stringify(gated.body?.error)}`)

  const ticked1 = await command('checklist', { id: probe.id, index: 0, checked: true, expectedRev: probe.rev })
  check('ticking a checklist entry succeeds', ticked1.body?.ok === true, JSON.stringify(ticked1.body?.error))
  const ticked2 = await command('checklist', { id: probe.id, index: 1, checked: true })
  check('the second checklist entry ticks', (ticked2.body?.data?.flow?.[0]?.checks ?? []).every(Boolean) === true && ticked2.body?.data?.flow?.[0]?.checks?.length === 2, JSON.stringify(ticked2.body?.data?.flow?.[0]?.checks))

  const advanced = await command('transition', { id: probe.id, transition: 'advance' })
  check('advance moves to the next node', advanced.body?.data?.nodeId === 'design', JSON.stringify(advanced.body?.error ?? advanced.body?.data?.nodeId))
  check('the finished node is stamped done', advanced.body?.data?.flow?.[0]?.status === 'done' && advanced.body?.data?.flow?.[0]?.completedAt !== null)
  check('the write returns the transition receipt', advanced.body?.data?.lastTransition?.from === 'review' && advanced.body?.data?.lastTransition?.to === 'design', JSON.stringify(advanced.body?.data?.lastTransition))

  const noteGate = await command('transition', { id: probe.id, transition: 'advance' })
  check('the note-required node gates the advance', noteGate.body?.error?.code === 'completion-not-met', JSON.stringify(noteGate.body?.error))
  const withNote = await command('transition', { id: probe.id, transition: 'advance', note: 'design signed off' })
  check('a note opens the gate', withNote.body?.data?.nodeId === 'build', JSON.stringify(withNote.body?.error))

  await command('transition', { id: probe.id, transition: 'advance' })
  await command('checklist', { id: probe.id, index: 0, checked: true })
  await command('checklist', { id: probe.id, index: 1, checked: true })
  const toRelease = await command('transition', { id: probe.id, transition: 'advance' })
  check('the run reaches the last node', toRelease.body?.data?.nodeId === 'release', JSON.stringify(toRelease.body?.error ?? toRelease.body?.data?.nodeId))
  // The last node's completion condition also requires a note.
  const finished = await command('transition', { id: probe.id, transition: 'advance', note: 'shipped' })
  check('the last advance finishes the requirement', finished.body?.data?.status === 'done', JSON.stringify(finished.body?.error ?? finished.body?.data?.status))
  check('every node reads done', (finished.body?.data?.flow ?? []).length === 5 && finished.body.data.flow.every(node => node.status === 'done'), JSON.stringify(finished.body?.data?.flow?.map(node => node.status)))
  const history = finished.body?.data?.history ?? []
  check('the transition history is complete', history.length === 6 && history[0]?.action === 'create' && history.at(-1)?.action === 'advance', JSON.stringify(history.map(entry => entry.action)))

  const stats = await command('stats')
  check('stats counts the finished requirement', (stats.body?.data?.byStatus?.done ?? 0) >= 1 && stats.body?.data?.completionRate > 0, JSON.stringify(stats.body?.data?.byStatus))
  check('stats aggregates node durations', (stats.body?.data?.nodeDurations ?? []).some(row => row.templateId === 'tpl-standard'), JSON.stringify(stats.body?.data?.nodeDurations?.map(row => row.nodeId)))

  const changes = await command('changes', { since: new Date(Date.now() - 3_600_000).toISOString() })
  check('changes names the probe', (changes.body?.data?.requirements ?? []).some(item => item.id === probe.id))
  check('changes retains the transitions', (changes.body?.data?.transitions ?? []).some(entry => entry.requirementId === probe.id))

  const stale = await command('update', { id: probe.id, patch: { owner: 'someone-else' }, expectedRev: 1 })
  check('a stale expectedRev is refused', stale.status === 409 && stale.body?.error?.code === 'conflict', `${stale.status} ${JSON.stringify(stale.body?.error)}`)
  check('the conflict carries the current revision', typeof stale.body?.error?.details?.current === 'number', JSON.stringify(stale.body?.error?.details))

  const filtered = await get(`/snapshot?query=${encodeURIComponent('Live probe')}&limit=5`)
  check('the snapshot honours a filter', (filtered.body?.data?.requirements ?? []).some(item => item.id === probe.id))
  const excluded = await get('/snapshot?status=open&limit=5')
  check('a done requirement is excluded from the open filter', !(excluded.body?.data?.requirements ?? []).some(item => item.id === probe.id))

  /* ----------------------------------------------------------------- SSE */

  const streamController = new AbortController()
  const stream = await fetch(`${API}/events`, { headers: { accept: 'text/event-stream' }, signal: streamController.signal })
  check('the event stream opens with the right content type', stream.headers.get('content-type')?.includes('text/event-stream') === true, String(stream.headers.get('content-type')))
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const readFor = async (needle, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (!seen.includes(needle) && Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(50, deadline - Date.now()))),
      ])
      if (race.timeout === true || race.done === true) break
      seen += decoder.decode(race.value, { stream: true })
    }
    return seen.includes(needle)
  }
  check('the stream sends a ready event', await readFor('event: ready', 5000), JSON.stringify(seen.slice(0, 200)))
  const trigger = await command('create', { requirement: { summary: '测试简述', title: 'Live probe SSE trigger (deleted at the end)' } })
  if (trigger.body?.ok === true) created.push(trigger.body.data.id)
  check('a committed change pushes a changed event to the open stream', await readFor('event: changed', 8000), JSON.stringify(seen.slice(0, 400)))
  streamController.abort()

  /* --------------------------------------------------------- origin guard */

  const foreign = await get('/health', { origin: 'https://evil.example' })
  check('a foreign Origin is refused', foreign.status === 403 && foreign.body?.error?.code === 'forbidden-origin', `${foreign.status} ${JSON.stringify(foreign.body)}`)
  const loopback = await get('/health', { origin: BASE })
  check('a loopback Origin is accepted', loopback.body?.ok === true, JSON.stringify(loopback.body))

  const unknown = await command('nope')
  check('an unknown action fails loud', unknown.status === 409 && unknown.body?.error?.code === 'invalid-argument', `${unknown.status} ${JSON.stringify(unknown.body?.error)}`)
} catch (error) {
  failures += 1
  checks += 1
  console.log(`  FAIL the live check ran to completion — ${error?.message ?? error}`)
} finally {
  /* ------------------------------------------------------------- restore */

  let removed = 0
  for (const id of created) {
    const result = await command('delete', { id }).catch(() => ({ body: null }))
    if (result.body?.ok === true) removed += 1
  }
  check('every probe requirement was deleted again', removed === created.length, `${removed}/${created.length}`)
  const after = await get('/snapshot?query=Live%20probe&limit=5')
  check('the board is back to its previous contents', (after.body?.data?.requirements ?? []).length === 0, JSON.stringify(after.body?.data?.requirements?.map(item => item.id)))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
