/**
 * S2 measurement, offline arm: compute the profile's runtime resolution and
 * read the interception package table the Loader will use for bare plugin
 * names. Also reproduces the storage unit-name rule that decides the routes key.
 *
 * Run from the repository root:
 *   node .artifacts/requirement-board/probes/s2-resolution.mjs
 *
 * It writes nothing; it only reads the `web` profile manifest and the plugin
 * directory, so it can run while dsh 3080 is live.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'C:/code/deepseek-harness'
const INSTALL_ANCHOR = `${REPO}/apps/cli/package.json`
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const appBoot = await import(pathToFileURL(`${REPO}/packages/boot/app-boot/lib/index.js`).href)
const { createRuntimeResolution, loadProfile } = appBoot

const profile = loadProfile('dsh', 'web', INSTALL_ANCHOR, HOME)
const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile, home: HOME })

console.log(`home            ${HOME}`)
console.log(`installAnchor   ${INSTALL_ANCHOR}`)
console.log(`profileDir      ${profile.dir}`)
console.log(`linkedRoots     ${resolution.linkedRoots.map(root => `${root.name}=${root.realPath}`).join(' | ')}`)
console.log(`localPackages   ${resolution.localPackageNames.join(', ')}`)
console.log('entries matching zod / storage:')
for (const entry of resolution.entries.filter(candidate => /^(zod|@deepseek-ai\/dsh-storage)/.test(candidate.name))) {
  console.log(`  ${entry.scope.padEnd(12)} ${entry.name.padEnd(36)} ${entry.version ?? '-'} -> ${entry.packageDir}`)
}
const sqlite = resolution.entries.find(entry => entry.name === '@deepseek-ai/dsh-storage-sqlite')
console.log(`storage-sqlite entry: ${sqlite === undefined ? 'ABSENT' : `${sqlite.scope} -> ${sqlite.packageDir}`}`)

console.log('--- storage unit-name rule ---')
const storage = await import('@deepseek-ai/dsh-storage')
const { defineDomain } = await import('@deepseek-ai/dsh-storage-domain')
console.log(`UNIT_NAME_RE = ${storage.UNIT_NAME_RE}`)
try {
  defineDomain({ name: 'requirement-board', version: 1, tables: {} })
  console.log("defineDomain('requirement-board') -> accepted")
} catch (error) {
  console.log(`defineDomain('requirement-board') -> ${String(error.message).split('\n')[0]}`)
}
try {
  defineDomain({ name: 'requirement_board', version: 1, tables: {} })
  console.log("defineDomain('requirement_board') -> accepted")
} catch (error) {
  console.log(`defineDomain('requirement_board') -> ${String(error.message).split('\n')[0]}`)
}
