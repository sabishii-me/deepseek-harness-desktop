/**
 * 首次启动引导（onboarding）的类型定义。
 *
 * 步骤**全部来自资源清单**（`manifest.jsonc` 的 `onboarding.steps`），壳层只认
 * `kind` 这几种通用动作类型，不认识任何具体产品或插件。因此：
 * - 增删步骤不需要改这些类型，只改清单；
 * - 这里不出现任何 provider 的名字、状态字面量。
 *
 * 与 Rust `config::onboarding` 对齐。
 */

/** 内核安装的过程阶段（卡片内的进度层，与日志层分开）。 */
export type KernelPhase = 'resolving' | 'downloading' | 'verifying' | 'ready'

/** 宿主支持的通用步骤动作类型（与 Rust `OnboardingKind` 对齐）。 */
export type OnboardingKind = 'plugin-selection' | 'native-kernel' | 'remote-call'

/** 一次字段比较：取 `path` 指向的单层字段，与 `equals` 比较（与 Rust `RemoteCondition` 对齐）。 */
export interface RemoteCondition {
  path: string
  equals: string
}

/** 卡片正文的一行（与 Rust `RemoteField` 对齐）。 */
export interface RemoteField {
  /** 何时显示；缺省 = 总是显示。 */
  showWhen?: RemoteCondition
  path: string
  /** 行首文案的 i18n key；缺省时只显示值。 */
  label?: string
  /** 是否附带「复制」按钮。 */
  copy?: boolean
  /** 该值是否是一个可打开的目标（渲染成按钮，而不是铺裸 URL）。 */
  open?: boolean
}

/** 卡片内的一颗按钮（与 Rust `RemoteAction` 对齐）。 */
export interface RemoteAction {
  showWhen?: RemoteCondition
  /** 点击时调用的 Remote 方法名。 */
  method: string
  /** 按钮文案的 i18n key。 */
  label: string
}

/**
 * `remote-call` 步骤描述（与 Rust `RemoteCallSpec` 对齐）。
 *
 * 宿主只做：取值（`read`）→ 比较（`done` / `showWhen`）→ 渲染或调用。
 * 不认识任何具体业务状态。
 */
/**
 * 一个状态的展示：状态值 → 标题文案。
 *
 * 宿主只按 `read` 返回对象里的 `status.path` 值查这张表；查不到时回退到
 * 通用「处理中」文案。表里有什么状态、叫什么，全部由配置决定。
 */
export interface RemoteStateView {
  value: string
  /** 标题文案的 i18n key。 */
  label: string
}

export interface RemoteCallSpec {
  namespace: string
  read: string
  done: RemoteCondition
  /** 状态值取自哪个字段（单层字段名）。缺省时不显示状态标题。 */
  statusPath?: string
  /** 状态值 → 标题。 */
  states?: RemoteStateView[]
  fields?: RemoteField[]
  actions?: RemoteAction[]
  /** 轮询间隔（毫秒），缺省 1500。 */
  pollMs?: number
}

/**
 * 一次 remote 探测的结果（与 Rust `OnboardingRemoteState` 对齐）。
 *
 * `state` 是服务端返回值的原样投影：界面从中取展示所需的字段，但**哪个字段表示
 * 完成**由配置的 `ready.path`/`ready.equals` 决定，不在界面里写死。
 */
export interface OnboardingRemoteState {
  ready: boolean
  state: Record<string, unknown>
}

/** 清单声明的一个引导步骤 + 当前完成状态（与 Rust `OnboardingStepView` 对齐）。 */
export interface OnboardingStep {
  id: string
  kind: OnboardingKind
  /** 标题（i18n key 或直接文案，由界面解析）。 */
  title: string
  /** 用户是否可跳过。 */
  optional: boolean
  /** `kind === 'remote-call'` 时的调用描述。 */
  remote?: RemoteCallSpec
  completed: boolean
}

/** 引导整体状态（与 Rust `OnboardingView` 对齐）。 */
export interface OnboardingView {
  /** 清单声明的全部步骤（含完成标记）。 */
  steps: OnboardingStep[]
  /** 引导是否已结束（全部步骤完成）。 */
  finished: boolean
  /** 结束时间戳。 */
  finishedAt: string | null
  /** 当前应展示的步骤 id；`null` 表示无需引导。 */
  current: string | null
}

/** Rust 侧 preinstall-log 事件载荷（dsh plugin / 内核安装进程输出行）。 */
export interface PreinstallLogPayload {
  line: string
  /** 该行归属的插件或内核 id；宿主无法判定时缺省。 */
  target?: string
  /**
   * 里程碑阶段；普通输出行缺省。
   *
   * 通用阶段名，宿主不认识具体业务：`start` / `done` / `fail` 三类终态，
   * `resolving` / `downloading` / `verifying` 三类过程（目前只有内核安装发）。
   */
  phase?: KernelPhase | 'start' | 'done' | 'fail'
}

/** 预装插件列表项（与 Rust service::plugin::PreinstallPlugin 对齐） */
export interface PreinstallPlugin {
  id: string
  name: string
  description: string
  repo_url: string
  recommended: boolean
  /** "修复"类项（Windows 极简模式修复）：黄色 chip，默认勾选 */
  fix: boolean
  /** 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」） */
  defaultChecked: boolean
  /** 显式声明首次引导不默认勾选（仍可标「推荐」chip，但不预选） */
  defaultUnchecked: boolean
  installed: boolean
  unsupported: boolean
}

/** 清单声明的一个可选内核及其托管状态（与 Rust `KernelDescriptor` 对齐）。 */
/** 内核被找到的位置（与 Rust `KernelSource` 对齐）。 */
export type KernelSource = 'managed' | 'profile' | 'system'

export interface PreinstallKernel {
  id: string
  name: string
  package: string
  version: string | null
  installed: boolean
  detectedVersion: string | null
  /** 命中来源；未安装时为 null。只作为副行说明，不让用户做选择。 */
  source?: KernelSource | null
}

/** 预装插件的安装/卸载 diff（前端比对勾选结果得出） */
export interface PreinstallSelection {
  installIds?: string[]
  uninstallIds?: string[]
}

/**
 * 被核心版本兼容性拦截的插件（与 Rust `service::plugin::IncompatibleVersion` 对齐）。
 *
 * 授权只对**精确的**包名 + 版本 + 运行时版本生效，因此三个字段原样往返后端。
 */
export interface IncompatibleVersion {
  name: string
  version: string
  runtime_version: string
}

/**
 * 被 pnpm 发布时长策略拦截的插件版本（与 Rust `service::plugin::PolicyBlockedVersion` 对齐）。
 *
 * 豁免写进档案的 `minimumReleaseAgeExclude`，按精确 `包名@版本` 生效，因此只需要这两个
 * 字段；运行时版本与这条策略无关。
 */
export interface PolicyBlockedVersion {
  name: string
  version: string
}
