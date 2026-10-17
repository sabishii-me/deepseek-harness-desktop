import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(rs|tsx?|json)$/.test(entry.name) ? [path] : []
  })
}

// Architectural regression check only: this does not prove installation or login works.
it('keeps provider login and optional kernel installation out of shell-specific commands', () => {
  for (const path of ['src-tauri/src/bridge/jouzu.rs', 'src-tauri/src/bridge/shisa.rs', 'src/layout/components/setup-jouzu.tsx', 'src/layout/components/setup-shisa.tsx'])
    expect(existsSync(join(root, path)), path).toBe(false)
  const forbidden = /get_jouzu_installation|install_optional_jouzu|DSH_MANAGED_JOUZU_PATH|get_shisa_state|open_shisa_settings|dsh:\/\/open-model-settings/
  for (const path of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'src-tauri/src'))])
    expect(readFileSync(path, 'utf8'), path).not.toMatch(forbidden)
})
