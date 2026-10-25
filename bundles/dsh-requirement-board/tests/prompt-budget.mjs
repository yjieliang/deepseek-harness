/**
 * Prompt / tool-schema budget gate.
 *
 * The board contributes a paragraph to every model step (`promptContext`) and
 * three tool definitions to the session's tool catalog. Both travel on every
 * step, so their size is a recurring cost the rest of the repository cannot see:
 * this bundle is outside the controlled source tree, so the repo's own
 * prompt-budget snapshot cannot pin it. This suite is that pin.
 *
 * It seeds a board that is realistically busy (more requirements than the
 * prompt budget names, plus decisions), reads the exact text the prompt
 * registration computes, and measures the registered tool definitions. The
 * ceilings carry a ~20% margin over the recorded baseline: they are meant to
 * catch growth, not to force the text to shrink.
 *
 * Run with `node tests/prompt-budget.mjs`.
 */

import { resolveConfig } from '../host/config.js'
import { apply as applyBoardPlugin } from '../index.js'
import {
  createMountContext,
  createReporter,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/**
 * Ceilings, in the units the prompt and the tool catalog actually pay.
 *
 * Baselines were read on 2026-10-18 with the fixture below (60 open
 * requirements, 3 decisions, one role line); each ceiling is the baseline plus
 * about 20% headroom. A change that trips one should be judged, not blindly
 * re-baselined.
 */
const LIMITS = {
  /** Characters of the injected runtime-context paragraph. */
  promptChars: 2400,
  /** Characters of one requirement line (the line format is fixed). */
  lineChars: 200,
  /** Bytes of all three tool definitions' `name + description + parameters`. */
  toolsBytes: 24000,
  /** Bytes of one tool definition. */
  toolBytes: 18500,
  /** Requirements named by the prompt: the config's `promptMaxItems`. */
  namedRequirements: 12,
}

const dir = await makeTempDir()
const config = resolveConfig({ promptMaxItems: 12, imageDir: `${dir}/images` })
let board
try {
  board = await openBoard({ backend: 'json', dir, config })
  const service = board.service
  const a = { session: 'ses_A', name: 'A' }
  const b = { session: 'ses_B', name: 'B' }

  // An empty board still carries the role paragraph; it must not carry a
  // requirement section that names nothing.
  const emptyPrompt = service.promptContext('ses_A', 12)
  check('an empty board and an unroled session inject nothing', emptyPrompt === '', emptyPrompt.slice(0, 80))

  // A realistically busy board: more rows than the prompt budget names, spread
  // across sessions/roles, plus decisions that reserve their own section.
  for (let index = 0; index < 60; index += 1) {
    await service.createRequirement({
      summary: `第 ${index} 条需求的简述，用来量注入段的体积。`,
      title: `量注入段体积的需求 ${index}（带一个足够长的标题）`,
      priority: index % 5 === 0 ? 'high' : 'normal',
      owner: index % 3 === 0 ? '张三' : '',
      role: index % 4 === 0 ? 'art' : '',
    }, index % 2 === 0 ? a : b)
  }
  for (let index = 0; index < 3; index += 1) {
    await service.createRequirement({
      summary: `第 ${index} 个待拍板的问题。`,
      title: `要不要这样做 ${index}？`,
      kind: 'decision',
    }, a)
  }

  const prompt = service.promptContext('ses_A', 12)
  // A budget overrun is reported as a separate `- … N more …` marker line, not as
  // an extra requirement, so only real entries count towards the named budget.
  const named = prompt.split('\n').filter(line => line.startsWith('- ') && !line.startsWith('- …'))
  const markers = prompt.split('\n').filter(line => line.startsWith('- …'))
  const longest = named.reduce((size, line) => Math.max(size, line.length), 0)
  console.log(`\nbaseline: prompt ${prompt.length} chars, ${named.length} requirement lines, ${markers.length} overrun markers, longest line ${longest} chars`)
  check('the prompt is one bounded paragraph',
    prompt.startsWith('<requirement-board>') && prompt.endsWith('</requirement-board>'), prompt.slice(0, 60))
  check('the prompt names no more requirements than its budget',
    named.length <= LIMITS.namedRequirements, String(named.length))
  check('the prompt stays inside its character ceiling',
    prompt.length <= LIMITS.promptChars, `${prompt.length} > ${LIMITS.promptChars}`)
  check('one requirement line stays inside its ceiling',
    longest <= LIMITS.lineChars, `${longest} > ${LIMITS.lineChars}`)
  check('the section still names the board total',
    /Shared requirement board: \d+ active requirement\(s\)/.test(prompt))

  // The prompt registration is the wiring under test: the text the step sees is
  // computed by the service method measured above, so registering it at all is
  // what the panel-side gates cannot see.
  const mounted = createMountContext({ storageDomain: { open: async () => board.domain } })
  await applyBoardPlugin(mounted.ctx, config)
  check('the plugin registers exactly one prompt-context section',
    mounted.records.promptContexts.length === 1, String(mounted.records.promptContexts.length))
  check('the plugin registers exactly three tools',
    mounted.records.tools.length === 3, String(mounted.records.tools.length))

  const sizes = mounted.records.tools.map(definition => ({
    name: definition.name,
    bytes: Buffer.byteLength(JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }), 'utf8'),
  }))
  const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0)
  console.log(`baseline: tools ${total} bytes (${sizes.map(entry => `${entry.name} ${entry.bytes}`).join(', ')})`)
  check('every tool definition stays inside its ceiling',
    sizes.every(entry => entry.bytes <= LIMITS.toolBytes),
    sizes.filter(entry => entry.bytes > LIMITS.toolBytes).map(entry => `${entry.name} ${entry.bytes}`).join(','))
  check('the three tool definitions stay inside the catalog ceiling',
    total <= LIMITS.toolsBytes, `${total} > ${LIMITS.toolsBytes}`)
} finally {
  if (board !== undefined) await board.close()
  await removeTempDir(dir)
}

process.exit(reporter.finish() ? 0 : 1)
