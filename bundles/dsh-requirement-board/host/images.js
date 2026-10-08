/**
 * The board's pasted-image store.
 *
 * A requirement record carries image *refs* only: the encoded bytes live outside
 * it, one file per image under the board's image directory, with a small JSON
 * metadata file beside it holding that ref. Keeping the bytes out of the record
 * is what keeps a record small enough for the domain's tables, and the file is
 * what an agent opens when a requirement names an image.
 *
 * The files are immutable. Archiving or deleting a requirement never removes
 * them: one image id may be referenced by more than one record, and an upload is
 * readable before any record names it. Orphan files are therefore expected, and
 * they are not dangling references — no record points at them.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { fail, nowIso } from './model.js'

/**
 * Media types accepted for a pasted image. These are the still-image types the
 * attachment store admits (`attachment-local`'s `imageLimits.mediaTypes`), so a
 * picture a person can paste into a prompt is a picture the board stores.
 */
const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The file extension one accepted media type is stored under. */
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
})

/**
 * Largest accepted image, in bytes. Matches `attachment-local`'s
 * `DEFAULT_MAX_IMAGE_BYTES`, so the board refuses exactly what the prompt-side
 * store would refuse rather than admitting a file no model request could carry.
 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** Most images one requirement may carry. */
export const IMAGE_MAX_COUNT = 20

/** Longest accepted original file name. */
export const IMAGE_NAME_MAX = 255

/** Shape of every stored image id; the id is the file-name stem, so it is strictly checked. */
export const IMAGE_ID_RE = /^img-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * One stored image ref: the record's pointer at bytes held outside it.
 *
 * The media type is a closed set with the same `; value <json>` issue tail the
 * domain's stored enums use (`host/domain.js`), because a record read back from
 * a medium edited outside this plugin is the one failure an operator has to
 * diagnose from the message.
 */
export const imageRefSchema = z.object({
  id: z.string().regex(IMAGE_ID_RE, { error: issue => `stored image id is not a board image id; value ${JSON.stringify(issue.input)}` }),
  name: z.string().max(IMAGE_NAME_MAX),
  mediaType: z.enum(IMAGE_MEDIA_TYPES, {
    error: issue => `stored mediaType is not one of ${IMAGE_MEDIA_TYPES.join('|')}; value ${JSON.stringify(issue.input)}`,
  }),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
}).strict()

/**
 * Normalize one request's media type to the bare form the store accepts.
 * @param value - Raw `content-type` header value, parameters included.
 * @returns the lowercase media type without parameters; `''` when absent.
 */
function normalizeMediaType(value) {
  if (typeof value !== 'string') return ''
  return value.split(';')[0].trim().toLowerCase()
}

/** Read a little-endian 24-bit unsigned integer. */
function uint24(view, offset) {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
}

/** PNG: the `IHDR` chunk directly follows the 8-byte signature. */
function pngSize(view) {
  if (view.byteLength < 24) return null
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null
  if (view.getUint32(12) !== 0x49484452) return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** GIF: `GIF87a`/`GIF89a` followed by the little-endian logical screen size. */
function gifSize(view) {
  if (view.byteLength < 10) return null
  if (view.getUint32(0) !== 0x47494638) return null
  const version = view.getUint16(4)
  if (version !== 0x3961 && version !== 0x3761) return null
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

/** JPEG: walk the marker segments to the first frame header. */
function jpegSize(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null
    const marker = view.getUint8(offset + 1)
    // Standalone markers carry no length; entropy-coded data means no frame
    // header was seen, so the size is not readable from this file.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const length = view.getUint16(offset + 2)
    if (length < 2) return null
    // SOF0-SOF15 except DHT (C4), JPG (C8), and DAC (CC).
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (offset + 9 > view.byteLength) return null
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

/** WebP: the `VP8X`, `VP8 `, and `VP8L` chunks each carry the canvas size. */
function webpSize(view) {
  if (view.byteLength < 30) return null
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return null
  const chunk = view.getUint32(12)
  if (chunk === 0x56503858) return { width: 1 + uint24(view, 24), height: 1 + uint24(view, 27) }
  if (chunk === 0x56503820) {
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) return null
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (chunk === 0x5650384c) {
    if (view.getUint8(20) !== 0x2f) return null
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

/**
 * Read the intrinsic pixel size of one encoded image from its header.
 *
 * Only the four accepted containers are read, and only their header: the bytes
 * are stored verbatim and never decoded, so storing a picture never costs a
 * decode. An image whose header cannot be read reports `0` for both sides rather
 * than a guessed size.
 * @param bytes - Encoded image bytes.
 * @param mediaType - One accepted media type.
 * @returns `{ width, height }`.
 */
function imageDimensions(bytes, mediaType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = mediaType === 'image/png' ? pngSize(view)
    : mediaType === 'image/jpeg' ? jpegSize(view)
      : mediaType === 'image/webp' ? webpSize(view)
        : mediaType === 'image/gif' ? gifSize(view)
          : null
  return { width: size?.width ?? 0, height: size?.height ?? 0 }
}

/** The metadata file of one stored image. */
function metaPath(dir, id) {
  return join(dir, `${id}.json`)
}

/**
 * One board's image files: a directory of `<id>.<ext>` bytes files, each with the
 * `<id>.json` metadata file that holds its ref.
 */
export class ImageStore {
  /** @type {string} Absolute directory holding every stored image. */
  #dir

  /**
   * @param dir - Absolute directory holding the image files; created on the first write.
   */
  constructor(dir) {
    this.#dir = dir
  }

  /** @returns the absolute directory the files live in. */
  get directory() {
    return this.#dir
  }

  /**
   * Store one uploaded image and answer with the ref a record then carries.
   *
   * Validation happens before anything is written, so a refused upload leaves no
   * file behind. The bytes land before the metadata: an interrupted upload leaves
   * an orphan file, never a ref whose bytes are missing.
   * @param input - `{ bytes, mediaType, name }`; `name` is the original file
   * name (may be absent) and the media type is the request's own header value.
   * @returns the stored ref.
   */
  async put({ bytes, mediaType, name } = {}) {
    const type = normalizeMediaType(mediaType)
    if (!IMAGE_MEDIA_TYPES.includes(type)) {
      fail('unsupported-media-type', `unsupported image type "${type === '' ? 'absent' : type}"; accepted: ${IMAGE_MEDIA_TYPES.join(', ')}`, { received: type })
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      fail('invalid-image', 'the uploaded image carries no bytes')
    }
    if (bytes.byteLength > IMAGE_MAX_BYTES) {
      fail('image-too-large', `the uploaded image is ${bytes.byteLength} bytes; the cap is ${IMAGE_MAX_BYTES}`, {
        byteLength: bytes.byteLength,
        max: IMAGE_MAX_BYTES,
      })
    }
    const id = `img-${randomUUID()}`
    const ref = {
      id,
      name: typeof name === 'string' ? name.trim().slice(0, IMAGE_NAME_MAX) : '',
      mediaType: type,
      byteLength: bytes.byteLength,
      ...imageDimensions(bytes, type),
      createdAt: nowIso(),
    }
    await mkdir(this.#dir, { recursive: true })
    await writeFile(this.filePath(ref), bytes)
    await writeFile(metaPath(this.#dir, id), `${JSON.stringify(ref)}\n`)
    return ref
  }

  /**
   * The ref of one stored image, or `undefined` when nothing was stored under it.
   *
   * The id shape and the metadata file are both checked at this durable read
   * boundary: a ref that fails either is refused loud rather than written into a
   * record that would then stop the next open.
   * @param id - Image id.
   * @returns the stored ref, or `undefined` for an id that names no image.
   */
  async ref(id) {
    if (typeof id !== 'string' || !IMAGE_ID_RE.test(id)) return undefined
    let text
    try {
      text = await readFile(metaPath(this.#dir, id), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      fail('invalid-image', `stored image "${id}" has an unreadable metadata file: ${error.message}`, { id })
    }
    const parsed = imageRefSchema.safeParse(raw)
    if (!parsed.success || parsed.data.id !== id) {
      const issue = parsed.success ? null : parsed.error.issues[0]
      fail('invalid-image', `stored image "${id}" has a metadata file this board cannot read${issue === null ? `: it names "${String(raw?.id)}"` : `: ${issue.path.join('.')}: ${issue.message}`}`, { id })
    }
    return parsed.data
  }

  /**
   * The bytes and media type of one stored image.
   * @param id - Image id.
   * @returns `{ mediaType, bytes }`, or `undefined` for an id that names no image.
   */
  async read(id) {
    const ref = await this.ref(id)
    if (ref === undefined) return undefined
    const path = this.filePath(ref)
    let bytes
    try {
      bytes = await readFile(path)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail('invalid-image', `stored image "${id}" has a ref but no bytes file at ${path}`, { id, path })
      }
      throw error
    }
    return { mediaType: ref.mediaType, bytes }
  }

  /**
   * The absolute path of one ref's bytes file.
   * @param ref - Stored ref.
   * @returns the absolute path.
   */
  filePath(ref) {
    const extension = IMAGE_EXTENSIONS[ref?.mediaType]
    if (extension === undefined || typeof ref?.id !== 'string' || !IMAGE_ID_RE.test(ref.id)) {
      fail('invalid-image', `"${String(ref?.id)}" is not a stored image ref`, { id: ref?.id })
    }
    return join(this.#dir, `${ref.id}${extension}`)
  }
}
