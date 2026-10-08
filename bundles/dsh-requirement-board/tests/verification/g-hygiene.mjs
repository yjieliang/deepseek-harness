/**
 * G-stage section C: hygiene and residue inventory.
 *
 *   all      byte hygiene of every text file under `tests/` and the board root,
 *            JSON parse of every document, residue inventory, and — when both
 *            deployment snapshots exist — the `~/.dsh` before/after comparison.
 *   before   write the `~/.dsh` snapshot used as the baseline.
 *   after    write the post-run `~/.dsh` snapshot and compare with the baseline.
 *
 * Raw capture logs (`tests/verification/_*.txt`, UTF-16LE from PowerShell
 * redirection) are exempt from the byte checks by class, as are `*.raw.json`
 * evidence files. `node --check` runs from the runner, not here: this sandbox
 * cannot capture a child process's piped stdio.
 *
 * Usage: node --import tsx/esm tests/verification/g-hygiene.mjs [all|before|after]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOARD = resolve(process.env.G_BOARD ?? resolve(HERE, '..', '..'))
const TESTS = join(BOARD, 'tests')
const MODE = process.argv[2] ?? 'all'
const DSH = join(homedir(), '.dsh')
const SNAP_BEFORE = join(HERE, '_g_dsh_before.txt')
const SNAP_AFTER = join(HERE, '_g_dsh_after.txt')
const TEXT_EXT = /\.(mjs|js|cjs|json|md|yml|yaml|svg|css|ts|tsx)$/
const EXEMPT = name => name.endsWith('.raw.json') || (name.startsWith('_') && name.endsWith('.txt'))

let checks = 0
let failures = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

/** Text files under a directory, with the exempt classes removed. */
function textFiles(dir, found = [], depth = 0) {
  if (depth > 4) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) textFiles(full, found, depth + 1)
    else if (TEXT_EXT.test(entry.name) && !EXEMPT(entry.name)) found.push(full)
  }
  return found
}

const ROOT_FILES = readdirSync(BOARD, { withFileTypes: true })
  .filter(entry => entry.isFile() && TEXT_EXT.test(entry.name) && !EXEMPT(entry.name))
  .map(entry => join(BOARD, entry.name))

if (MODE === 'all') {
  const files = [...ROOT_FILES, ...textFiles(TESTS), ...textFiles(join(BOARD, 'locale')), ...textFiles(join(BOARD, 'probes'))]
  console.log(`\n[C1] byte hygiene of ${files.length} text files (tests/ + locale/ + probes/ + board root, raw logs exempt)`)
  const offenders = { bom: [], cr: [], tail: [], utf8: [] }
  for (const file of files) {
    const label = relative(BOARD, file).replace(/\\/g, '/')
    const bytes = readFileSync(file)
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offenders.bom.push(label)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      offenders.utf8.push(label)
    }
    if (text.includes('\r')) offenders.cr.push(label)
    if (!text.endsWith('\n') || text.endsWith('\n\n') || text.length === 0) offenders.tail.push(label)
  }
  check(`${files.length} text files carry no UTF-8 BOM`, offenders.bom.length === 0, offenders.bom.join(', '))
  check(`${files.length} text files are valid UTF-8`, offenders.utf8.length === 0, offenders.utf8.slice(0, 8).join(', '))
  check(`${files.length} text files use LF only (no CR)`, offenders.cr.length === 0, offenders.cr.join(', '))
  check(`${files.length} text files end with exactly one LF`, offenders.tail.length === 0, offenders.tail.join(', '))

  const jsonFiles = files.filter(file => file.endsWith('.json'))
  const badJson = []
  for (const file of jsonFiles) {
    try {
      JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      badJson.push(`${relative(BOARD, file).replace(/\\/g, '/')} (${error.message})`)
    }
  }
  check(`${jsonFiles.length} JSON documents parse`, badJson.length === 0, badJson.join('; '))

  console.log('\n[C2] residue inventory (report only; the Lead cleans)')
  const residue = []
  for (const entry of readdirSync(BOARD, { withFileTypes: true })) {
    if (/^dev-board\.db/.test(entry.name)) residue.push(`${entry.name} ${statSync(join(BOARD, entry.name)).size} bytes`)
  }
  for (const name of readdirSync(HERE)) {
    if (/^_red-|^_tmp/.test(name)) residue.push(`tests/verification/${name}`)
    if (/^_g_/.test(name)) residue.push(`tests/verification/${name} ${statSync(join(HERE, name)).size} bytes (this stage's evidence, kept)`)
  }
  const temps = readdirSync(tmpdir()).filter(name => /^(e-verify|e-compose|e-live|rb-)/.test(name))
  console.log(`  board residue: ${residue.filter(line => !line.startsWith('tests/')).join(', ') || '(none)'}`)
  console.log(`  stage leftovers in tests/verification: ${residue.filter(line => line.startsWith('tests/')).length}`)
  console.log(`  %TEMP% candidates (${tmpdir()}): ${temps.join(', ') || '(none)'}`)

  console.log('\n[C3] ~/.dsh before/after (bucket: file count + sha256 of path|size|mtime)')
  if (existsSync(SNAP_BEFORE) && existsSync(SNAP_AFTER)) {
    const before = parseSnapshot(readFileSync(SNAP_BEFORE, 'utf8'))
    const after = parseSnapshot(readFileSync(SNAP_AFTER, 'utf8'))
    const buckets = [...new Set([...before.buckets.keys(), ...after.buckets.keys()])].sort()
    let changed = 0
    for (const bucket of buckets) {
      const left = before.buckets.get(bucket) ?? { count: 0, hash: '(absent)' }
      const right = after.buckets.get(bucket) ?? { count: 0, hash: '(absent)' }
      const same = left.count === right.count && left.hash === right.hash
      if (!same) changed += 1
      console.log(`  ${same ? 'same' : 'DIFF'} ${bucket}: ${left.count} → ${right.count} files`)
    }
    check('the deployment tree outside harness-owned session state is unchanged', ![...before.buckets.keys()].some(bucket => /^(profiles|bundles|requirement-board)$/.test(bucket) && (before.buckets.get(bucket).hash !== after.buckets.get(bucket)?.hash)), 'a profile/bundle/requirement-board bucket moved')
    console.log(`  buckets compared: ${buckets.length}, differing: ${changed}`)
  } else {
    console.log('  (run `before` and `after` around the stage to compare; nothing to diff yet)')
  }
}

/** Snapshot `~/.dsh` per top-level bucket: file count plus one hash of every path+size+mtime. */
function snapshot() {
  const buckets = new Map()
  const walk = (dir, bucket, lines, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full, bucket, lines, depth + 1)
      } else {
        const info = statSync(full)
        lines.push(`${relative(DSH, full).split(sep).join('/')}|${info.size}|${Math.round(info.mtimeMs)}`)
      }
    }
  }
  for (const entry of readdirSync(DSH, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const lines = []
    walk(join(DSH, entry.name), entry.name, lines, 0)
    lines.sort()
    buckets.set(entry.name, { count: lines.length, hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) })
  }
  return buckets
}

function parseSnapshot(text) {
  const buckets = new Map()
  for (const line of text.split('\n')) {
    const match = /^(\S+)\t(\d+)\t(\S+)$/.exec(line)
    if (match !== null) buckets.set(match[1], { count: Number(match[2]), hash: match[3] })
  }
  return { buckets }
}

function writeSnapshot(path) {
  const buckets = snapshot()
  const lines = [...buckets.entries()].sort().map(([bucket, value]) => `${bucket}\t${value.count}\t${value.hash}`)
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  const total = lines.reduce((sum, line) => sum + Number(line.split('\t')[1]), 0)
  console.log(`  wrote ${relative(BOARD, path).replace(/\\/g, '/')}: ${buckets.size} buckets, ${total} files`)
}

if (MODE === 'before' || MODE === 'after') {
  console.log(`\n[C3] ~/.dsh snapshot (${MODE})`)
  writeSnapshot(MODE === 'before' ? SNAP_BEFORE : SNAP_AFTER)
}

if (MODE !== 'all') {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
