import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('ships the Shisa model provider as a built-in from its single public source', () => {
 const path = resolve(import.meta.dirname, '../src-tauri/resources/manifest.jsonc')
 const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
 expect(parsed.error).toBeUndefined()
 const plugins = parsed.config.plugins
 // Built-in so its client code is always present and can contribute the onboarding
 // sign-in step; the single source stays the public repository.
 const shisa = plugins['built-in'].find((p: { id: string }) => p.id === 'shisa-ai')
 expect(shisa).toMatchObject({ id: 'shisa-ai', package: '@sabishii-me/dsh-model-provider-shisa' })
 expect(shisa.repo).toBe('https://github.com/sabishii-me/dsh-model-provider-shisa')
 // Never also offered as a remote preset: one entry, one delivery path.
 expect(plugins.preset.some((p: { id: string }) => p.id === 'shisa-ai')).toBe(false)
})
