/**
 * S1 offline arm, second entry: a file under the plugin directory that mirrors
 * what `node tests/domain.mjs` (stage 0) will import and declare. Plain Node
 * resolves both bare specifiers from the plugin root's `node_modules`, exactly
 * as it will for `tests/*.mjs` (same package root, same lookup chain).
 *
 * Usage (from the plugin directory):
 *   node probes/s1-offline-spec.mjs
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const spec = defineDomain({
  name: 'requirement_board',
  version: 2,
  compatibleVersions: [1],
  tables: {
    requirements: domainTable(z.object({ id: z.string(), title: z.string() })),
    templates: domainTable(z.object({ id: z.string() })),
    roles: domainTable(z.object({ id: z.string() })),
    queues: domainTable(z.object({ sessionId: z.string() })),
  },
  global: {
    schema: z.object({ schemaVersion: z.number(), revision: z.number() }),
    initial: { schemaVersion: 2, revision: 0 },
  },
})

console.log(`zod                   ${(await import('zod/package.json', { with: { type: 'json' } })).default.version}`)
console.log(`domain name           ${spec.name}`)
console.log(`domain version        ${spec.version}`)
console.log(`compatibleVersions    ${spec.compatibleVersions.join(', ')}`)
console.log(`tables                ${Object.keys(spec.tables).join(', ')}`)
console.log(`global initial        ${JSON.stringify(spec.global.initial)}`)
console.log(`record schema parse   ${JSON.stringify(spec.tables.requirements.valueSchema.parse({ id: 'r1', title: 't' }))}`)
