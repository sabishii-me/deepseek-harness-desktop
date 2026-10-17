import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

/** Resolve service modules through the public Host loader, not a second runtime. */
export async function buildHostPlugin(source: string, output: string): Promise<string[]> {
  const result = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, external: ['@deepseek-ai/*'] })
  const externals = [...new Set(Object.values(result.metafile!.outputs).flatMap(o => o.imports.filter(i => i.external).map(i => i.path)))]
  let code = result.outputFiles[0]!.text
  code = code.replace(/^import (.+?) from "([^"]+)";$/gm, (_, bindings: string, id: string) => {
    const value = `runtime[${JSON.stringify(id)}]`
    if (bindings.startsWith('* as ')) return `const ${bindings.slice(5)} = ${value};`
    if (bindings.startsWith('{')) return `const ${bindings.replace(/\bas\b/g, ':')} = ${value};`
    const comma = bindings.indexOf(',')
    if (comma < 0) return `const ${bindings} = ${value}.default;`
    return `const ${bindings.slice(0, comma)} = ${value}.default; const ${bindings.slice(comma + 1).replace(/\bas\b/g, ':')} = ${value};`
  })
  code = code.replace(/export \{([\s\S]*?)\};?\s*$/, (_, entries: string) => 'return {' + entries.split(',').filter(e => e.trim()).map(e => { const [name, alias] = e.trim().split(/\s+as\s+/); return `${alias ?? name}: ${name}` }).join(',') + '};')
  if (/^import |^export /m.test(code)) throw new Error('Unsupported Host plugin import/export shape')
  writeFileSync(output, `export function createImplementation(runtime) {\n${code}\n}\n`)
  return externals
}
