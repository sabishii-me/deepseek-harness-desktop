import type { HostContext } from '../types'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { readFile, access } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { openJouzuModelAccess } from './jouzu-model-access'

describe('optional Jouzu DSH model transport', () => {
  it('loads only reusable subpaths and keeps provider credentials out of the child', async () => {
    let selection!: () => LlmCallConfig
    const dispose = vi.fn(async () => {})
    const imports: string[] = []
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'shisa' }],
        listModels: async () => [{ id: 'model-a', name: 'Model A' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 65536 }, defaultMaxTokens: 4096 }),
      },
      loader: {
        unwrapExports: (value: unknown) => value,
        import: async (id: string) => {
          imports.push(id)
          if (id.endsWith('/pi-extension'))
            return { bridgeExtension: 'export default function() {}' }
          return { openModelBridge: async (_ctx: unknown, selected: () => LlmCallConfig) => {
            selection = selected
            return { url: 'http://127.0.0.1:1234/v1', token: 'session-capability', dispose }
          } }
        },
      },
    } as unknown as HostContext
    const result = await openJouzuModelAccess(ctx, { file: 'node', args: ['jouzu.js'], env: { PATH: '/bin' } })
    expect(result).toBeDefined()
    const path = result!.command.args.at(-1)!
    try {
      expect(await readFile(path, 'utf8')).toContain('export default')
      expect(imports).toEqual([
        '@sabishii-me/dsh-jouzu-bridge/model-bridge',
        '@sabishii-me/dsh-jouzu-bridge/pi-extension',
      ])
      expect(result!.command.env!.DSH_BRIDGE_TOKEN).toBe('session-capability')
      expect((await result!.catalog(new AbortController().signal)).models[0]!.id).toBe('dsh/shisa/model-a')
      await result!.select({ model: 'dsh/shisa/model-a', reasoningEffort: null }, new AbortController().signal)
      expect(selection()).toEqual({ provider: 'shisa', model: 'model-a' })
      expect(await result!.select({ model: 'native/model-a', reasoningEffort: null }, new AbortController().signal)).toBe(false)
    }
    finally {
      await result!.dispose()
    }
    expect(dispose).toHaveBeenCalledOnce()
    await expect(access(path)).rejects.toThrow()
  })

  it('does not load transport code when Shisa is not registered', async () => {
    const load = vi.fn()
    const ctx = { llm: { listProviders: () => [] }, loader: { import: load } } as unknown as HostContext
    expect(await openJouzuModelAccess(ctx, { file: 'node', args: [] })).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })
})
