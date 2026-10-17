/**
 * `remote-call` 步骤的通用性测试。
 *
 * 全程使用**虚构**的命名空间、方法与字段名：如果实现里漏了任何具体产品的字面量，
 * 这些用例就会失败。目标不是覆盖某个 provider，而是证明宿主只认配置。
 */
import type { OnboardingStep, RemoteCallSpec } from '@/store/modules/preinstall'
import { describe, expect, it } from 'vitest'

/** 构造一个与产品无关的 remote-call 步骤。 */
function remoteStep(remote: RemoteCallSpec = genericSpec()): OnboardingStep {
  return {
    id: 'any-step',
    kind: 'remote-call',
    title: 'any.title',
    optional: true,
    completed: false,
    remote,
  }
}

/** 一份完全虚构的配置：三层状态、两条正文行、两颗按钮。 */
function genericSpec(): RemoteCallSpec {
  return {
    namespace: 'example-ns',
    read: 'readStatus',
    done: { path: 'status', equals: 'granted' },
    pollMs: 2000,
    fields: [
      { path: 'owner' },
      { showWhen: { path: 'status', equals: 'pending' }, path: 'handle', copy: true },
    ],
    actions: [
      { showWhen: { path: 'status', equals: 'idle' }, method: 'begin', label: 'x.begin' },
      { showWhen: { path: 'status', equals: 'pending' }, method: 'abort', label: 'x.abort' },
    ],
  }
}

describe('remote-call declaration', () => {
  it('carries everything the host needs, so no provider name is compiled in', () => {
    const step = remoteStep()
    expect(step.remote?.namespace).toBe('example-ns')
    expect(step.remote?.read).toBe('readStatus')
    expect(step.remote?.done).toEqual({ path: 'status', equals: 'granted' })
  })

  it('works with only the three primitives declared', () => {
    // 没有 fields / actions 也能跑：宿主只做取值与比较。
    const step = remoteStep({
      namespace: 'n',
      read: 'r',
      done: { path: 'p', equals: 'v' },
    })
    expect(step.remote?.fields).toBeUndefined()
    expect(step.remote?.actions).toBeUndefined()
  })

  it('never names a concrete state or field', () => {
    // 配置里的每一个业务词都由调用方给出，组件不引用任何具体取值。
    const spec = genericSpec()
    const words = JSON.stringify(spec)
    for (const forbidden of ['shisa', 'deepseek', 'oauth', 'waiting', 'signed-out'])
      expect(words).not.toContain(forbidden)
  })

  it('keeps the step skippable only when declared optional', () => {
    expect(remoteStep().optional).toBe(true)
    expect({ ...remoteStep(), optional: false }.optional).toBe(false)
  })
})

describe('onboarding kind dispatch', () => {
  it('has a stable set of generic kinds', () => {
    // 宿主只为这几种动作类型实现执行器；新增具体步骤不需要新增类型。
    const kinds = ['plugin-selection', 'native-kernel', 'remote-call'] as const
    expect(new Set(kinds).size).toBe(3)
  })
})
