import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, listenParent } from 'dsh-tauri/client'
import { sections } from '../store/modules/sections'

export const ONBOARDING_ALLOW_MESSAGE = 'dsh://onboarding:allow'

/**
 * 壳层引导是否仍在进行。
 *
 * 壳层在帧加载完成时、以及引导状态变化时各推一次 `{ type, allow }`：
 * `allow=false` 表示壳层正用一套全屏流程占着界面，帧内的 onboarding 步骤
 * 应让位；`allow=true` 表示交还控制权，之后按核心自身的就绪判定决定是否展示
 * （例如用户把所有模型适配器都删掉时，核心会重新要求引导）。
 *
 * 默认 `true`：没有壳层消息时（浏览器直开、更老的核心）保持核心原有行为。
 */
export const registerOnboardingAllow = defineRegister<ClientContext>((controller) => {
  controller.add(listenParent((message) => {
    if (typeof message.allow === 'boolean')
      sections.setAllowOnboarding(message.allow)
  }, ONBOARDING_ALLOW_MESSAGE))
})
