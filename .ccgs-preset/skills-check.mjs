import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const YAML = await import('file:///C:/code/deepseek-harness/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js')
const root = 'D:/AI/test/ccgs-essence/03-技能'
const out = []
const names = new Map()
let ok = 0
const bad = []
for (const d of readdirSync(root)) {
  const dir = join(root, d)
  if (!statSync(dir).isDirectory()) continue
  const f = join(dir, 'SKILL.md')
  let raw
  try { raw = readFileSync(f, 'utf8') } catch { bad.push([d, 'no SKILL.md']); continue }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!m) { bad.push([d, 'no frontmatter block']); continue }
  let data
  try { data = YAML.parse(m[1]) } catch (e) { bad.push([d, 'YAML error: ' + e.message.split('\n')[0]]); continue }
  const problems = []
  if (typeof data.name !== 'string' || !data.name) problems.push('name missing/not string')
  if (typeof data.description !== 'string' || !data.description) problems.push('description missing/not string')
  if (data['user-invocable'] !== undefined && typeof data['user-invocable'] !== 'boolean') problems.push('user-invocable not boolean: ' + JSON.stringify(data['user-invocable']))
  if (data['disable-model-invocation'] !== undefined && typeof data['disable-model-invocation'] !== 'boolean') problems.push('disable-model-invocation not boolean: ' + JSON.stringify(data['disable-model-invocation']))
  for (const k of Object.keys(data)) if (!['name','description','user-invocable','disable-model-invocation'].includes(k)) problems.push('unexpected key: ' + k)
  if (data.name) { if (!names.has(data.name)) names.set(data.name, []); names.get(data.name).push(d) }
  if (problems.length) bad.push([d, problems.join('; ')]) ; else ok++
}
out.push('技能目录解析成功: ' + ok + ' / 失败: ' + bad.length)
for (const [d, why] of bad) out.push('  FAIL ' + d + ' -> ' + why)
out.push('')
out.push('frontmatter name 去重（括号内为所在目录数）: ' + names.size)
for (const [n, ds] of names) if (ds.length > 1) out.push('  重名 name=' + n + ' <- ' + ds.join(', '))
out.push('')
const desc = []
for (const d of readdirSync(root)) { if (!statSync(join(root, d)).isDirectory()) continue
  const raw = readFileSync(join(root, d, 'SKILL.md'), 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw); if (!m) continue
  const data = YAML.parse(m[1])
  desc.push([d, data.description.length, data['user-invocable'], data['disable-model-invocation'] === true])
}
desc.sort((a,b) => a[1] - b[1])
out.push('description 最短 5 条（目录 / 字符数 / user-invocable / 不可模型调用）:')
for (const x of desc.slice(0,5)) out.push('  ' + x.join('  '))
out.push('user-invocable=false 的: ' + desc.filter(x => x[2] === false).map(x => x[0]).join(', '))
out.push('disable-model-invocation=true 的: ' + desc.filter(x => x[3]).map(x => x[0]).join(', '))
out.push('description 总字符: ' + desc.reduce((s,x) => s + x[1], 0))
writeFileSync('C:/code/deepseek-harness/.ccgs-preset/skills-check.txt', out.join('\n'), 'utf8')
