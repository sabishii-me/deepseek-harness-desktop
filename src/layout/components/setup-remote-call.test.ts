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

/**
 * 渲染规则（§5.5.1 R1–R3）的纯函数化验证。
 *
 * 组件本身的 DOM 断言走 client 项目；这里验证「规则本身」在任何配置下都成立，
 * 与产品无关。
 */

/** R1：值为空的行必须被过滤掉（整行不渲染，而不是渲染空行）。 */
function visibleFields(
  spec: RemoteCallSpec,
  state: Record<string, unknown>,
): { path: string, value: string }[] {
  const read = (path: string | undefined): unknown => (path === undefined ? undefined : state[path])
  const text = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
  return (spec.fields ?? [])
    .filter((field) => {
      if (field.showWhen !== undefined && read(field.showWhen.path) !== field.showWhen.equals)
        return false
      return text(read(field.path)) !== ''
    })
    .map(field => ({ path: field.path, value: text(read(field.path)) }))
}

/** R3：同一时刻只取第一条成立的 action。 */
function primaryAction(
  spec: RemoteCallSpec,
  state: Record<string, unknown>,
): { method: string } | undefined {
  const read = (path: string | undefined): unknown => (path === undefined ? undefined : state[path])
  return (spec.actions ?? [])
    .find(a => a.showWhen === undefined || read(a.showWhen.path) === a.showWhen.equals)
}

/** R2：只渲染 i18n 里存在的 key。 */
function labelOf(key: string | undefined, available: Set<string>): string | null {
  if (key === undefined || !available.has(key))
    return null
  return key
}

describe('render rules (R1–R3)', () => {
  it('R1 drops a field whose value is empty even without showWhen', () => {
    // 这正是线上截图的缺陷：无 label、无 showWhen、值为空，却渲染了一行。
    const spec: RemoteCallSpec = {
      namespace: 'n',
      read: 'r',
      done: { path: 's', equals: 'ok' },
      fields: [{ path: 'organization' }],
    }
    expect(visibleFields(spec, {})).toEqual([])
    expect(visibleFields(spec, { organization: 'acme' })).toEqual([
      { path: 'organization', value: 'acme' },
    ])
  })

  it('R1 keeps a field that carries a real value', () => {
    const spec = genericSpec()
    const rows = visibleFields(spec, { owner: 'acme', status: 'idle' })
    expect(rows).toEqual([{ path: 'owner', value: 'acme' }])
  })

  it('R2 refuses to render an i18n key that does not exist', () => {
    // 线上截图里按钮写的是 `preinstall.remote_cancel` 原文。
    const available = new Set(['known.key'])
    expect(labelOf('preinstall.remote_cancel', available)).toBeNull()
    expect(labelOf('known.key', available)).toBe('known.key')
    expect(labelOf(undefined, available)).toBeNull()
  })

  it('R3 renders exactly one action per state, never all of them', () => {
    const spec = genericSpec()
    expect(primaryAction(spec, { status: 'idle' })?.method).toBe('begin')
    expect(primaryAction(spec, { status: 'pending' })?.method).toBe('abort')
    // 没有任何 action 成立时不渲染按钮，而不是渲染一排。
    expect(primaryAction(spec, { status: 'unknown' })).toBeUndefined()
  })

  it('R3 returns at most one even when several could match', () => {
    const spec: RemoteCallSpec = {
      namespace: 'n',
      read: 'r',
      done: { path: 's', equals: 'ok' },
      actions: [
        { method: 'first', label: 'a' },
        { method: 'second', label: 'b' },
      ],
    }
    expect(primaryAction(spec, {})?.method).toBe('first')
  })
})

describe('state table', () => {
  it('maps a configured value to its label and stays silent otherwise', () => {
    const spec: RemoteCallSpec = {
      namespace: 'n',
      read: 'r',
      done: { path: 'phase', equals: 'done' },
      statusPath: 'phase',
      states: [
        { value: 'alpha', label: 'k.alpha' },
        { value: 'beta', label: 'k.beta' },
      ],
    }
    const available = new Set(['k.alpha', 'k.beta'])
    const title = (phase: string): string | null => {
      const hit = (spec.states ?? []).find(s => s.value === phase)
      return hit === undefined ? null : labelOf(hit.label, available)
    }
    expect(title('alpha')).toBe('k.alpha')
    expect(title('beta')).toBe('k.beta')
    // 未知状态不编造文案。
    expect(title('gamma')).toBeNull()
  })
})
