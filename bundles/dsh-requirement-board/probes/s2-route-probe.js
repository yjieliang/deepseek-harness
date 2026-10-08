/**
 * S2 route probe: prove that `storage-domain.routes` actually selects the
 * backend, not merely that the process started.
 *
 * A `requirement_board` domain is opened, one record is written, and the domain
 * is closed. The caller then inspects the SQLite file and the JSON backend root
 * for the write, so "routed to sqlite" and "silently fell back to json" are
 * distinguishable.
 *
 * Configuration (row `config`):
 * - `domain`   - storage unit name to open.
 * - `database` - SQLite file path the deployment routed to.
 * - `jsonRoot` - JSON backend root the fallback would write under.
 * - `result`   - result filename written next to this probe.
 *
 * The write is version 1 on purpose and the caller must delete the SQLite file
 * afterwards: the SQLite backend stamps the unit with an exact version and
 * rejects a later v2 descriptor (`version-mismatch`).
 */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Stable plugin name used by the Loader and diagnostics. */
export const name = 's2-route-probe'

/** The probe cannot run without the domain facility whose routing it measures. */
export const inject = ['storageDomain']

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** List files under `dir` as slash-separated relative paths, bounded in depth. */
function listFiles(dir, base = dir, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const label = relative(base, full).split('\\').join('/')
    if (entry.isDirectory()) {
      out.push(`${label}/`)
      out.push(...listFiles(full, base, depth + 1))
    } else {
      out.push(`${label} (${statSync(full).size}B)`)
    }
  }
  return out.sort()
}

/** Render one thrown error as `<code>: <first message line>`. */
function describe(error) {
  const code = error?.code ?? error?.name ?? 'Error'
  return `${code}: ${String(error?.message ?? error).split('\n')[0]}`
}

/**
 * Open the configured domain, write one record, and report where the medium
 * ended up.
 * @param ctx - Host plugin context carrying `storageDomain`.
 * @param config - Row config described in the module header.
 */
export async function apply(ctx, config) {
  const report = {
    importer: import.meta.url,
    node: process.version,
    pid: process.pid,
    config,
    write: null,
    error: null,
    database: null,
    jsonRoot: null,
  }
  const spec = defineDomain({
    name: config.domain,
    version: 1,
    tables: { probe: domainTable(z.object({ value: z.string() })) },
  })
  try {
    const domain = await ctx.storageDomain.open(spec)
    await domain.table('probe').put('k1', { value: 'v1' })
    report.write = domain.table('probe').get('k1') ?? null
    await domain.close()
  } catch (error) {
    report.error = describe(error)
  }
  report.database = { path: config.database, exists: existsSync(config.database) }
  report.jsonRoot = { path: config.jsonRoot, files: listFiles(config.jsonRoot) }
  writeFileSync(join(HERE, config.result), `${JSON.stringify(report, null, 2)}\n`)
  ctx.logger?.info?.(
    `s2-route-probe: domain=${config.domain} error=${report.error ?? 'none'} `
    + `dbExists=${report.database.exists} jsonFiles=${report.jsonRoot.files.length}`,
  )
}
