#!/usr/bin/env node
/**
 * Stage R: independent comparison of the composed `web` profile (the production
 * patch layer) against the development overlay (`dev.overlay.yml`).
 *
 * Both `--dump-config` outputs are patch-list YAML; this reads them as text
 * (PowerShell wrote them UTF-16LE), splits them into layer/entry blocks, and
 * reports the difference list plus the facts the production layer has to carry.
 * It does not parse the YAML dialect: entry blocks are compared line by line
 * after normalizing the one documented dev/prod difference (the sqlite file path)
 * and the layer header comments.
 *
 * Usage (from the repository root):
 *   node .artifacts/requirement-board/tests/verification/r-dumpconfig.mjs <prod-dump> <dev-dump>
 */

import { readFileSync } from 'node:fs'

const [prodPath, devPath] = process.argv.slice(2)
if (prodPath === undefined || devPath === undefined) {
  console.error('usage: r-dumpconfig.mjs <prod-dump> <dev-dump>')
  process.exit(2)
}

/** Read one PowerShell-written dump, tolerant of its UTF-16LE encoding. */
function readDump(path) {
  const buffer = readFileSync(path)
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString('utf16le') : buffer.toString('utf8')
  return text.replace(/^\uFEFF/, '').split(/\r?\n/)
}

/** Split one dump into layers, and index every entry id onto its last block. */
function parseDump(lines) {
  const layers = []
  let layer = { name: '(preamble)', entries: [] }
  let entry = null
  const push = () => { if (entry !== null) { layer.entries.push(entry); entry = null } }
  for (const line of lines) {
    const header = /^# == (.+?)\s*$/.exec(line)
    if (header !== null) {
      push()
      if (layer.entries.length > 0 || layer.name !== '(preamble)') layers.push(layer)
      layer = { name: header[1], entries: [] }
      continue
    }
    const idLine = /^-\s+id:\s*(\S+)\s*$/u.exec(line)
    if (idLine !== null) {
      push()
      entry = { id: idLine[1], name: '', block: [line] }
      continue
    }
    if (entry !== null) {
      entry.block.push(line)
      const nameLine = /^\s+name:\s*(.+?)\s*$/.exec(line)
      if (nameLine !== null && entry.name === '') entry.name = nameLine[1]
    }
  }
  push()
  if (layer.entries.length > 0 || layer.name !== '(preamble)') layers.push(layer)
  const index = new Map()
  for (const item of layers) for (const item2 of item.entries) index.set(item2.id, { ...item2, layer: item.name })
  return { layers, index }
}

/** Normalize the documented dev/prod difference so only real drift survives. */
function normalize(block) {
  return block.map(line => line
    .replace(/C:\/code\/deepseek-harness\/\.artifacts\/requirement-board\/dev-board\.db/giu, '<SQLITE_PATH>')
    .replace(/C:\/Users\/Administrator\/\.dsh\/storages\/requirement_board\.db/giu, '<SQLITE_PATH>')
    .replace(/C:\\code\\deepseek-harness\\\.artifacts\\requirement-board\\dev-board\.db/giu, '<SQLITE_PATH>')
    .replace(/C:\\Users\\Administrator\\\.dsh\\storages\\requirement_board\.db/giu, '<SQLITE_PATH>')
    .replace(/\s+$/u, ''))
}

const prod = parseDump(readDump(prodPath))
const dev = parseDump(readDump(devPath))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const section = title => console.log(`\n== ${title}`)

section('shape')
console.log(`prod layers = ${prod.layers.length}, entries = ${prod.index.size}  (${prodPath})`)
console.log(`dev  layers = ${dev.layers.length}, entries = ${dev.index.size}  (${devPath})`)
for (const layer of prod.layers) console.log(`  prod layer ${layer.name} entries=${layer.entries.length}`)
for (const layer of dev.layers) console.log(`  dev  layer ${layer.name} entries=${layer.entries.length}`)

section('entry set difference')
const onlyProd = [...prod.index.keys()].filter(id => !dev.index.has(id)).sort()
const onlyDev = [...dev.index.keys()].filter(id => !prod.index.has(id)).sort()
console.log(`only in prod = ${onlyProd.length === 0 ? '(none)' : onlyProd.join(', ')}`)
console.log(`only in dev  = ${onlyDev.length === 0 ? '(none)' : onlyDev.join(', ')}`)

section('block difference after normalizing the sqlite path')
const differing = []
for (const [id, prodEntry] of prod.index) {
  const devEntry = dev.index.get(id)
  if (devEntry === undefined) continue
  if (prodEntry.name !== devEntry.name) differing.push({ id, reason: `name ${prodEntry.name} vs ${devEntry.name}` })
  const left = normalize(prodEntry.block)
  const right = normalize(devEntry.block)
  if (left.join('\n') !== right.join('\n')) {
    const diff = []
    const max = Math.max(left.length, right.length)
    for (let i = 0; i < max; i += 1) if (left[i] !== right[i]) diff.push(`    prod[${i}]=${JSON.stringify(left[i])} dev[${i}]=${JSON.stringify(right[i])}`)
    differing.push({ id, reason: 'block', diff })
  }
}
if (differing.length === 0) console.log('(no difference)')
for (const item of differing) {
  console.log(`  DIFF ${item.id} (${item.reason})`)
  for (const line of item.diff ?? []) console.log(line)
}

section('facts the production layer must carry')
const prodText = prod.layers.filter(layer => layer.name !== '@deepseek-ai/dsh-base').map(layer => layer.entries.map(entry => entry.block.join('\n')).join('\n')).join('\n')
const boardRow = prod.index.get('requirement-board')
check('the plugin row is present', boardRow !== undefined, boardRow === undefined ? 'missing' : '')
check('the plugin row names dsh-requirement-board', boardRow?.name === 'dsh-requirement-board', boardRow?.name ?? '')
check('the plugin row turns the one-time import off', boardRow !== undefined && boardRow.block.join('\n').includes('importLegacy: false'), '')
const sqlite = prod.index.get('storage-sqlite')
const sqliteBlock = sqlite?.block.join('\n') ?? ''
check('storage-sqlite points at the production database', sqliteBlock.includes('C:/Users/Administrator/.dsh/storages/requirement_board.db') || sqliteBlock.includes('C:\\Users\\Administrator\\.dsh\\storages\\requirement_board.db'), sqliteBlock.split('\n').filter(line => line.includes('path'))[0] ?? sqliteBlock)
check('storage-sqlite uses WAL', sqliteBlock.includes('journalMode: wal'), '')
check('the production layer names no dev database', prodText.includes('dev-board.db') === false, '')
const domain = prod.index.get('storage-domain')
const domainBlock = domain?.block.join('\n') ?? ''
check('storage-domain keeps backend json', /backend:\s*json/u.test(domainBlock), domainBlock)
check('the route key is the storage unit name with an underscore', /requirement_board:\s*sqlite/u.test(domainBlock), domainBlock)
check('no hyphenated route key is present', /requirement-board:\s*sqlite/u.test(domainBlock) === false, '')
for (const preset of ['godot-review-board', 'godot-game-suite', 'game-mechanics-designer', 'godot-shader-developer']) {
  const entry = prod.index.get(`preset-${preset}`)
  const block = entry?.block.join('\n') ?? ''
  check(`preset ${preset} carries a board-role declaration`, entry !== undefined && block.includes('dsh-requirement-board/role') && block.includes(`roleId: ${preset}`), entry === undefined ? 'preset entry missing' : '')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
