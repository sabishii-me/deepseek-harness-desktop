import type { IconComponent } from './loadable'
import type { PluginProcess } from '@/store/modules/plugins'
import type { OnboardingRemoteState, OnboardingStep, PreinstallKernel, PreinstallPlugin } from '@/store/modules/preinstall'
import { ArrowUpRightFromSquare, ArrowUturnCcwLeft, Comments, Copy, Cubes3Overlap, LayoutSideContentLeft, PlugConnection, ShoppingCart, Xmark } from '@gravity-ui/icons'
import { Button, Card, Checkbox, Chip, ScrollShadow, Spinner, Switch, Typography } from '@heroui/react'
import { useIntervalFn, useMount, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Else, If, Then } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { Ellipsis } from '@/components/ellipsis'
import { Empty } from '@/components/empty'
import { Logs } from '@/components/logs'
import { useListen } from '@/hooks/use-listen'
import { useDshPluginsManager } from '@/hooks/use-plugins-manager'
import { store } from '@/store'
import { writeClipboardText } from '@/utils/clipboard'

/**
 * 预装插件引导页：首次安装（或老版本升级）后展示推荐插件列表，
 * 用户确认后交由插件管理器执行安装/卸载（日志实时回流到控制台），
 * 或跳过；两者都会标记完成并继续启动服务。
 */

/**
 * 初始勾选态 = 已安装 + 推荐/修复/默认勾选（进入页面时的完整勾选集合）。
 * 用于和用户最终选择做 diff，得出 toInstall / toUninstall。
 *
 * 策略由 isFirstTime 决定：
 * - 首次安装引导（isFirstTime=true）：已安装 + 推荐/修复/默认勾选均默认勾上，
 *   但显式声明 `defaultUnchecked` 的推荐项不预选（标着「推荐」仍交由用户决定）
 * - 手动打开（isFirstTime=false）：只有已安装的插件才默认勾上（已卸载的推荐项不勾）
 */
function initialCheckedSet(plugins: readonly PreinstallPlugin[], isFirstTime: boolean): Set<string> {
  return new Set(plugins.filter((p) => {
    // 超出支持上限的插件不可选：既不预选，也不参与安装 diff
    if (p.unsupported)
      return false
    if (p.installed)
      return true
    // 非首次场景：不推荐未安装的插件，避免已卸载的推荐项仍默认勾着
    if (!isFirstTime)
      return false
    if (p.defaultUnchecked)
      return false
    return p.recommended || p.fix || p.defaultChecked
  }).map(p => p.id))
}

/** 预设插件标识 → 图标；清单新增预设时回落通用图标，不因缺映射而空白 */
const PLUGIN_ICONS: Record<string, IconComponent | undefined> = {
  'dshmarket': ShoppingCart,
  'dsh-better-sidebar': LayoutSideContentLeft,
  'dsh-rewind-plugin': ArrowUturnCcwLeft,
  'billion-context': Cubes3Overlap,
  '@xmanrui/dsh-im': Comments,
}

/** 插件卡片：图标 + 名称 + 状态 chip 在顶，描述居中，开关居底部右侧 */
function PluginCard({ plugin, checked, toUninstall, disabled, onToggle, onOpenRepo }: {
  plugin: PreinstallPlugin
  checked: boolean
  /** 已安装但被取消勾选 → 待卸载（警告 chip） */
  toUninstall: boolean
  disabled: boolean
  onToggle: (id: string, checked: boolean) => void
  onOpenRepo: (id: string) => void
}) {
  const { t } = useTranslation()
  const PluginIcon = PLUGIN_ICONS[plugin.id] ?? PlugConnection

  return (
    <Card
      className={`h-[120px] gap-1 bg-panel2 p-3 shadow-none transition-colors ${plugin.unsupported ? 'opacity-60' : 'hover:border-line-strong'}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <PluginIcon className="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {plugin.name}
        </span>
        <If cond={plugin.recommended && !plugin.installed && !toUninstall && !plugin.unsupported}>
          <Chip size="sm" variant="soft" color="success" className="shrink-0 font-medium">
            {t('preinstall.recommend')}
          </Chip>
        </If>
        <If cond={plugin.fix && !plugin.installed && !toUninstall && !plugin.unsupported}>
          <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">
            {t('preinstall.fix')}
          </Chip>
        </If>
        <If cond={plugin.unsupported}>
          <Chip size="sm" variant="soft" color="danger" className="shrink-0 font-medium">
            {t('preinstall.unsupported_core')}
          </Chip>
        </If>
        <If cond={plugin.installed && !toUninstall}>
          <Chip size="sm" variant="soft" color="default" className="shrink-0 font-medium">
            {t('preinstall.installed')}
          </Chip>
        </If>
        <If cond={toUninstall}>
          <Chip size="sm" variant="soft" color="warning" className="shrink-0 font-medium">
            {t('preinstall.to_uninstall')}
          </Chip>
        </If>
      </div>

      <If cond={plugin.description !== ''}>
        <Ellipsis lineClamp={2} className="text-[11px] leading-[17px] text-muted my-auto">
          {plugin.description}
        </Ellipsis>
      </If>

      <div className="flex items-center justify-between gap-2">
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="size-6 shrink-0 text-muted"
          aria-label={t('preinstall.open_repo', { name: plugin.name })}
          onPress={() => onOpenRepo(plugin.id)}
        >
          <ArrowUpRightFromSquare className="size-3" />
        </Button>
        <Switch
          size="sm"
          isSelected={checked}
          isDisabled={disabled || plugin.unsupported}
          onChange={isSelected => onToggle(plugin.id, isSelected)}
          aria-label={plugin.name}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
    </Card>
  )
}

/** 日志控制台：dsh plugin 进程输出，顶部带复制按钮，样式与安装/加载页日志面板一致 */
function LogPanel({ logs }: { logs: readonly string[] }) {
  const { t } = useTranslation()
  const text = logs.join('\n')

  async function copyLogs() {
    try {
      // 成功/失败提示由 writeClipboardText 统一给出，这里只记录日志
      await writeClipboardText(text || '', t('messages.log_copied'))
    }
    catch (err) {
      console.error('[Harness] copy preinstall logs failed:', err)
    }
  }

  return (
    <Logs
      logs={logs}
      limit={100}
      bodyClassName="max-h-[240px]"
      header={(
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          className="size-6 shrink-0"
          aria-label={t('buttons.copy')}
          onPress={copyLogs}
        >
          <Copy className="size-3.5" />
        </Button>
      )}
    />
  )
}

/**
 * 安装过程视图：把「正在装什么」讲清楚，日志默认收起。
 *
 * 普通用户不该在第一屏看到 pnpm 原始输出——那是排查用的。默认给一份进度
 * （正在安装的插件、当前阶段），需要细节时再展开日志。
 */
function InstallProgress({ logs, targets, title }: {
  logs: readonly string[]
  targets: readonly string[]
  title: string
}) {
  const { t } = useTranslation()
  const [showLogs, setShowLogs] = useState(false)
  return (
    <div className="flex flex-col gap-2.5">
      <Card className="flex flex-col gap-2 bg-panel2 p-4 shadow-none">
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-[13px] font-medium text-ink">{title}</span>
        </div>
        {targets.length > 0 && (
          <div className="flex flex-col gap-1">
            {targets.map(target => (
              <span key={target} className="truncate text-[11px] text-muted">{target}</span>
            ))}
          </div>
        )}
      </Card>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-fit"
        onPress={() => setShowLogs(value => !value)}
      >
        {showLogs ? t('preinstall.hide_details') : t('preinstall.show_details')}
      </Button>
      <If cond={showLogs}>
        <LogPanel logs={logs} />
      </If>
    </div>
  )
}

/** 被拒进程展示的精确版本清单：授权按精确 `包名@版本` 生效，因此原样展示 */
function refusedVersions(process: PluginProcess): string {
  return (process.refusal?.versions ?? []).map(item => `${item.name}@${item.version}`).join('、')
}

/**
 * 内核步骤：可选安装清单声明的内核。
 *
 * 分层（与插件步骤的唯一区别，见 ONBOARDING-MECHANISM-v2 §5.4.5）：
 * - **卡片内**：该内核自己的状态与阶段（进度层）——每张卡独立，互不覆盖；
 * - **卡片外**：完整原始输出（日志层）——与插件步骤同一个 `LogPanel`、
 *   同一个 `preinstall.logs`，装成功后仍可展开查看。
 *
 * 卡片内不出现任何原始命令行文本。阶段词是真实里程碑，不是按输出猜的百分比。
 */
function KernelStep({ installing }: { installing: boolean }) {
  const { t } = useTranslation()
  const preinstall = useStore(store.preinstall)
  const busy = Object.keys(preinstall.kernelPhases).length > 0
  const [showLogs, setShowLogs] = useState(false)

  /** 卡片内的状态词：安装中取阶段，否则取已装/未装。 */
  const statusOf = (kernel: PreinstallKernel): string => {
    const phase = preinstall.kernelPhases[kernel.id]
    if (phase === 'resolving')
      return t('preinstall.kernel_phase_resolving')
    if (phase === 'downloading')
      return t('preinstall.kernel_phase_downloading')
    if (phase === 'verifying' || phase === 'ready')
      return t('preinstall.kernel_phase_verifying')
    if (kernel.installed) {
      return kernel.detectedVersion !== null
        ? t('preinstall.kernel_installed', { version: kernel.detectedVersion })
        : t('preinstall.kernel_installed', { version: '' })
    }
    return t('preinstall.kernel_optional')
  }

  const sourceOf = (kernel: PreinstallKernel): string | null =>
    kernel.source === undefined || kernel.source === null
      ? null
      : t(`preinstall.kernel_source_${kernel.source}`)

  return (
    <div className="flex flex-col gap-3">
      <If cond={preinstall.kernels.length > 0} else={<Empty>{t('preinstall.kernel_empty')}</Empty>}>
        <div className="flex flex-col gap-2">
          {preinstall.kernels.map((kernel) => {
            const phase = preinstall.kernelPhases[kernel.id]
            const installingThis = phase !== undefined
            const source = sourceOf(kernel)
            return (
              <Card key={kernel.id} className="flex flex-col gap-2 bg-panel2 p-3 shadow-none">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-ink">{kernel.name}</span>
                    <span className="truncate text-[11px] text-muted">{statusOf(kernel)}</span>
                    {kernel.installed && source !== null && (
                      <span className="truncate text-[11px] text-muted">{source}</span>
                    )}
                  </div>
                  <If cond={!kernel.installed && !installingThis}>
                    <Button
                      size="sm"
                      variant="primary"
                      className="h-8 shrink-0"
                      isDisabled={busy || installing}
                      onPress={() => { void store.preinstall.installKernel(kernel.id) }}
                    >
                      {t('preinstall.kernel_install')}
                    </Button>
                  </If>
                  <If cond={installingThis}>
                    <Spinner size="sm" className="shrink-0" />
                  </If>
                  <If cond={kernel.installed}>
                    <Chip size="sm" variant="soft" color="default" className="shrink-0">{t('preinstall.installed')}</Chip>
                  </If>
                </div>
                {/* 进度层：不确定进度条。npm 不给百分比，不造假。 */}
                <If cond={installingThis}>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-default-200">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                  </div>
                </If>
              </Card>
            )
          })}
        </div>
      </If>
      {preinstall.error !== '' && (
        <div className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/5 p-3">
          <p className="text-xs font-medium text-danger">{t('preinstall.kernel_failed')}</p>
          <p className="max-h-[120px] overflow-y-auto break-all font-mono text-[11px] text-muted">{preinstall.error}</p>
        </div>
      )}
      {/* 日志层：始终在卡片外，与插件步骤同款折叠面板。 */}
      <If cond={preinstall.logs.length > 0}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-fit"
          onPress={() => setShowLogs(value => !value)}
        >
          {showLogs ? t('preinstall.hide_details') : t('preinstall.show_details')}
        </Button>
        <If cond={showLogs}>
          <LogPanel logs={preinstall.logs} />
        </If>
      </If>
      <div className="flex items-center justify-between gap-2">
        <Button className="h-8" size="sm" variant="tertiary" isDisabled={busy || installing} onPress={() => store.preinstall.backStep()}>
          {t('preinstall.back')}
        </Button>
        <Button className="h-8" size="sm" variant="primary" isDisabled={busy || installing} onPress={() => { void store.preinstall.advance() }}>
          {t('preinstall.continue')}
        </Button>
      </div>
    </div>
  )
}

/**
 * `remote-call` 步骤：完全由配置驱动的授权卡片。
 *
 * 宿主只执行三条原语：
 * 1. **取值** —— 调 `read` 拿回一个对象；
 * 2. **比较** —— `{ path, equals }` 做字符串相等，用于判定完成与决定显隐；
 * 3. **渲染 / 调用** —— 按 `fields` 显示正文，按 `actions` 调用 `method`。
 *
 * 代码里没有任何业务字面量：不知道状态值叫什么、不知道哪颗按钮是「登录」。
 * 换一个 provider（OAuth 设备授权、轮询某种就绪标志、……）只改配置。
 *
 * 界面规则（ONBOARDING-MECHANISM-v2 §5.5.1）：
 * - R1 值为空的行整行不渲染（不出现幽灵空白行）；
 * - R2 只翻译存在的 i18n key，不存在则整条不渲染（绝不输出 key 原文）；
 * - R3 同一时刻卡片内最多一个 action（取首条 `showWhen` 成立项）；
 * - R4 顶部按 `states` 查表显示状态标题；
 * - R5 字段是正文不是表单（无输入框、无表格线）；
 * - R6 `open: true` 的字段渲染成按钮而不是裸 URL。
 */
function RemoteCallStep({ step, installing }: { step: OnboardingStep, installing: boolean }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remote, setRemote] = useState<OnboardingRemoteState | null>(null)
  // 这一步的全部动作都打本地服务。服务尚未健康时探测必然失败，而那次失败只是
  // 「还没起来」，不是真的错误——等它就好。把等待表达成界面状态，而不是让用户
  // 先看到一条红色失败、过一会儿它自己又好了。
  const harness = useStore(store.harness)
  const waitingForService = !harness.serviceHealthy

  const spec = step.remote
  const readValue = useCallback(
    (path: string | undefined): unknown => {
      if (path === undefined || remote === null)
        return undefined
      const value = remote.state[path.trim()]
      return value ?? undefined
    },
    [remote],
  )
  const visible = useCallback(
    (showWhen: { path: string, equals: string } | undefined): boolean => {
      if (showWhen === undefined)
        return true
      return readValue(showWhen.path) === showWhen.equals
    },
    [readValue],
  )

  const refresh = useCallback(async () => {
    if (spec === undefined)
      return
    try {
      setRemote(await invoke<OnboardingRemoteState>('probe_onboarding_remote', { id: step.id }))
      setError('')
    }
    catch (err) {
      // 传输失败不能当作「未完成」静默重试：显示出来，用户才知道发生了什么。
      setError(String(err))
    }
  }, [spec, step.id])

  useMount(() => {
    if (!waitingForService)
      void refresh()
  })
  // 服务刚就绪时补第一次探测：挂载那一刻它还没起来，`useMount` 里刻意没有发请求。
  useWatch([waitingForService], () => {
    if (!waitingForService && remote === null)
      void refresh()
  })
  // 轮询何时停：判定为完成**并且连续两次拿到相同的状态**才停。
  //
  // 「完成」只说明判定字段到位了，不保证同一时刻的展示字段都已填好——一个 provider
  // 完全可能在完成态里先给出空的结果集，稍后才补齐（例如模型列表来自一次独立的
  // 拉取）。只要一看到完成就停轮询，卡片就会永久停在那个空的中间态上。
  //
  // 这里不判断任何具体字段的语义（宿主不知道哪个值是「目录还没拉完」）：只要求
  // 完成态下的状态值稳定下来。多轮询一两次，代价可忽略。
  const [stableReady, setStableReady] = useState(false)
  const previous = useRef<string | null>(null)
  useWatch([remote], () => {
    if (remote === null)
      return
    const signature = JSON.stringify(remote.state)
    if (remote.ready && previous.current === signature)
      setStableReady(true)
    previous.current = signature
  })
  useIntervalFn(() => {
    if (busy || stableReady || waitingForService)
      return
    void refresh()
  }, spec?.pollMs ?? 1500)

  const run = useCallback(async (method: string) => {
    setBusy(true)
    setError('')
    try {
      await invoke('invoke_onboarding_remote', { id: step.id, method })
      await refresh()
    }
    catch (err) {
      setError(String(err))
    }
    finally {
      setBusy(false)
    }
  }, [refresh, step.id])

  /** 把字段值规整成可渲染的字符串；空值一律返回空串（R1 的依据）。 */
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''

  /** R2：key 不存在时返回 null，调用方整条跳过。 */
  const labelOf = (key: string | undefined): string | null => {
    if (key === undefined || !i18n.exists(key))
      return null
    return t(key)
  }

  /** R4：状态标题。查不到对应项时返回 null（不编造文案）。 */
  const stateTitle = (): string | null => {
    if (spec?.statusPath === undefined)
      return null
    const current = readValue(spec.statusPath)
    const match = (spec.states ?? []).find(item => item.value === current)
    return match === undefined ? null : labelOf(match.label)
  }

  // R1：值为空的字段整行不渲染。
  const visibleFields = (spec?.fields ?? [])
    .filter(field => visible(field.showWhen) && text(readValue(field.path)) !== '')

  // R3：只取第一条成立的 action 作为卡片主按钮。
  const primary = (spec?.actions ?? []).find(action => visible(action.showWhen))
  const primaryLabel = primary === undefined ? null : labelOf(primary.label)

  const title = stateTitle()

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 bg-panel2 p-4 shadow-none">
        {spec === undefined
          ? <p className="text-[12px] text-muted">{labelOf('preinstall.remote_unconfigured') ?? ''}</p>
          : waitingForService
            ? (
                <div className="flex items-center gap-2">
                  <Spinner size="sm" />
                  <span className="text-[12px] text-muted">{labelOf('preinstall.remote_starting') ?? ''}</span>
                </div>
              )
            : (
              <>
                {title !== null && (
                  <span className="text-[13px] font-medium text-ink">{title}</span>
                )}
                {visibleFields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {visibleFields.map((field) => {
                      const value = text(readValue(field.path))
                      const label = labelOf(field.label)
                      return (
                        <div key={field.path} className="flex flex-col gap-0.5">
                          {label !== null && (
                            <span className="text-[11px] text-muted">{label}</span>
                          )}
                          <div className="flex items-center gap-2">
                            {/* R6：open 字段渲染成按钮，不铺裸 URL。 */}
                            <If
                              cond={field.open === true}
                              else={(
                                <span className="break-all font-mono text-[13px] text-ink">{value}</span>
                              )}
                            >
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 w-fit"
                                onPress={() => { window.open(value, '_blank', 'noopener,noreferrer') }}
                              >
                                {labelOf('preinstall.remote_open') ?? value}
                              </Button>
                            </If>
                            <If cond={field.copy === true && field.open !== true}>
                              <Button
                                size="sm"
                                variant="tertiary"
                                className="h-7 w-fit shrink-0"
                                onPress={() => { void navigator.clipboard.writeText(value).catch(() => {}) }}
                              >
                                {labelOf('preinstall.remote_copy') ?? ''}
                              </Button>
                            </If>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {primary !== undefined && primaryLabel !== null && (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-8"
                      isDisabled={busy || installing}
                      onPress={() => { void run(primary.method) }}
                    >
                      <If cond={busy}><Spinner size="sm" color="current" /></If>
                      {primaryLabel}
                    </Button>
                  </div>
                )}
              </>
            )}
      </Card>

      {error !== '' && (
        <div className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/5 p-3">
          <p className="text-xs font-medium text-danger">{labelOf('preinstall.remote_failed') ?? ''}</p>
          <p className="max-h-[120px] overflow-y-auto break-all font-mono text-[11px] text-muted">{error}</p>
        </div>
      )}

      {/* 页面底部：只有导航，没有 Skip。 */}
      <div className="flex items-center justify-between gap-2">
        <Button className="h-8" size="sm" variant="tertiary" isDisabled={busy || installing} onPress={() => store.preinstall.backStep()}>
          {t('preinstall.back')}
        </Button>
        <Button className="h-8" size="sm" variant="primary" isDisabled={busy || installing} onPress={() => { void store.preinstall.advance() }}>
          {t('preinstall.continue')}
        </Button>
      </div>
    </div>
  )
}

export function PreinstallSetup() {
  const { t } = useTranslation()
  const preinstall = useStore(store.preinstall)
  // 引导页不自行提示（toast: false）也不自行重启（restartOnSettle: false）：
  // 提示权在页面，重启由收尾的 continueStartup 统一做一次
  const manager = useDshPluginsManager({ toast: false, restartOnSettle: false })
  // 用户手动调整后的选择（一旦交互即接管默认勾选）
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [touched, setTouched] = useState(false)
  // 授权勾选集合：被拒插件必须由用户明确接受风险，不想装的人可以「跳过」退出
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set())
  // 授权进行中：写豁免期间禁用按钮并显示加载态
  const [granting, setGranting] = useState(false)
  // 本轮提交的失败明细（管理器以 ok:false 表达失败，不抛异常）
  const [failures, setFailures] = useState<string[]>([])

  // 当前步骤完全由清单配置决定：不配置某一步，这里就没有那一步。
  const currentStep = preinstall.currentStep()

  const approvals = manager.pendingApprovals
  const incompatibleApprovals = approvals.filter(process => process.refusal?.kind === 'incompatible')
  const policyApprovals = approvals.filter(process => process.refusal?.kind !== 'incompatible')

  // 进入引导页时拉取插件列表（仅挂载一次，无需清理）
  useMount(() => {
    void store.preinstall.load()
    void store.preinstall.loadKernels()
    // 拉完进度后自愈：清单里已无待办（例如上一轮已完成但壳层仍停在
    // preinstall）时，立即收尾。否则这里会渲染成一个没有任何步骤内容的空壳，
    // 用户既看不到也点不到。
    void store.preinstall.loadOnboarding().then((view) => {
      if (view !== null && view.current === null)
        void store.preinstall.finish()
    })
  })

  // dsh plugin 进程输出经 `preinstall-log` 回流；卸载即注销，不残留监听
  useListen<{ line: string }>('preinstall-log', (event) => {
    store.preinstall.pushLog(event.payload.line)
  })

  // 默认勾选：已安装 + 未安装的推荐插件 +「修复」类项 + 无 chip 但标记默认勾选的项（如 dsh-notification）。
  // 派生计算而非在加载回调里 setState，避免与 store 的加载去重守卫竞争，
  // 保证插件到位后默认勾选必定生效（用户手动调整后以用户选择为准）。
  const effectiveSelected = !touched
    ? initialCheckedSet(preinstall.plugins, preinstall.isFirstTime)
    : selected

  function toggle(id: string, checked: boolean) {
    // 首次交互以「当前默认勾选」为起点：selected 初始为空，若直接在其上增删，
    // 取消一个会误把其余默认项一并取消。这里先以 initialCheckedSet 播种，
    // 再应用本次勾选，保证「取消一个 = 只取消这一个」。
    const seed = !touched ? initialCheckedSet(preinstall.plugins, preinstall.isFirstTime) : null
    setTouched(true)
    setSelected((prev) => {
      const next = new Set(seed ?? prev)
      if (checked) {
        next.add(id)
      }
      else {
        next.delete(id)
      }
      return next
    })
  }

  function openRepo(id: string) {
    void invoke('open_preinstall_repo', { id }).catch((err) => {
      console.error('[Harness] open preinstall repo failed:', err)
    })
  }

  /**
   * 汇总一组进程结果里的失败明细，供错误面板展示。
   * `already-absent` 是卸载的「已达成的目标」（插件本就不在 profile），`cancelled` 是用户
   * 自己按下的取消，两者都不是需要用户重试的失败。
   */
  function collectFailures(results: Awaited<ReturnType<typeof manager.install>>): string[] {
    return results
      .filter(result => !result.ok && result.reason !== 'already-absent' && result.reason !== 'cancelled')
      .map(result => `${result.process.name}: ${result.error ?? ''}`)
  }

  async function handleConfirm() {
    // 基于 plugin.installed 推导操作：选中且未安装 → 安装；已安装且未选中 → 卸载
    const toInstall = preinstall.plugins
      .filter(p => effectiveSelected.has(p.id) && !p.installed)
      .map(p => p.id)
    const toUninstall = preinstall.plugins
      .filter(p => p.installed && !effectiveSelected.has(p.id) && !p.unsupported)
      .map(p => p.id)
    setFailures([])
    const failed: string[] = []
    // 卸载在前：避免新装插件与待卸载插件冲突；两者各自成组，由队列保证先后
    if (toUninstall.length > 0)
      failed.push(...collectFailures(await manager.uninstall(toUninstall)))
    if (toInstall.length > 0)
      failed.push(...collectFailures(await manager.install(toInstall)))
    // 刷新 installed 标记：卸载已生效但安装失败时，重试的 diff 必须基于新状态，
    // 否则已移除的插件会再次被当作待卸载项，重试永远不会成功。
    await store.preinstall.load()
    if (failed.length > 0) {
      setFailures(failed)
      return
    }
    // 标记本步完成并推进；全部完成时才收尾。步骤有哪些完全由配置决定。
    await store.preinstall.advance()
  }

  function handleSkip() {
    void store.preinstall.skip()
  }

  function toggleAllowed(id: string, checked: boolean) {
    setAllowed((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(id)
      }
      else {
        next.delete(id)
      }
      return next
    })
  }

  /**
   * 授权勾选的风险项并续传。
   *
   * 豁免只对「精确的包名@版本（+ 运行时版本）」生效、且不随插件或核心升级继承，因此
   * 必须真的重跑一次由 dsh 复核，不能假定授权即放行——`approve` 内部写豁免后会把
   * 剩余集合重新提交，返回的 Promise 在整组结算后才 Resolve。
   */
  async function handleGrant(targets: PluginProcess[]) {
    const picked = targets.filter(process => allowed.has(process.id))
    if (granting || picked.length === 0)
      return
    setGranting(true)
    try {
      const failed = collectFailures(await manager.approve(picked.map(process => process.spec)))
      if (failed.length > 0)
        setFailures(failed)
    }
    finally {
      setGranting(false)
    }
  }

  // 是否有变更：存在需安装或需卸载的插件时启用"确定"
  const toInstallCount = preinstall.plugins.filter(p => effectiveSelected.has(p.id) && !p.installed).length
  const toUninstallCount = preinstall.plugins.filter(p => p.installed && !effectiveSelected.has(p.id) && !p.unsupported).length
  const hasChanges = toInstallCount > 0 || toUninstallCount > 0
  // 有进程在排队/执行中即视为安装中；但只要有待授权项就必须切到授权视图：整批被拒时
  // 未被点名的进程会回到 pending 等授权，若仍按「存在非 unauthorized 进程」判定，授权
  // 界面永远不会出现，用户只能取消。
  const installing = approvals.length === 0 && manager.processes.length > 0
  // 本次提交要装的插件名（仅用于安装中的进度展示，不参与安装决策）。
  const pendingTargets = preinstall.plugins
    .filter(plugin => effectiveSelected.has(plugin.id) && !plugin.installed)
    .map(plugin => plugin.name)

  const blocked = approvals.length > 0
  const failing = failures.length > 0

  return (
    <div className="flex h-full w-full items-center justify-center bg-startup">
      <div className="flex w-[min(880px,92vw)] flex-col gap-4">
        <header className="flex flex-col items-center gap-1 text-center">
          <Typography type="h4" className="!text-ink">
            {t(currentStep?.title ?? 'preinstall.title')}
          </Typography>
          <Typography color="muted" type="body-sm" className="max-w-[440px]">
            {t(`preinstall.step_${currentStep?.kind ?? 'plugin-selection'}_subtitle`)}
          </Typography>
        </header>

        <If cond={currentStep?.kind === 'native-kernel'}>
          <KernelStep installing={installing} />
        </If>
        <If cond={currentStep !== null && currentStep.kind === 'remote-call'}>
          <RemoteCallStep step={currentStep as OnboardingStep} installing={installing} />
        </If>
        <If cond={currentStep?.kind === 'plugin-selection'}>
        <If
          cond={installing}
          else={(
            // 被核心版本拦截、被 pnpm 发布时长策略拦截（都可逐项授权）或安装失败时
            // 不叠加插件列表，只展示原因 + 日志 + 操作
            <If
              cond={blocked || failing}
              else={(
                <>
                  {/* 卡片网格限定高度滚动，上下溢出由 ScrollShadow 渐隐提示 */}
                  <ScrollShadow className="max-h-[min(50vh,420px)]" size={36}>
                    <div className="grid grid-cols-1 gap-2.5 pr-1 sm:grid-cols-2 lg:grid-cols-3">
                      <If
                        cond={preinstall.loadError === ''}
                        else={(
                          // 列表加载失败（区别于空列表）：错误说明 + 重试
                          <div className="flex flex-col items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 p-4 text-center sm:col-span-2 lg:col-span-3">
                            <p className="text-xs font-medium text-danger">{t('preinstall.load_failed')}</p>
                            <p className="max-h-[80px] max-w-full overflow-y-auto break-all font-mono text-[11px] text-muted">
                              {preinstall.loadError}
                            </p>
                            <Button
                              className="h-8"
                              size="sm"
                              variant="primary"
                              onPress={() => void store.preinstall.load()}
                              isDisabled={preinstall.loading}
                            >
                              {t('app.retry')}
                            </Button>
                          </div>
                        )}
                      >
                        <If
                          cond={preinstall.plugins.length > 0}
                          else={(
                            <Empty className="sm:col-span-2 lg:col-span-3">{t('preinstall.empty')}</Empty>
                          )}
                        >
                          {preinstall.plugins.map((plugin) => {
                            const checked = effectiveSelected.has(plugin.id)
                            // 已安装但用户取消勾选 → 待卸载（超出支持上限的项不参与）
                            const toUninstall = plugin.installed && !checked && !plugin.unsupported
                            return (
                              <PluginCard
                                key={plugin.id}
                                plugin={plugin}
                                checked={checked}
                                toUninstall={toUninstall}
                                disabled={installing}
                                onToggle={toggle}
                                onOpenRepo={openRepo}
                              />
                            )
                          })}
                        </If>
                      </If>
                    </div>
                  </ScrollShadow>

                  {/* 可取消勾选提示：让用户知道预设插件可减选，取消后不会安装 */}
                  <If cond={preinstall.plugins.length > 0 && !installing && !failing}>
                    <p className="text-center text-xs text-muted">{t('preinstall.can_uncheck_hint')}</p>
                  </If>

                  {/* 操作区：有变更 → 「安装」；无变更 → 「继续」。不提供 Skip：
                      不想装就把勾选取消，底部自然变回「继续」。 */}
                  <div className="flex items-center justify-end gap-2">
                    <If cond={!hasChanges}>
                      <Then>
                        <Button
                          className="h-8"
                          size="sm"
                          variant="primary"
                          data-testid="dsh-setup-preinstall-continue"
                          onPress={() => { void store.preinstall.advance() }}
                          isDisabled={installing}
                        >
                          {t('preinstall.continue')}
                        </Button>
                      </Then>
                      <Else>
                        <Button
                          className="h-8"
                          size="sm"
                          variant="primary"
                          data-testid="dsh-setup-preinstall-install"
                          onPress={handleConfirm}
                          isDisabled={installing}
                        >
                          {t('preinstall.confirm')}
                        </Button>
                      </Else>
                    </If>
                  </div>
                </>
              )}
            >
              <If
                cond={blocked}
                else={(
                  // 安装失败：错误信息 + 日志 + 操作
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/5 p-3">
                      <p className="text-xs font-medium text-danger">{t('preinstall.failed')}</p>
                      <p className="max-h-[120px] overflow-y-auto break-all font-mono text-[11px] leading-relaxed text-muted">
                        {failures.join('\n')}
                      </p>
                    </div>
                    <LogPanel logs={preinstall.logs} />
                    <div className="flex items-center justify-end gap-2">
                      <Button className="h-8" size="sm" variant="tertiary" onPress={handleSkip} isDisabled={installing}>
                        {t('preinstall.skip')}
                      </Button>
                      <Button
                        className="h-8"
                        size="sm"
                        variant="primary"
                        onPress={handleConfirm}
                        isDisabled={installing || !hasChanges}
                      >
                        {t('app.retry')}
                      </Button>
                    </div>
                  </div>
                )}
              >
                <div className="flex flex-col gap-2.5">
                  {/* 版本兼容性拒绝：核心在 pnpm 之前拦下整批安装，插件与当前核心的
                      DSH peer 依赖不匹配；逐项授权精确版本（风险由用户明确承担）后重试 */}
                  <If cond={incompatibleApprovals.length > 0}>
                    <div className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger/5 p-3">
                      <p className="text-xs font-medium text-danger">{t('preinstall.incompatible_title')}</p>
                      <p className="text-[11px] leading-relaxed text-muted">{t('preinstall.incompatible_desc')}</p>
                      <div className="mt-0.5 flex flex-col gap-1.5">
                        {incompatibleApprovals.map(process => (
                          <label key={process.id} className="flex cursor-pointer items-center gap-2">
                            <Checkbox
                              className="shrink-0"
                              isSelected={allowed.has(process.id)}
                              onChange={(value: boolean) => toggleAllowed(process.id, value)}
                              aria-label={process.name}
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                              </Checkbox.Content>
                            </Checkbox>
                            <span className="font-mono text-[11px] text-ink">{refusedVersions(process)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </If>

                  {/* 发布时长策略 / 升级保留拦截：档案已声明太新的版本时每次插件操作都失败，
                      同样逐项授权后重跑 */}
                  <If cond={policyApprovals.length > 0}>
                    <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 p-3">
                      <p className="text-xs font-medium text-warning">{t('preinstall.policy_title')}</p>
                      <p className="text-[11px] leading-relaxed text-muted">{t('preinstall.policy_desc')}</p>
                      <div className="mt-0.5 flex flex-col gap-1.5">
                        {policyApprovals.map(process => (
                          <label key={process.id} className="flex cursor-pointer items-center gap-2">
                            <Checkbox
                              className="shrink-0"
                              isSelected={allowed.has(process.id)}
                              onChange={(value: boolean) => toggleAllowed(process.id, value)}
                              aria-label={process.name}
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                              </Checkbox.Content>
                            </Checkbox>
                            <span className="font-mono text-[11px] text-ink">{refusedVersions(process) || process.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </If>

                  <LogPanel logs={preinstall.logs} />
                  <div className="flex items-center justify-end gap-2">
                    <Button className="h-8" size="sm" variant="tertiary" onPress={handleSkip} isDisabled={granting}>
                      {t('preinstall.skip')}
                    </Button>
                    <Button
                      className="h-8"
                      size="sm"
                      variant="primary"
                      onPress={() => void handleGrant(approvals)}
                      isDisabled={granting || allowed.size === 0}
                    >
                      <If cond={granting}>
                        <Spinner size="sm" color="current" />
                        <span>{t('preinstall.granting')}</span>
                      </If>
                      <If cond={!granting}>
                        <span>{t('preinstall.confirm')}</span>
                      </If>
                    </Button>
                  </div>
                </div>
              </If>
            </If>
          )}
        >
          {/* 安装中：讲清楚正在装什么，原始日志收起在「显示详细信息」后面 */}
          <div className="flex flex-col gap-2.5">
            <InstallProgress
              logs={preinstall.logs}
              targets={pendingTargets}
              title={t('preinstall.installing')}
            />
            {/* 取消安装：网络抖动/限流（429）时可能长时间卡在重试，给用户退出入口 */}
            <div className="flex items-center justify-center">
              <Button
                className="h-8"
                size="sm"
                variant="tertiary"
                onPress={() => void manager.cancel()}
                isDisabled={manager.cancelling || manager.processes.length === 0}
              >
                <Xmark className="size-3.5" />
                {manager.cancelling ? t('preinstall.cancelling') : t('preinstall.cancel')}
              </Button>
            </div>
          </div>
        </If>
        </If>
      </div>
    </div>
  )
}
