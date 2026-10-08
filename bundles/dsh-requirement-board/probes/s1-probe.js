/**
 * S1 dependency resolution, in-process arm.
 *
 * This function plugin is mounted by the real Loader inside a real `dsh`
 * process (see `s1.overlay.yml`), from a file below the linked root
 * `.artifacts/requirement-board`. It therefore measures the question S1
 * actually asks: can code at the bundle location import these bare specifiers
 * once the Harness profile interception is installed.
 *
 * It writes its raw result next to itself (`s1-in-process.json`) and logs one
 * line per specifier, so the evidence survives even when the process is later
 * stopped.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 's1-probe'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SPECIFIERS = [
  'zod',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-sqlite',
]

/** Render one thrown error as `<code>: <first message line>`. */
function describe(error) {
  const code = error?.code ?? error?.name ?? 'Error'
  return `${code}: ${String(error?.message ?? error).split('\n')[0]}`
}

/**
 * Measure each specifier and persist the report.
 * @param ctx - Host plugin context, used only for logging.
 */
export async function apply(ctx) {
  const report = {
    importer: import.meta.url,
    node: process.version,
    pid: process.pid,
    results: {},
  }
  for (const specifier of SPECIFIERS) {
    const entry = {}
    try {
      entry.resolve = import.meta.resolve(specifier)
    } catch (error) {
      entry.resolveError = describe(error)
    }
    try {
      const module = await import(specifier)
      entry.import = 'ok'
      entry.keys = Object.keys(module).slice(0, 8)
    } catch (error) {
      entry.importError = describe(error)
    }
    report.results[specifier] = entry
  }
  const out = join(HERE, 's1-in-process.json')
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  ctx.logger?.info?.(`s1-probe: wrote ${out}`)
  for (const [specifier, entry] of Object.entries(report.results)) {
    ctx.logger?.info?.(`s1-probe: ${specifier} resolve=${entry.resolve ?? entry.resolveError} import=${entry.import ?? entry.importError}`)
  }
}
