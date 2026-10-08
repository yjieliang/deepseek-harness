/**
 * G-stage section B: which assertions compare a whole receipt (or a whole
 * stored record) by value, and therefore break when a field is added?
 *
 * The plugin's suites use a local `check(label, ok, detail)` helper and named
 * field predicates; `node:assert` deep equality appears nowhere. Whole-value
 * equality therefore shows up in exactly three mechanical forms:
 *
 *   R1  `JSON.stringify(<call result>) === JSON.stringify({ …literal… })`
 *   R2  `JSON.stringify(<call result>) === <variable>`        (record snapshot)
 *   R3  `Object.keys(<value>)… === JSON.stringify([…literal…])` (exact key set)
 *
 * This instrument extracts every occurrence, classifies it, and reports which
 * ones carry the four fields added during stages C/D/E (`changed`,
 * `settledDelegations`, `unbound`, `queued`). Run the listed suites with the
 * runner in the report; the module itself only classifies.
 *
 * Usage: node --import tsx/esm tests/verification/g-receipts.mjs [tests-root]
 * Env:   G_TESTS_ROOT overrides the scanned root.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.G_TESTS_ROOT ?? process.argv[2] ?? join(HERE, '..'))
const NEW_FIELDS = ['changed', 'settledDelegations', 'unbound', 'queued']

let checks = 0
let failures = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

/** Every `.mjs` under the tests root, excluding raw capture logs and this stage's own instruments. */
function suites(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('_')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) suites(full, found)
    else if (entry.name.endsWith('.mjs') && !/^g-/.test(entry.name)) found.push(full)
  }
  return found
}

/** Count top-level keys of a shallow object literal. */
const literalKeys = text => {
  const inner = text.slice(1, -1)
  const keys = []
  let depth = 0
  let start = 0
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      keys.push(inner.slice(start, index))
      start = index + 1
    }
  }
  keys.push(inner.slice(start))
  return keys.map(part => part.trim().split(':')[0].replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)
}

const rows = []
for (const file of suites()) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const where = `${relative(ROOT, file).replace(/\\/g, '/')}:${index + 1}`
    for (const match of line.matchAll(/JSON\.stringify\((.+?)\)\s*===\s*JSON\.stringify\((\{[^{}]*\})\)/g)) {
      const keys = literalKeys(match[2])
      rows.push({ where, form: 'R1', subject: match[1].trim(), keys, literal: match[2] })
    }
    for (const match of line.matchAll(/JSON\.stringify\((.+?)\)\s*===\s*([A-Za-z_$][\w$.]*)\s*[,)]/g)) {
      rows.push({ where, form: 'R2', subject: match[1].trim(), keys: [], literal: match[2] })
    }
    for (const match of line.matchAll(/Object\.keys\((.+?)\)\s*\.sort\(\)[^=]*===\s*JSON\.stringify\((\[[^\]]*\])\)/g)) {
      rows.push({ where, form: 'R3', subject: match[1].trim(), keys: literalKeys(match[2]), literal: match[2] })
    }
    for (const match of line.matchAll(/JSON\.stringify\((.+?)\)\s*===\s*JSON\.stringify\((.+?)\)\s*[,)]/g)) {
      if (/^\{[^{}]*\}$/.test(match[2].trim())) continue // already counted as R1
      if (match[1].trim() === match[2].trim()) continue
      rows.push({ where, form: 'R4', subject: match[1].trim(), keys: [], literal: match[2].trim() })
    }
  })
}

const classify = row => {
  if (row.form === 'R3') return 'exact key set'
  if (row.form === 'R4') return 'read-path consistency'
  if (/raw\(|\.domain\.table\(|storedBefore/.test(row.subject)) return 'stored record'
  if (/pick\(/.test(row.subject)) return 'field projection'
  if (/service\.\w+\(|\.\w+\(|await /.test(row.subject)) return 'api receipt'
  if (/\.\w+(\.\w+)*$/.test(row.subject)) return 'sub-value'
  return 'other'
}

console.log(`\n[B1] whole-value equality assertions under ${relative(process.cwd(), ROOT) || '.'}`)
console.log(`  ${rows.length} occurrences in ${new Set(rows.map(row => row.where.split(':')[0])).size} files`)
for (const row of rows.filter(entry => entry.form !== 'R4').sort((a, b) => a.where.localeCompare(b.where))) {
  const cls = classify(row)
  const carries = NEW_FIELDS.filter(field => row.literal.includes(field))
  console.log(`  ${row.where} [${row.form}/${cls}] ${row.subject} === ${row.literal}${carries.length > 0 ? `  ← ${carries.join('+')}` : ''}`)
}
const readPath = rows.filter(row => row.form === 'R4')
console.log(`  [R4/read-path consistency] ${readPath.length} comparisons between two read paths, in ${new Set(readPath.map(row => row.where.split(':')[0])).size} files: ${[...new Set(readPath.map(row => row.where.split(':')[0]))].join(', ')}`)
for (const row of readPath.slice(0, 6)) console.log(`       e.g. ${row.where} ${row.subject} === ${row.literal}`)

const wholeReceipts = rows.filter(row => (row.form === 'R1' || row.form === 'R2') && classify(row) === 'api receipt')
const keySets = rows.filter(row => row.form === 'R3')
console.log(`\n[B2] classes: ${wholeReceipts.length} whole api receipts, ${keySets.length} exact key sets, ${rows.filter(row => classify(row) === 'stored record').length} stored-record snapshots, ${readPath.length} read-path comparisons`)

// The four added fields must be visible where they are asserted on, and must not
// have been silently absorbed by a whole-receipt equality that predates them.
const allText = suites().map(file => readFileSync(file, 'utf8')).join('\n')
for (const field of NEW_FIELDS) {
  const occurrences = allText.split(field).length - 1
  check(`the field \`${field}\` is asserted or noted somewhere in the suites`, occurrences > 0, 'never mentioned')
  const absorbed = wholeReceipts.filter(row => row.literal.includes(field))
  if (absorbed.length > 0) console.log(`       \`${field}\` appears inside a whole-receipt literal at ${absorbed.map(row => row.where).join(', ')} (still equal only while the receipt keeps it)`)
}

const filesToRun = [...new Set(wholeReceipts.map(row => row.where.split(':')[0]))]
console.log(`\n[B3] suites owning a whole-receipt comparison (run these): ${filesToRun.join(', ') || '(none)'}`)
check('no `node:assert` deep equality hides a whole-receipt comparison', !/from ['"]node:assert|require\(['"]node:assert|assert\.deepStrictEqual\(|assert\.deepEqual\(|assert\.strictEqual\(/.test(allText), 'found assert-style deep equality')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
