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

/** 宿主支持的通用步骤动作类型（与 Rust `OnboardingKind` 对齐）。 */
export type OnboardingKind = 'plugin-selection' | 'native-kernel' | 'remote-call'

/**
 * `remote-call` 步骤的完成判定：读返回值里的 `path` 字段，等于 `equals` 即完成。
 *
 * 壳层不认识 `path` 指向什么字段、也不认识 `equals` 的含义——两者都来自配置。
 */
export interface RemoteReadyRule {
  path: string
  equals: string
}

/** `remote-call` 步骤调用的 Remote 方法与判定规则（与 Rust `RemoteCallSpec` 对齐）。 */
export interface RemoteCallSpec {
  /** Remote 命名空间，纯字符串透传。 */
  namespace: string
  /** 读取状态的方法名。 */
  state: string
  /** 发起授权的方法名；缺省表示只能等待状态达成，不能主动发起。 */
  signIn?: string
  /** 完成判定。 */
  ready: RemoteReadyRule
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
  /** 里程碑阶段：`start` 开始、`done` 完成、`fail` 失败；普通输出行缺省。 */
  phase?: 'start' | 'done' | 'fail'
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
export interface PreinstallKernel {
  id: string
  name: string
  package: string
  version: string | null
  installed: boolean
  detectedVersion: string | null
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
