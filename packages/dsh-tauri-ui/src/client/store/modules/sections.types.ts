import type { SettingsRow } from '../../types/sections'

export interface SettingsSectionsState {
  rows: SettingsRow[]
  onboarding: SettingsRow[]
  /**
   * 是否允许展示 onboarding 步骤。
   *
   * 首次启动时壳层的全屏引导会覆盖整个界面，此时这里的步骤不该再抢一次注意力；
   * 壳层引导结束后置为 true，之后（例如用户删光所有模型适配器）由核心自身的
   * 就绪判定决定是否弹出——本开关不再干预。
   */
  allowOnboarding: boolean
}
