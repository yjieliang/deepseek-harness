/**
 * Machine-level initialization: generate missing `$DSH_HOME` files from the
 * shipped template tree (`apps/cli/config/init/`, the app's own config
 * surface, beside the shipped agent presets). Every template file maps to the
 * same relative path under the harness home; a file is written only when its
 * target does not exist, so existing configuration — and anything a user
 * edits there — is never overwritten. The step is idempotent and runs before
 * the plugin tree mounts, so a generated `settings.yaml` baseline is what the
 * settings provider reads on the first boot.
 *
 * `README.md` files inside the template tree document the templates and are
 * never copied. A missing template root is a degraded deployment, not a fatal
 * one: initialization is additive, so it warns and leaves the home alone.
 *
 * @module dsh-init-config
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The shipped template tree, resolved from the same app config surface as the preset roster. */
const INIT_TEMPLATE_ROOT = fileURLToPath(new URL('../config/init/', import.meta.url))

/**
 * Copy every missing template file into the harness home.
 * @param home - the harness home to initialize; defaults to {@link resolveDshHome}.
 * @param templateRoot - the template tree; defaults to the shipped `config/init/`.
 * @param log - sink for one line per written file.
 * @returns the absolute paths written, in walk order.
 */
export function applyInitTemplates(
  home?: string,
  templateRoot?: string,
  log: (message: string) => void = () => {},
): string[] {
  const targetHome = home ?? resolveDshHome()
  const root = templateRoot ?? INIT_TEMPLATE_ROOT
  if (!existsSync(root)) {
    log(`dsh: init: template root ${root} is missing; skipping machine-level initialization`)
    return []
  }
  const written: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const source = join(dir, name)
      const stat = statSync(source)
      if (stat.isDirectory()) {
        walk(source)
        continue
      }
      // The template tree is the app's own shipped config, so its relative
      // paths are trusted input; README files document the templates.
      if (name === 'README.md') continue
      const target = join(targetHome, relative(root, source))
      if (existsSync(target)) continue
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      written.push(target)
      log(`dsh: init: wrote ${target}`)
    }
  }
  walk(root)
  return written
}
