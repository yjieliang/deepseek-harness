/**
 * Machine-level init: the shipped template tree materializes missing
 * `$DSH_HOME` files exactly once. Every scenario runs against temp roots —
 * the defaults resolve the real harness home and must never be exercised here.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyInitTemplates } from '../src/init-config.ts'

const tempRoots: string[] = []

/** One isolated temp root, removed with the others after each test. */
function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-init-${label}-`))
  tempRoots.push(dir)
  return dir
}

/** Lay out a template tree: relative path -> content. */
function templateTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('applyInitTemplates', () => {
  it('copies every missing template file to the same relative path under the home', () => {
    const home = temp('home')
    const templates = temp('templates')
    templateTree(templates, {
      'settings.yaml': 'agent-default-model:\n  model: deepseek-v4-pro\n',
      'profiles/web/extra.yml': '[]\n',
    })
    const log = vi.fn()

    const written = applyInitTemplates(home, templates, log)

    expect(written).toEqual([join(home, 'profiles/web/extra.yml'), join(home, 'settings.yaml')])
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('deepseek-v4-pro')
    expect(readFileSync(join(home, 'profiles/web/extra.yml'), 'utf8')).toBe('[]\n')
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('never overwrites an existing target', () => {
    const home = temp('home')
    const templates = temp('templates')
    templateTree(templates, { 'settings.yaml': 'template content\n' })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.yaml'), 'user content\n')

    const written = applyInitTemplates(home, templates)

    expect(written).toEqual([])
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe('user content\n')
  })

  it('is idempotent: a second run writes nothing', () => {
    const home = temp('home')
    const templates = temp('templates')
    templateTree(templates, { 'settings.yaml': 'template content\n' })

    expect(applyInitTemplates(home, templates)).toHaveLength(1)
    expect(applyInitTemplates(home, templates)).toEqual([])
  })

  it('skips README.md documentation files', () => {
    const home = temp('home')
    const templates = temp('templates')
    templateTree(templates, {
      'README.md': 'documentation\n',
      'settings.yaml': 'template content\n',
    })

    const written = applyInitTemplates(home, templates)

    expect(written).toEqual([join(home, 'settings.yaml')])
    expect(() => readFileSync(join(home, 'README.md'))).toThrow()
  })

  it('warns and writes nothing when the template root is missing', () => {
    const home = temp('home')
    const log = vi.fn()

    expect(applyInitTemplates(home, join(home, 'no-such-tree'), log)).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('missing'))
  })
})
