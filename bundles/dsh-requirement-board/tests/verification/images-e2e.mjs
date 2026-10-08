/**
 * Wire-level check of the pasted-image route, run against the real handler.
 *
 * The unit suites drive `ImageStore` and the service directly; this one drives
 * `createBoardHandler`, so it is the only place that proves the route itself:
 * that `/image` reads a raw body and answers with the ref, that `/image/<id>`
 * returns the stored bytes under the stored media type, that a refusal carries
 * the ordinary HTTP status instead of the command endpoint's 409, and that an
 * oversized upload is torn down while it is still being read rather than after
 * being buffered whole.
 *
 * The request and response are stubs, so no port is bound and no Harness home is
 * touched: bytes and metadata land in a temporary directory this file removes.
 *
 * Run: node tests/verification/images-e2e.mjs   (from the bundle directory)
 */

import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoardHandler } from '../../host/http.js'
import { IMAGE_ID_RE, IMAGE_MAX_BYTES, IMAGE_NAME_MAX, ImageStore } from '../../host/images.js'
import { fail } from '../../host/model.js'

const PREFIX = '/api/requirement-board'

let checks = 0
const failures = []

/** Record one assertion. */
function check(label, ok, detail = '') {
  checks += 1
  if (!ok) failures.push(detail === '' ? label : `${label} — ${detail}`)
}

/** A PNG carrying one IHDR of the given size; enough for the header parser. */
function pngBytes(width, height) {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head.writeUInt8(8, 24)
  head.writeUInt8(6, 25)
  return Buffer.concat([head, Buffer.alloc(4)])
}

/** A GIF89a carrying one logical screen descriptor of the given size. */
function gifBytes(width, height) {
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'latin1')
  head.writeUInt16LE(width, 6)
  head.writeUInt16LE(height, 8)
  return head
}

/**
 * A stub request whose body is an async iterable, as the handler reads it.
 * `pulled`/`completed` are how a refusal mid-stream is observed: a reader that
 * stopped early never drained the iterator.
 */
function makeRequest({ method, path, headers = {}, chunks = [] }) {
  const stats = { pulled: 0, completed: false }
  const req = {
    method,
    url: `http://127.0.0.1:3080${PREFIX}${path}`,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        stats.pulled += 1
        yield chunk
      }
      stats.completed = true
    },
  }
  return { req, stats }
}

/** A stub response recording the status, headers, and body the handler wrote. */
function makeResponse() {
  const state = { status: 0, headers: {}, chunks: [], body: undefined }
  const res = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    write(chunk) {
      state.chunks.push(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) state.body = chunk
    },
  }
  return { res, state }
}

/** Send one stub request through the real handler. */
async function call(handler, spec) {
  const { req, stats } = makeRequest(spec)
  const { res, state } = makeResponse()
  await handler(req, res)
  let json
  try {
    json = state.body === undefined ? undefined : JSON.parse(state.body.toString('utf8'))
  } catch {
    json = undefined
  }
  return { state, stats, json }
}

const dir = await mkdtemp(join(tmpdir(), 'rb-images-e2e-'))
const store = new ImageStore(dir)
const service = {
  async storeImage(input) {
    return await store.put(input)
  },
  async readImage(id) {
    const stored = await store.read(id)
    if (stored === undefined) fail('not-found', `no stored image with id "${id}"`, { id })
    return stored
  },
  snapshot() {
    return { revision: 1 }
  },
}
const handler = createBoardHandler(service, () => undefined)

async function files() {
  try {
    return await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

// A. one upload stores bytes and metadata, and answers with the ref.
const png = pngBytes(3, 2)
const uploaded = await call(handler, {
  method: 'POST',
  path: '/image?name=shot.png',
  headers: { 'content-type': 'image/png' },
  chunks: [png],
})
const ref = uploaded.json?.data?.image
check('A upload answers 200', uploaded.state.status === 200, `status ${uploaded.state.status}`)
check('A upload carries ok:true', uploaded.json?.ok === true)
check('A ref id has the stored shape', typeof ref?.id === 'string' && IMAGE_ID_RE.test(ref.id), String(ref?.id))
check('A ref keeps the original name', ref?.name === 'shot.png', String(ref?.name))
check('A ref reports the media type', ref?.mediaType === 'image/png', String(ref?.mediaType))
check('A ref reports the byte length', ref?.byteLength === png.byteLength, String(ref?.byteLength))
check('A ref reports the parsed size', ref?.width === 3 && ref?.height === 2, `${ref?.width}x${ref?.height}`)
check('A ref is stamped', typeof ref?.createdAt === 'string' && ref.createdAt.length > 0)
const storedPath = store.filePath(ref)
check('A bytes file holds the identical bytes', Buffer.compare(await readFile(storedPath), png) === 0)
const meta = JSON.parse(await readFile(join(dir, `${ref.id}.json`), 'utf8'))
check('A metadata file holds the same ref', JSON.stringify(meta) === JSON.stringify(ref))
check('A one image is two files', (await files()).length === 2, String((await files()).length))

// B. the fetch returns the stored bytes under the stored media type.
const fetched = await call(handler, { method: 'GET', path: `/image/${ref.id}` })
check('B fetch answers 200', fetched.state.status === 200, `status ${fetched.state.status}`)
check('B fetch sets the stored media type', fetched.state.headers['content-type'] === 'image/png', String(fetched.state.headers['content-type']))
check('B fetch sets the length', fetched.state.headers['content-length'] === png.byteLength, String(fetched.state.headers['content-length']))
check('B fetch returns the identical bytes', Buffer.compare(fetched.state.body, png) === 0)
check('B fetch is not cached', fetched.state.headers['cache-control'] === 'no-store', String(fetched.state.headers['cache-control']))

// C/D. an unknown id and a malformed id are both a plain 404.
const missing = await call(handler, { method: 'GET', path: '/image/img-1f0f3a2c-1111-4222-8333-444455556666' })
check('C unknown id answers 404', missing.state.status === 404, `status ${missing.state.status}`)
check('C unknown id names the code', missing.json?.error?.code === 'not-found', String(missing.json?.error?.code))
const malformed = await call(handler, { method: 'GET', path: '/image/not-an-image' })
check('D malformed id answers 404', malformed.state.status === 404, `status ${malformed.state.status}`)
check('D malformed id names the code', malformed.json?.error?.code === 'not-found', String(malformed.json?.error?.code))

// E/F/G. a refused upload leaves no file and keeps its own status.
const before = (await files()).length
const wrongType = await call(handler, {
  method: 'POST',
  path: '/image?name=x.txt',
  headers: { 'content-type': 'text/plain' },
  chunks: [png],
})
check('E unsupported type answers 415', wrongType.state.status === 415, `status ${wrongType.state.status}`)
check('E unsupported type names the code', wrongType.json?.error?.code === 'unsupported-media-type', String(wrongType.json?.error?.code))
check('E unsupported type echoes what arrived', wrongType.json?.error?.details?.received === 'text/plain', JSON.stringify(wrongType.json?.error?.details))
const absentType = await call(handler, { method: 'POST', path: '/image', headers: {}, chunks: [png] })
check('F absent content-type answers 415', absentType.state.status === 415, `status ${absentType.state.status}`)
const emptyBody = await call(handler, { method: 'POST', path: '/image', headers: { 'content-type': 'image/png' }, chunks: [] })
check('G empty body answers 400', emptyBody.state.status === 400, `status ${emptyBody.state.status}`)
check('G empty body names the code', emptyBody.json?.error?.code === 'invalid-image', String(emptyBody.json?.error?.code))
check('E/F/G wrote nothing', (await files()).length === before, `${before} -> ${(await files()).length}`)

// H. an oversized upload is refused while it is still being read.
const chunkCount = 10
const oversized = await call(handler, {
  method: 'POST',
  path: '/image?name=huge.png',
  headers: { 'content-type': 'image/png' },
  chunks: Array.from({ length: chunkCount }, () => Buffer.alloc(4 * 1024 * 1024)),
})
check('H oversized upload answers 413', oversized.state.status === 413, `status ${oversized.state.status}`)
check('H oversized upload names the code', oversized.json?.error?.code === 'image-too-large', String(oversized.json?.error?.code))
check('H oversized upload reports the cap', oversized.json?.error?.details?.max === IMAGE_MAX_BYTES, JSON.stringify(oversized.json?.error?.details))
check('H reading stopped before the body ended', oversized.stats.completed === false)
check(
  'H it stopped at the cap, not at the end',
  oversized.stats.pulled === Math.ceil(IMAGE_MAX_BYTES / (4 * 1024 * 1024)) + 1,
  `pulled ${oversized.stats.pulled} of ${chunkCount}`,
)
check('H oversized upload wrote nothing', (await files()).length === before, `${before} -> ${(await files()).length}`)

// I. the other still-image types are accepted, and the size comes from the header.
const gif = gifBytes(4, 5)
const gifUpload = await call(handler, {
  method: 'POST',
  path: '/image?name=anim.gif',
  headers: { 'content-type': 'image/gif' },
  chunks: [gif],
})
const gifRef = gifUpload.json?.data?.image
check('I gif upload answers 200', gifUpload.state.status === 200, `status ${gifUpload.state.status}`)
check('I gif ref parses its size', gifRef?.width === 4 && gifRef?.height === 5, `${gifRef?.width}x${gifRef?.height}`)
check('I gif is stored under its own extension', gifRef?.id !== undefined && store.filePath(gifRef).endsWith('.gif'), String(store.filePath(gifRef ?? {})))
check('I gif media type survives the fetch', (await call(handler, { method: 'GET', path: `/image/${gifRef.id}` })).state.headers['content-type'] === 'image/gif')

for (const [mediaType, extension, bytes] of [
  ['image/jpeg', '.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ['image/webp', '.webp', Buffer.from('RIFF....WEBPVP8 ', 'latin1')],
]) {
  const uploaded = await call(handler, { method: 'POST', path: '/image?name=plain', headers: { 'content-type': mediaType }, chunks: [bytes] })
  const other = uploaded.json?.data?.image
  check(`J ${mediaType} is accepted`, uploaded.state.status === 200, `status ${uploaded.state.status}`)
  check(`J ${mediaType} is stored under ${extension}`, typeof other?.id === 'string' && store.filePath(other).endsWith(extension), String(other?.id))
  const back = await call(handler, { method: 'GET', path: `/image/${other.id}` })
  check(`J ${mediaType} comes back unchanged`, Buffer.compare(back.state.body, bytes) === 0)
}

// K/L. ids are distinct, and a long name is truncated rather than refused.
const second = await call(handler, { method: 'POST', path: '/image?name=shot.png', headers: { 'content-type': 'image/png' }, chunks: [png] })
check('K a second upload gets its own id', second.json?.data?.image?.id !== ref.id)
const longName = 'n'.repeat(IMAGE_NAME_MAX + 40)
const truncated = await call(handler, {
  method: 'POST',
  path: `/image?name=${longName}`,
  headers: { 'content-type': 'image/png' },
  chunks: [png],
})
check('L a long name is truncated', truncated.json?.data?.image?.name?.length === IMAGE_NAME_MAX, String(truncated.json?.data?.image?.name?.length))

// N. the first upload is unchanged by the later ones, and every image is two files.
// Five images were stored after A: the gif, the jpeg, the webp, the second png,
// and the long-named png.
const again = await call(handler, { method: 'GET', path: `/image/${ref.id}` })
check('N the first image is still its own', Buffer.compare(again.state.body, png) === 0)
check('N stored files are two per image', (await files()).length === before + 2 * 5, `${before} + 10 -> ${(await files()).length}`)

// O. a ref whose bytes vanished fails loud instead of answering garbage.
const orphan = (await call(handler, { method: 'POST', path: '/image?name=orphan.png', headers: { 'content-type': 'image/png' }, chunks: [png] })).json.data.image
await unlink(store.filePath(orphan))
const orphaned = await call(handler, { method: 'GET', path: `/image/${orphan.id}` })
check('O a ref without bytes answers 400', orphaned.state.status === 400, `status ${orphaned.state.status}`)
check('O a ref without bytes names the code', orphaned.json?.error?.code === 'invalid-image', String(orphaned.json?.error?.code))

await rm(dir, { recursive: true, force: true })

if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL ${failure}`)
}
console.log(`${checks - failures.length}/${checks} checks passed`)
process.exitCode = failures.length === 0 ? 0 : 1
