import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Materialize the pinned core runtime closure beside bundled plugins so all
 * imports share one module identity. Never copy an entire development profile. */
export function bundleRuntime(coreSource: string, resources: string): void {
  const visited = new Set<string>()
  function copy(source: string): void {
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (visited.has(manifest.name)) return
    visited.add(manifest.name)
    const target = join(resources, 'node_modules', manifest.name)
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target)) cpSync(source, target, { recursive: true, dereference: true })
    const require = createRequire(join(source, 'package.json'))
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
      let resolved: string
      try {
        const directory = require.resolve.paths(name)?.map(base => join(base, name, 'package.json')).find(existsSync)
        if (!directory) throw new Error(`Missing runtime dependency ${name}`)
        resolved = directory
      }
      catch {
        try {
          let dir = dirname(require.resolve(name))
          while (!existsSync(join(dir, 'package.json'))) {
            const parent = dirname(dir)
            if (parent === dir) throw new Error(`Cannot locate ${name}`)
            dir = parent
          }
          resolved = join(dir, 'package.json')
        } catch (error) {
          if (name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional) continue
          throw error
        }
      }
      copy(dirname(resolved))
    }
  }
  copy(resolve(coreSource))
}
