import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('ships executable profile bundles for both Shisa plugins, not only client declarations', () => {
  const root = resolve(import.meta.dirname, '../src-tauri/resources/node_modules')
  for (const id of ['shisa-provider', 'shisa-ui']) {
    const dir = resolve(root, id)
    const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(dir, manifest.dsh.bundle.patch))).toBe(true)
    expect(readFileSync(resolve(dir, manifest.dsh.bundle.patch), 'utf8')).toContain(manifest.name)
  }
})
