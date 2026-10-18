import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import { ClaudeIcon, FishLogo, GptIcon, JouzuIcon } from 'dsh-tauri-ui/client'
import { If } from 'dsh-tauri/client'

export function KernelIcon({ backend }: { backend: BackendId | undefined }): ReactElement {
  return (
    <>
      <If cond={backend === 'codex'} then={<GptIcon />} />
      <If cond={backend === 'claude'} then={<ClaudeIcon />} />
      <If cond={backend === 'jouzu'} then={<JouzuIcon />} />
      <If cond={backend === 'dsh'} then={<FishLogo size={16} />} />
    </>
  )
}

/**
 * 进行中指示：一段描边圆弧绕自身旋转。
 *
 * 内核仓库不引第三方 spinner 依赖（`dsh-tauri-ui` 与 `@gravity-ui/icons` 都没有），
 * 官方界面同样是自绘圆弧 + CSS 旋转。`motion-reduce:animate-none` 尊重
 * `prefers-reduced-motion`：此时保持静止图形，仍然表达「有事情在进行」。
 */
export function KernelSpinner(): ReactElement {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden
      focusable="false"
      className="animate-spin motion-reduce:animate-none"
    >
      <path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />
    </svg>
  )
}
