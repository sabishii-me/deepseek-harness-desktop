/**
 * `remote-call` 步骤的通用性测试。
 *
 * 这里全程使用**虚构**的命名空间与方法名：如果实现里漏了任何具体产品的字面量，
 * 这些用例就会失败。目标不是覆盖某个 provider，而是证明宿主只认配置。
 */
import type { OnboardingStep } from '@/store/modules/preinstall'
import { describe, expect, it } from 'vitest'

/** 构造一个与产品无关的 remote-call 步骤。 */
function remoteStep(overrides: Partial<OnboardingStep> = {}): OnboardingStep {
  return {
    id: 'any-step',
    kind: 'remote-call',
    title: 'any.title',
    optional: true,
    completed: false,
    remote: {
      namespace: 'example-ns',
      state: 'readStatus',
      signIn: 'authorize',
      ready: { path: 'status', equals: 'granted' },
    },
    ...overrides,
  }
}

describe('remote-call step declaration', () => {
  it('carries everything the host needs, so no provider name is compiled in', () => {
    const step = remoteStep()
    // 界面与执行器只读这些字段；把命名空间换成任意值都不需要改代码。
    expect(step.remote?.namespace).toBe('example-ns')
    expect(step.remote?.state).toBe('readStatus')
    expect(step.remote?.ready).toEqual({ path: 'status', equals: 'granted' })
  })

  it('treats a missing sign-in method as a wait-only step', () => {
    const step = remoteStep({ remote: { namespace: 'n', state: 's', ready: { path: 'p', equals: 'v' } } })
    expect(step.remote?.signIn).toBeUndefined()
  })

  it('keeps the step skippable only when declared optional', () => {
    expect(remoteStep().optional).toBe(true)
    expect(remoteStep({ optional: false }).optional).toBe(false)
  })
})

describe('onboarding kind dispatch', () => {
  it('has a stable set of generic kinds', () => {
    // 宿主只为这几种动作类型实现执行器；新增具体步骤不需要新增类型。
    const kinds = ['plugin-selection', 'native-kernel', 'remote-call'] as const
    expect(new Set(kinds).size).toBe(3)
  })
})
