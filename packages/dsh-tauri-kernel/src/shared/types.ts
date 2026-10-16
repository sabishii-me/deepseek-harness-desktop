import type { NativeTurnOptions } from './native-model'

export type BackendId = 'dsh' | 'codex' | 'claude' | 'jouzu'

/**
 * Native kernels a DSH session can bind to, in picker order.
 *
 * Every place that validates or enumerates a selectable kernel derives from
 * this list, so adding a kernel does not require hunting down stray literal
 * unions.
 */
export const NATIVE_BACKENDS = ['codex', 'claude', 'jouzu'] as const satisfies readonly Exclude<BackendId, 'dsh'>[]

/** A selectable native kernel (every backend that is not the official one). */
export type NativeBackend = (typeof NATIVE_BACKENDS)[number]

/** Display names for the kernel picker and session chrome. */
export const KERNEL_LABELS: Record<NativeBackend, string> = {
  codex: 'Codex',
  claude: 'Claude',
  jouzu: 'Jouzu',
}

/** Narrow an arbitrary value to a selectable native kernel. */
export function isNativeBackend(value: unknown): value is NativeBackend {
  return typeof value === 'string' && (NATIVE_BACKENDS as readonly string[]).includes(value)
}

export interface BackendDetection {
  id: BackendId
  installed: boolean
  bridgeReady?: boolean
  auth: 'ok' | 'missing' | 'unknown'
  version: string | null
  drift: boolean
  hint: string | null
}

export interface KernelBinding {
  backend: Exclude<BackendId, 'dsh'>
  nativeSessionId: string
  sessionId: string
}

export interface KernelProjectionState {
  readonly ownerSessionId: string
  readonly inheritedEventCount: number
  readonly inheritedBinding: KernelBinding | null
  readonly binding: KernelBinding | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    bridgeModel: NativeTurnOptions
    bridgeKernel: KernelBinding | null
  }

  interface SessionProjectionStateMap {
    bridgeModel: NativeTurnOptions
    bridgeKernel: KernelProjectionState
  }
}
