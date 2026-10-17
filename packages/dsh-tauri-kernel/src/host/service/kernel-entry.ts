/**
 * 托管内核入口解析（通用）。
 *
 * 壳层只负责把「托管内核根在哪」通过环境变量 `DSH_NATIVE_KERNEL_ROOT` 交给本进程；
 * 具体某个内核装成什么包、入口在包内的哪个相对路径，由本模块的数据表（与
 * `PACKAGE_NAMES` 同源）声明。壳层因此不需要认识任何具体内核。
 */
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import type { NativeBackend } from '../../shared/types'
import { NATIVE_BACKENDS } from '../../shared/types'
import { PACKAGE_NAMES, PACKAGE_ENTRIES } from '../utils/detection'

/**
 * 托管内核根：壳层在启动子进程时注入的绝对路径，缺失或非绝对路径时返回 undefined
 * （此时不解析任何托管入口，交由显式配置 / PATH 探测决定）。
 */
export function managedKernelRoot(): string | undefined {
  const root = process.env.DSH_NATIVE_KERNEL_ROOT
  return root && isAbsolute(root) ? root : undefined
}

/** 某内核的托管包目录：`<托管根>/<包名派生目录>/node_modules/<包名>`。 */
function managedPackageDir(backend: NativeBackend, root: string): string {
  const dir = PACKAGE_NAMES[backend].replace(/[/\\@]/g, '-').replace(/^-+|-+$/g, '')
  return join(root, dir, 'node_modules', PACKAGE_NAMES[backend])
}

/**
 * 某内核的托管入口绝对路径；未声明托管入口或托管根不可用时返回 undefined。
 *
 * 只做路径解析，不触碰文件系统：是否可用交给既有的探测（`detectBackend`）判断。
 */
export function managedKernelEntry(backend: NativeBackend): string | undefined {
  const root = managedKernelRoot()
  const entry = PACKAGE_ENTRIES[backend]
  if (root === undefined || entry === undefined)
    return undefined
  return join(managedPackageDir(backend, root), entry)
}

/** 所有声明了托管入口的内核（供探测逐个回退）。 */
export function managedKernelBackends(): NativeBackend[] {
  return NATIVE_BACKENDS.filter(backend => PACKAGE_ENTRIES[backend] !== undefined)
}
