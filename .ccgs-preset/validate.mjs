import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
const YAML = await import('file:///C:/code/deepseek-harness/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js')
const p = 'C:/code/deepseek-harness/.ccgs-preset/dsh-ccgs-studio/presets/ccgs-studio.patch.yml'
const out = []
try {
  const doc = YAML.parse(readFileSync(p, 'utf8'))
  out.push('PARSE OK')
  out.push('patches: ' + doc.length)
  const row = doc[0].insert[0]
  out.push('row id: ' + row.id + ' | declaration id: ' + row.config.id + ' | order: ' + row.config.order)
  out.push('name: ' + row.config.name)
  out.push('plugin rows: ' + row.config.plugins.length)
  for (const r of row.config.plugins) out.push('  - ' + r.id + '  ' + r.name + (r.group ? '  [group: ' + r.config.length + ']' : '') + (r.disabled !== undefined ? '  disabled=' + String(r.disabled) : ''))
  const pkg = JSON.parse(readFileSync('C:/code/deepseek-harness/.ccgs-preset/dsh-ccgs-studio/package.json', 'utf8'))
  out.push('package: ' + pkg.name + ' | patch field: ' + JSON.stringify(pkg.dsh.bundle.patch))
  const sk = row.config.plugins.find(r => r.id === 'skill-filesystem')
  const sd = sk.config.customSkillDirs[0]
  out.push('skill dir: ' + sd + ' | exists: ' + existsSync(sd) + ' | entries: ' + (existsSync(sd) ? readdirSync(sd).length : 0))
  const per = row.config.plugins.find(r => r.id === 'persona')
  out.push('persona prefix chars: ' + per.config.prefix.length + ' | suffix has {{cwd}}: ' + per.config.suffix.includes('{{cwd}}'))
  out.push('description: ' + row.config.description)
} catch (e) { out.push('FAIL: ' + (e && e.message)) }
writeFileSync('C:/code/deepseek-harness/.ccgs-preset/validate.txt', out.join('\n'), 'utf8')
