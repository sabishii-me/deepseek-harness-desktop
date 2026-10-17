import type { UnlistenFn } from '@tauri-apps/api/event'
import type { IncompatibleVersion, KernelPhase, OnboardingStep, OnboardingView, PolicyBlockedVersion, PreinstallKernel, PreinstallLogPayload, PreinstallPlugin, PreinstallSelection } from './types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { hooks } from '@/config/hooks'
import { harness } from '../harness'
import { harnessUpdater } from '../harness-updater'
import { parseBlockedRefusal } from '../plugins/utils'

/**
 * 预装安装日志在界面上的保留行数
 */
const LOG_LIMIT = 200

export { parseBlockedRefusal }
export type { BlockedRefusal } from '../plugins/types'

/**
 * 预装插件引导模块：首次安装、老版本升级或资源清单 plugins 节内容变更后，
 * 展示推荐插件列表（可增选/减选），确认或跳过后继续启动服务。
 *
 * 与 harness 模块的分工：本模块只负责「引导页的选择与安装」，
 * 收尾（拉起服务、检查更新）通过 harness / harnessUpdater 完成。
 */
export const preinstall = defineStore({
  state: () => ({
    /** 推荐插件列表（含已安装检测） */
    plugins: [] as PreinstallPlugin[],
    loading: false,
    installing: false,
    /** 用户触发了“取消”但仍需等后端结束进程树 */
    cancelling: false,
    logs: [] as string[],
    /** 安装失败错误（区别于下面列表加载失败） */
    error: '',
    /**
     * 被核心版本兼容性拦截、等待用户逐项授权的插件版本。
     * 非空时界面展示风险提示与勾选清单（而非插件列表或错误态）。
     */
    incompatible: [] as IncompatibleVersion[],
    /**
     * 被 pnpm 发布时长策略拦下的精确版本（`minimumReleaseAge`）。
     * 非空时同样展示风险提示与勾选清单——档案已声明这些太新的版本，不授权则**每次**
     * 插件操作都会失败，用户在这里勾选授权后重跑安装即可解开。
     */
    policyBlocked: [] as PolicyBlockedVersion[],
    /** 拉取预装插件列表失败（区别于空列表；UI 据此展示错误态 + 重试） */
    loadError: '',
    /** 是否为首次安装引导（决定默认勾选策略）：boot 流程进入时为 true，侧边栏手动打开为 false */
    isFirstTime: true,
    /**
     * 引导配置（来自清单 `onboarding.steps`）：决定有哪些步骤、顺序与各自动作类型。
     * 这里不预设步骤名——不配置某一步，那一步就不存在。
     */
    onboarding: null as OnboardingView | null,
    /** 清单声明的可选内核及托管状态 */
    kernels: [] as PreinstallKernel[],
    /** 正在安装的内核 id（null = 未进行） */
    /** 每个内核各自的安装阶段（卡片内进度层）；未在装的不出现在表里。 */
    kernelPhases: {} as Record<string, KernelPhase>,
    /**
     * 引导是否仍未结束（清单步骤未全部完成）。
     *
     * 服务起来后仍为 true 时，界面把引导层压在 iframe 之上，形成连续的全屏设置流程；
     * 全部完成后置 false，之后启动不再出现（除非配置新增步骤）。
     */
    flowPending: false,
    /**
     * 本次启动里是否展示过引导（一旦为 true 就保持到进程退出）。
     *
     * 与 `flowPending` 的区别：`flowPending` 是「还没问完」，收尾后立刻变 false；
     * 这个标记是「这次启动已经问过了」，用来抑制 iframe 内的 settings.onboarding。
     * 用户在我们的第三步选了不登录，也不该在同一个启动里被再问一遍。
     * 下次启动不再展示引导时，这个标记保持 false，核心自己的就绪判定照常生效
     * （例如用户之后删光模型适配器，核心仍会重新要求配置）。
     */
    showedOnboarding: false,
  }),
  actions: {
    /** 拉取预装插件列表（含已安装检测），供首次启动引导界面渲染 */    async load(): Promise<PreinstallPlugin[]> {
      if (this.loading)
        return this.plugins
      this.loading = true
      try {
        this.plugins = await invoke<PreinstallPlugin[]>('get_preinstall_plugins')
        // 成功加载后清除历史加载错误，避免残留错误态遮蔽新列表
        this.loadError = ''
      }
      catch (err) {
        console.error('[Harness] failed to load preinstall plugins:', err)
        // 记录错误而非伪装空列表：UI 据此展示错误态与重试按钮
        this.loadError = String(err)
      }
      finally {
        this.loading = false
      }
      return this.plugins
    },

    /** 追加一行 `dsh plugin` 进程输出（日志上限见 [`LOG_LIMIT`]） */
    pushLog(line: string) {
      this.logs = [...this.logs, line].slice(-LOG_LIMIT)
    },

    /** 拉取清单声明的可选内核及其托管状态（只读，不安装） */
    async loadKernels(): Promise<PreinstallKernel[]> {
      try {
        this.kernels = await invoke<PreinstallKernel[]>('get_native_kernels')
      }
      catch (err) {
        console.error('[Harness] failed to load native kernels:', err)
        this.kernels = []
      }
      return this.kernels
    },

    /**
     * 安装一个可选内核（长任务，进度流式回流到同一个日志面板）。
     *
     * 内核是可选步骤：失败只停留在本步，不影响插件安装结果，用户可重试或继续。
     */
    async installKernel(id: string): Promise<boolean> {
      if (this.kernelPhases[id] !== undefined)
        return false
      // 每个内核各自一个阶段槽：并装多个时互不覆盖。
      this.kernelPhases = { ...this.kernelPhases, [id]: 'resolving' }
      this.error = ''
      this.logs = []
      let unlisten: UnlistenFn | null = null
      try {
        unlisten = await this.listenLog()
        await invoke('install_native_kernel_by_id', { id })
        await this.loadKernels()
        return true
      }
      catch (err) {
        console.error('[Harness] native kernel install failed:', err)
        this.error = String(err)
        return false
      }
      finally {
        unlisten?.()
        const next = { ...this.kernelPhases }
        delete next[id]
        this.kernelPhases = next
      }
    },

    /** 当前步骤（配置里第一个未完成的）；没有步骤时为 null。 */
    currentStep(): OnboardingStep | null {
      const view = this.onboarding
      if (view === null)
        return null
      const id = view.current
      return id === null ? null : view.steps.find(step => step.id === id) ?? null
    },

    /**
     * 回退：清掉上一步的完成标记，让引导回到它。
     *
     * 步骤顺序来自配置，不预设名称；已完成的 id 从视图里读，不另存一份。
     */
    async backStep(): Promise<void> {
      const view = this.onboarding
      if (view === null)
        return
      const index = view.steps.findIndex(step => step.id === view.current)
      if (index <= 0)
        return
      const previous = view.steps[index - 1]
      const remaining = view.steps
        .filter(step => step.completed && step.id !== previous.id)
        .map(step => step.id)
      try {
        this.onboarding = await invoke<OnboardingView>('reset_onboarding_steps', { ids: remaining })
      }
      catch (err) {
        console.error('[Harness] failed to step back:', err)
      }
    },

    /** 重新读一次配置与进度（完成后推进用）。 */
    async refreshOnboarding(): Promise<OnboardingView | null> {
      return this.loadOnboarding()
    },

    /**
     * 由视图派生「还要不要压引导层」。
     *
     * 必须与 `onboarding` 同步更新：只在加载时算一次的话，完成最后一步后视图已
     * finished、flowPending 却仍是 true，壳层会渲染一个所有步骤内容都不再存在的
     * 空引导页（无按钮、只有标题）。
     */
    syncFlow(view: OnboardingView | null): void {
      this.flowPending = view !== null && view.steps.length > 0 && !view.finished
      if (this.flowPending)
        this.showedOnboarding = true
    },

    /** 拉取引导配置与进度。 */
    async loadOnboarding(): Promise<OnboardingView | null> {
      try {
        this.onboarding = await invoke<OnboardingView>('get_onboarding')
        // 有声明步骤且尚未完成 → 引导层要压住界面；没有任何步骤 → 不打扰用户。
        this.syncFlow(this.onboarding)
      }
      catch (err) {
        console.error('[Harness] failed to load onboarding:', err)
        this.onboarding = null
        this.syncFlow(null)
      }
      return this.onboarding
    },

    /**
     * 标记当前步骤完成并推进。
     *
     * 后端按清单校验 id，未知 id 会被拒绝；完成全部步骤后引导自然结束。
     */
    async completeStep(id: string): Promise<void> {
      try {
        this.onboarding = await invoke<OnboardingView>('complete_onboarding_step', { id })
        this.syncFlow(this.onboarding)
      }
      catch (err) {
        console.error('[Harness] failed to complete onboarding step:', err)
        this.error = String(err)
      }
    },

    /**
     * 完成当前步骤并推进：全部步骤完成时才收尾（拉起服务），否则停在下一步。
     *
     * 每个步骤的「继续」都走这里——早先内核步骤直接调 finish()，于是它之后的
     * 步骤永远不会渲染，进度却被一次性标成全部完成。
     */
    async advance(): Promise<void> {
      const step = this.currentStep()
      console.debug('[onboarding] advance', { step: step?.id ?? null, current: this.onboarding?.current ?? null, finished: this.onboarding?.finished })
      if (step === null) {
        await this.finish()
        return
      }
      await this.completeStep(step.id)
      console.debug('[onboarding] after complete', { current: this.onboarding?.current ?? null, finished: this.onboarding?.finished, flowPending: this.flowPending })
      if (this.onboarding === null || this.onboarding.current === null)
        await this.finish()
    },

    /** 预装安装日志流：dsh plugin 进程输出逐行追加 */
    async listenLog(): Promise<UnlistenFn> {
      return listen<PreinstallLogPayload>('preinstall-log', (e) => {
        this.pushLog(e.payload.line)
        // 带 target 且带过程阶段的行，同时更新那张卡片的进度层。
        // 日志层与进度层是两个消费方，同一事件喂两边：日志永远完整，
        // 卡片内只显示状态词。
        const { target, phase } = e.payload
        if (target !== undefined && phase !== undefined && this.kernelPhases[target] !== undefined)
          this.kernelPhases = { ...this.kernelPhases, [target]: phase as KernelPhase }
      })
    },

    /**
     * 确认安装/卸载预装插件：流式日志，完成后继续启动服务。
     *
     * 前端传入 diff 结果（installIds = 新增勾选需安装；uninstallIds = 取消勾选需卸载），
     * 无变化时两者均为空，后端直接标记完成。
     */
    async confirm(input: PreinstallSelection | string[]) {
      // 兼容旧调用方（直接传数组）与新调用方（传 {installIds, uninstallIds}）
      const installIds = Array.isArray(input) ? input : (input.installIds ?? [])
      const uninstallIds = Array.isArray(input) ? [] : (input.uninstallIds ?? [])
      if (this.installing || (installIds.length === 0 && uninstallIds.length === 0))
        return
      this.installing = true
      this.error = ''
      this.incompatible = []
      this.logs = []
      let unlisten: UnlistenFn | null = null
      try {
        unlisten = await this.listenLog()
        await invoke('install_preinstall_plugins', { installIds, uninstallIds })
        // 后端装完已把服务停掉，这里在日志面板讲清接下来的重启（issue #48），
        // 避免用户把"插件安装后的自动重启"误认为崩溃/故障。
        this.logs = [...this.logs, i18next.t('preinstall.restarting_hint')].slice(-LOG_LIMIT)
        await this.continueStartup()
      }
      catch (err) {
        console.error('[Harness] preinstall failed:', err)
        const error = String(err)
        const refusal = parseBlockedRefusal(error)
        if (refusal?.kind === 'incompatible') {
          // 不是故障而是待授权清单：交给界面展示风险与勾选，用户授权后重跑安装
          this.incompatible = refusal.versions
        }
        else if (refusal?.kind === 'policy') {
          // 同上，但拦下它的是 pnpm 的发布时长策略：清单同样交给界面勾选授权
          this.policyBlocked = refusal.versions
        }
        else {
          this.error = error.startsWith('NETWORK_ERROR:')
            ? i18next.t('preinstall.network_error')
            : error
        }
      }
      finally {
        unlisten?.()
        this.installing = false
        this.cancelling = false
      }
    },

    /**
     * 授予被核心拒绝的插件精确版本豁免，成功后由界面重跑安装。
     *
     * 只提交用户在风险提示中勾选的条目；授权失败按普通安装失败展示（错误态 + 重试），
     * 届时重试会再次触发拒绝、重新给出勾选清单。
     */
    async allowIncompatible(versions: IncompatibleVersion[]): Promise<boolean> {
      if (this.installing || versions.length === 0)
        return false
      try {
        await invoke('allow_plugin_versions', { versions })
        this.incompatible = []
        return true
      }
      catch (err) {
        console.error('[Harness] granting plugin version exemption failed:', err)
        this.incompatible = []
        this.error = String(err)
        return false
      }
    },

    /**
     * 授予被 pnpm 发布时长策略拦下的精确版本豁免，成功后由界面重跑安装。
     *
     * 与 [`allowIncompatible`] 是两套互不相干的授权（一个写档案的 `compatibility.json`、
     * 一个写 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`），但形状一致：只提交
     * 用户勾选的精确 `包名@版本`，失败按普通安装失败展示并回到可重试态。
     */
    async allowPolicyVersions(versions: PolicyBlockedVersion[], expectedProfile?: string): Promise<boolean> {
      if (this.installing || versions.length === 0)
        return false
      try {
        await invoke('allow_plugin_policy_versions', { versions, ...(expectedProfile === undefined ? {} : { expectedProfile }) })
        this.policyBlocked = []
        return true
      }
      catch (err) {
        console.error('[Harness] granting release-age exemption failed:', err)
        this.policyBlocked = []
        this.error = String(err)
        return false
      }
    },

    /**
     * 取消正在进行的预装插件安装：网络抖动/拉包限流（429）时可能长时间卡在
     * pnpm 重试；调用后端强杀插件安装进程树，回到可重试的选择态。
     */
    async cancel() {
      if (!this.installing || this.cancelling)
        return
      // 后端结束进程树导致 `install_preinstall_plugins` 提前返回并进入 catch，
      // 通过 installing=false 让其回到列表态而不是报错态。
      this.cancelling = true
      // 一次性监听：先挂事件（拿到注销函数再 invoke），finally 里注销，
      // 避免每次取消都永久注册一个 `preinstall-cancelled` 监听（泄漏）。
      let unlisten: (() => void) | undefined
      try {
        unlisten = await listen<unknown>('preinstall-cancelled', () => {
          this.installing = false
          this.cancelling = false
        })
        await invoke('cancel_plugin_processes')
      }
      catch (err) {
        console.error('[Harness] cancel preinstall failed:', err)
        this.cancelling = false
      }
      finally {
        unlisten?.()
      }
    },

    /**
     * 跳过**当前这一步**（不是跳过整个引导）。
     *
     * 每个可选步骤都有自己的 Skip：点它只意味着「这一步不配了」，后续步骤照常。
     * 全部步骤都完成（含被跳过的）时，`advance` 才会收尾并拉起服务。
     */
    async skip(): Promise<void> {
      if (this.installing)
        return
      await this.advance()
    },

    /**
     * 引导收尾：拉起服务并等待就绪。
     *
     * 进度已在每个步骤完成/跳过时写入；这里不再改写它——把「收尾」和「标记完成」
     * 分开，是因为收尾可能在最后一步之后发生，也可能是外部（如启动流程）触发。
     */
    async finish() {
      // 先撤掉引导层与 preinstall 状态，再等服务就绪。
      //
      // 顺序很重要：`continueStartup` 要等到服务健康（数秒到数十秒），这期间如果
      // 壳层还停在 `status: 'preinstall'`，用户看到的是一个所有步骤内容都已消失的
      // 空壳——既没有按钮，也无从重试。进度已经写完，界面本来就该切到启动页。
      this.flowPending = false
      harness.status = 'starting'
      try {
        await this.continueStartup()
      }
      catch (err) {
        // 收尾失败必须可见：此时进度已写入，但界面还停在引导页，用户会以为卡死。
        console.error('[Harness] finish preinstall failed:', err)
        this.error = String(err)
        this.pushLog(`[harness] 引导收尾失败：${String(err)}`)
        // 进度已经是「全部完成」，界面不应继续停在引导页：即使拉起服务失败，
        // 也把壳层拉出 preinstall，让错误走启动页的重试入口，而不是一个无按钮的空壳。
        throw err
      }
    },

    /** 预装引导结束后的收尾：拉起服务等待就绪，并静默检查更新 */
    async continueStartup() {
      await harness.launchAndWait()
      void harnessUpdater.checkForUpdate()
    },

    /**
     * 从侧边栏重新打开预装插件引导：可重新选择/安装推荐插件。
     * 关闭引导（确定/跳过）后回到正常启动流程，服务若在运行则保持原状态。
     */
    async open() {
      if (this.installing)
        return
      void hooks['config.dialog.hidden'].trigger()
      this.error = ''
      // 重新打开引导时清掉上次留下的拦截清单，否则会直接落在授权对话框上
      this.incompatible = []
      this.policyBlocked = []
      this.logs = []
      // 侧边栏手动打开：非首次安装，默认勾选策略为「仅已安装」
      this.isFirstTime = false
      harness.status = 'preinstall'
      await this.load()
    },
  },
})
