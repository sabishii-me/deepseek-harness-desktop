import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { NativeCommand } from '../backends/types'
import type { HostContext } from '../types'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface JouzuModelAccess {
  command: NativeCommand
  catalog(signal: AbortSignal): Promise<NativeModelCatalog>
  select(options: NativeTurnOptions, signal: AbortSignal): Promise<boolean>
  dispose(): Promise<void>
}

/** Optional DSH Shisa access. Imports only the existing transport subpath,
 * never the legacy backend plugin or its agent factory. */
export async function openJouzuModelAccess(ctx: HostContext, command: NativeCommand): Promise<JouzuModelAccess | undefined> {
  if (!ctx.llm.listProviders().some(provider => provider.id === 'shisa'))
    return undefined
  const transport = ctx.loader.unwrapExports(await ctx.loader.import('@sabishii-me/dsh-jouzu-bridge/model-bridge')) as {
    openModelBridge: (ctx: HostContext, selection: () => LlmCallConfig, limits: { maxBytes: number, timeoutMs: number }) => Promise<{ url: string, token: string, dispose(): Promise<void> }>
  }
  const extension = ctx.loader.unwrapExports(await ctx.loader.import('@sabishii-me/dsh-jouzu-bridge/pi-extension')) as { bridgeExtension: string }
  let selection: LlmCallConfig | undefined
  const bridge = await transport.openModelBridge(ctx, () => {
    if (!selection)
      throw new Error('No DSH model selected for this Jouzu session')
    return selection
  }, { maxBytes: 8 * 1024 * 1024, timeoutMs: 300_000 })
  let directory: string | undefined
  try {
    const entries = await ctx.llm.listModels('shisa')
    if (!entries.length)
      throw new Error('Shisa model catalog is empty')
    const first = await ctx.llm.resolveModelInfo('shisa', entries[0]!.id)
    if (!first.context?.contextWindow || !first.defaultMaxTokens)
      throw new Error('Shisa model is missing context/output limits')
    directory = await mkdtemp(join(tmpdir(), 'dsh-jouzu-model-'))
    const path = join(directory, 'provider.mjs')
    await writeFile(path, extension.bridgeExtension, { mode: 0o600 })
    return {
      command: { ...command, args: [...command.args, '--extension', path], env: {
        ...command.env,
        DSH_BRIDGE_URL: bridge.url,
        DSH_BRIDGE_TOKEN: bridge.token,
        DSH_BRIDGE_MODEL: JSON.stringify({ contextWindow: first.context.contextWindow, maxTokens: first.defaultMaxTokens }),
      } },
      async catalog(signal) {
        const models = await ctx.llm.listModels('shisa')
        signal.throwIfAborted()
        return { models: await Promise.all(models.map(async (model) => {
          const info = await ctx.llm.resolveModelInfo('shisa', model.id, signal)
          return { id: `dsh/shisa/${model.id}`, name: `Shisa: ${model.name}`, description: model.description,
            ...(info.reasoning ? { reasoning: { efforts: [...info.reasoning.efforts], defaultEffort: info.reasoning.defaultEffort } } : {}) }
        })) }
      },
      async select(options, signal) {
        if (!options.model?.startsWith('dsh/shisa/'))
          return false
        const model = options.model.slice('dsh/shisa/'.length)
        await ctx.llm.resolveModelInfo('shisa', model, signal)
        selection = { provider: 'shisa', model, ...(options.reasoningEffort === null ? {} : { reasoningEffort: options.reasoningEffort }) } as LlmCallConfig
        return true
      },
      async dispose() {
        await bridge.dispose()
        await rm(directory!, { recursive: true, force: true })
      },
    }
  }
  catch (error) {
    await bridge.dispose()
    if (directory)
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}
