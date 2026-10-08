/**
 * S1 dependency resolution, plain-Node arm.
 *
 * Run from any file under the plugin directory; Node resolves each bare
 * specifier by walking `<plugin>/node_modules` and its ancestors. This is the
 * same lookup the offline tests (`node tests/*.mjs`) and a real `dsh` process
 * start from, but it does not involve the Harness profile interception.
 *
 * Usage (from the plugin directory):
 *   node probes/s1-pure-node.mjs
 */

const SPECIFIERS = [
  'zod',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-sqlite',
]

/** Render one thrown error as `<code>: <first message line>`. */
function describe(error) {
  const code = error?.code ?? error?.name ?? 'Error'
  const message = String(error?.message ?? error).split('\n')[0]
  return `${code}: ${message}`
}

console.log(`node            ${process.version}`)
console.log(`cwd             ${process.cwd()}`)
console.log(`importer        ${import.meta.url}`)
for (const specifier of SPECIFIERS) {
  let resolved
  try {
    resolved = import.meta.resolve(specifier)
  } catch (error) {
    resolved = describe(error)
  }
  let imported
  try {
    const module = await import(specifier)
    imported = `ok keys=[${Object.keys(module).slice(0, 6).join(',')}]`
  } catch (error) {
    imported = describe(error)
  }
  console.log(`resolve         ${specifier} -> ${resolved}`)
  console.log(`import          ${specifier} -> ${imported}`)
}
