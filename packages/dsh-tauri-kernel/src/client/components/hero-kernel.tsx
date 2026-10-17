import type { ReactElement } from 'react'
import type { BackendDetection, BackendId } from '../../shared/types'
import { isNativeBackend, KERNEL_LABELS, NATIVE_BACKENDS } from '../../shared/types'
import type { HeroKernelProps } from './slot-contract'
import { ChevronDown, Chip, Menu, Xmark } from 'dsh-tauri-ui/client'
import { If, useAsyncState, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { locale } from '../locales'
import { backendFromIdentity, isBackendAvailable, isForkedIdentity } from '../service/kernel-identity'
import { kernelContentAvailable } from '../service/kernel-version'
import { kernelStore } from '../store/modules/kernel-store'
import { KernelIcon, KernelSpinner } from './kernel-icon'

/** Official kernel plus every native kernel, in picker order. */
const LABELS: Record<BackendId, string> = { dsh: 'DeepSeek Harness', ...KERNEL_LABELS }
const CHOICES = NATIVE_BACKENDS

function backendHint(backend: BackendDetection | undefined): string | undefined {
  if (backend === undefined || !backend.installed)
    return locale.text('kernel.unavailable')
  if (backend.bridgeReady === false)
    return locale.text('kernel.coreUnavailable')
  if (backend.drift)
    return locale.text('kernel.drift')
  if (backend.auth === 'missing')
    return locale.text('kernel.authMissing')
  return undefined
}

function pillClass(disabled: boolean, expanded: boolean): string {
  const base = 'group inline-flex h-[28px] items-center rounded-sm whitespace-nowrap leading-none [&>span]:inline-flex [&>span]:h-full [&>span]:items-center'
  if (disabled)
    return `${base} text-[var(--dsw-alias-label-quaternary)]`
  return `${base} text-primary ${expanded ? 'bg-hover' : 'hover:bg-hover'}`
}

export function HeroKernel(props: HeroKernelProps): ReactElement | null {
  locale.useLocale()
  const store = useStore(kernelStore)
  const identity = props.useProjection('bridgeKernel')
  const summary = props.useSessions(state => props.sessionId === undefined ? undefined : state.byId[props.sessionId])
  const workspaces = props.useWorkspaces(state => state.items)
  const [expanded, setExpanded] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  // 菜单关闭不再挂在 `onSuccess` 上：那要求等会话建好（内核冷启动时可达数十秒），
  // 期间菜单一直罩着、界面看上去没任何反应。改为在选择的当下同步关闭，
  // 把等待交给 chip 上的进行中标志（见 §5.7）。
  //
  // `pending` 记住用户点的是哪个内核：既有 `backend` 取自**当前会话**的绑定，
  // 而切换时新会话还没建好，拿它显示会让用户不知道自己点的是哪个。
  const [pending, setPending] = useState<BackendId | undefined>(undefined)
  const { isLoading, error, executeImmediate } = useAsyncState(props.createSession, undefined, {
    immediate: false,
    // 成功与失败都要清掉目标：失败后 chip 应回到真实绑定，而不是停在一个没建成的目标上。
    onSuccess: () => setPending(undefined),
    onError: () => setPending(undefined),
  })
  useWatchImmediate([props.sessionId, identity] as const, ([sessionId, value]) => {
    if (sessionId !== undefined && value === undefined)
      void props.ensureProjection(sessionId)
  })

  if (store.phase === 'ready' && !kernelContentAvailable(store.backends))
    return null

  const awaiting = props.sessionId !== undefined && identity === undefined
  const bound = backendFromIdentity(identity)
  const backend = isNativeBackend(bound) ? bound : undefined
  const roster = new Map(store.backends.map(item => [item.id, item]))
  const workspaceBySession = new Map(workspaces.flatMap(workspace => workspace.sessionIds.map(id => [id, workspace.workspaceId] as const)))
  const workspaceId = props.sessionId === undefined ? undefined : workspaceBySession.get(props.sessionId)
  const busy = isLoading || store.phase === 'loading'
  const capable = props.canCreate()
  const clearable = backend !== undefined && !busy && capable
  const disabled = busy || !capable || awaiting
  const items = CHOICES.map((id) => {
    const hint = backendHint(roster.get(id))
    return {
      id,
      label: (
        <>
          {LABELS[id]}
          <If
            cond={hint !== undefined}
            then={(
              <span className="text-tertiary">{` · ${hint}`}</span>
            )}
          />
        </>
      ),
      icon: <KernelIcon backend={id} />,
      disabled: isLoading || !capable || store.phase !== 'ready' || !isBackendAvailable(roster.get(id)),
    }
  })
  const forked = isForkedIdentity(identity, props.sessionId)
  const title = forked
    ? locale.text('kernel.fork')
    : [
        locale.text('kernel.selectorScope'),
        backend !== undefined ? locale.text('kernel.immutable') : undefined,
      ].filter(Boolean).join(' · ')
  const failure = error == null ? store.error : error instanceof Error ? error.message : String(error)

  function select(id: string): void {
    if (isLoading || store.phase !== 'ready' || !capable || !isNativeBackend(id) || !isBackendAvailable(roster.get(id)))
      return
    // 先关菜单再做工作：结果未回之前，界面就已经进入「处理中」状态。
    setExpanded(false)
    setPending(id)
    const preset = summary?.projectionValues?.agentPreset
    void executeImmediate(id, workspaceId === undefined
      ? summary?.cwd === undefined ? {} : { cwd: summary.cwd }
      : { workspaceId }, typeof preset === 'string' ? preset : undefined)
  }

  function clear(): void {
    setExpanded(false)
    if (isLoading || store.phase !== 'ready' || !capable)
      return
    setPending('dsh')
    const preset = summary?.projectionValues?.agentPreset
    void executeImmediate('dsh', workspaceId === undefined
      ? summary?.cwd === undefined ? {} : { cwd: summary.cwd }
      : { workspaceId }, typeof preset === 'string' ? preset : undefined)
  }

  return (
    <div className="relative inline-flex items-center" data-bridge-kernel-picker="" aria-busy={isLoading}>
      <span className={pillClass(disabled, expanded)} data-bridge-kernel-pill="">
        <Menu
          open={expanded}
          anchor={(
            <Chip
              ref={chipRef}
              variant="seat"
              className={`h-full rounded-none bg-transparent hover:not-disabled:bg-transparent aria-expanded:bg-transparent${clearable ? ' pr-0' : ''}`}
              icon={<KernelIcon backend={pending ?? backend} />}
              // 进行中时在 chevron 位置转圈：图标保留，用户仍知道切的是哪个内核；
              // 此时菜单已关，chevron 本身也没有意义。优先于 `clearable` 的隐藏。
              chevron={busy ? <KernelSpinner /> : clearable ? undefined : <ChevronDown />}
              open={expanded}
              disabled={disabled}
              aria-label={busy ? locale.text('kernel.pending') : locale.text('kernel.label')}
              aria-haspopup="menu"
              aria-expanded={expanded}
              title={title}
              onClick={() => setExpanded(current => !current)}
            >
              {pending !== undefined
                ? LABELS[pending]
                : backend === undefined ? awaiting ? locale.text('kernel.pending') : locale.text('kernel.select') : LABELS[backend]}
            </Chip>
          )}
          items={items}
          selectedId={backend}
          onSelect={select}
          onClose={() => setExpanded(false)}
          portal
          side="bottom"
          getAnchorRect={() => chipRef.current?.getBoundingClientRect() ?? null}
        />
        <If
          cond={clearable}
          then={(
            <button
              type="button"
              disabled={busy}
              aria-label={locale.text('kernel.clear')}
              title={locale.text('kernel.clear')}
              data-bridge-kernel-clear=""
              className="inline-flex shrink-0 cursor-pointer items-center self-stretch border-none bg-transparent pl-[4px] pr-[8px] text-[var(--dsw-alias-label-caption)] disabled:cursor-default [&_svg]:w-[11px] [&_svg]:h-[11px]"
              onClick={clear}
            >
              <span className="inline-flex group-hover:hidden group-focus-visible:hidden" data-bridge-kernel-chevron="">
                <ChevronDown />
              </span>
              <span className="hidden group-hover:inline-flex group-focus-visible:inline-flex" data-bridge-kernel-clear-icon="">
                <Xmark />
              </span>
            </button>
          )}
        />
      </span>
      <If
        cond={failure != null}
        then={(
          <span role="alert" className="text-secondary text-[13px]">
            {failure}
            <button type="button" disabled={busy} onClick={() => { void props.refreshBackends() }}>
              {locale.text('kernel.retry')}
            </button>
          </span>
        )}
      />
    </div>
  )
}
