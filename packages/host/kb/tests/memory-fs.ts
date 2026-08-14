/**
 * In-memory FileSystem for kb engine tests: a flat map of paths to content,
 * with directory entries materialized implicitly (a written `x/.keep` makes `x`
 * listable). Mirrors the primitives the engine uses: resolve, contains, stat,
 * listDir, readText, writeText, readBytes.
 */

import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** One stored entry. */
interface Entry {
  kind: 'file' | 'directory'
  text: string
  version: number
}

/** A minimal in-memory fake implementing the provider primitives the engine calls. */
export class MemoryFs extends FileSystem {
  readonly entries = new Map<string, Entry>()

  /** Seed a file (and its parent directory chain) directly. */
  seed(path: string, text: string): void {
    this.ensureParents(path)
    this.entries.set(path, { kind: 'file', text, version: 1 })
  }

  private ensureParents(path: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!this.entries.has(dir)) this.entries.set(dir, { kind: 'directory', text: '', version: 1 })
    }
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string { return `memory:///${encodeURIComponent(String(target.targetKey))}` }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.targetKey === parent.targetKey
      || String(child.targetKey).startsWith(`${parent.targetKey}/`)
  }

  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined) return undefined
    return { version: FsVersion(String(entry.version)), type: entry.kind, ...entry.kind === 'file' ? { size: entry.text.length } : {} }
  }

  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const entry = this.entries.get(path)
    if (entry === undefined) return undefined
    return { version: FsVersion(String(entry.version)), type: entry.kind, ...entry.kind === 'file' ? { size: entry.text.length } : {} }
  }

  override async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    if (this.entries.get(target.targetKey)?.kind !== 'directory') {
      throw new FsError(`not a directory: ${target.displayPath}`, 'FS_NOT_DIRECTORY')
    }
    const prefix = target.targetKey === '' ? '' : `${target.targetKey}/`
    const out: FsDirEntry[] = []
    for (const [path, entry] of this.entries) {
      if (!path.startsWith(prefix) || path === target.targetKey) continue
      const rest = path.slice(prefix.length)
      if (rest.includes('/')) continue
      out.push({
        name: rest,
        type: entry.kind,
        target: { targetKey: FsTargetKey(path), displayPath: path },
        version: FsVersion(String(entry.version)),
        ...entry.kind === 'file' ? { size: entry.text.length } : {},
      })
    }
    return out
  }

  override async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
    const entry = this.entries.get(target.targetKey)
    if (entry === undefined || entry.kind !== 'file') {
      throw new FsError(`not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    return entry.text
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const text = await this.readText(target)
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > maxBytes) {
      throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    this.ensureParents(target.targetKey)
    const before = this.entries.get(target.targetKey)
    const version = (before?.version ?? 0) + 1
    this.entries.set(target.targetKey, { kind: 'file', text: content, version })
    return {
      operation: before === undefined ? 'create' : 'update',
      version: FsVersion(String(version)),
      before: before?.kind === 'file' ? before.text : null,
      after: content,
    }
  }

  override async editText(_target: FsTarget, _edit: FsEditRequest): Promise<FsEditOutcome> {
    throw new Error('MemoryFs: editText is not exercised by kb engine tests')
  }
}
