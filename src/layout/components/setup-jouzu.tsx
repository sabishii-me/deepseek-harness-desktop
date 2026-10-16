import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Installation { installed: boolean, managed: boolean, version: string, externalDetected?: boolean }

/** Explicit optional action, independent of plugin checkbox/uninstall diffs. */
export function SetupJouzu() {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [state, setState] = useState<Installation>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void invoke<Installation>('get_jouzu_installation').then(value => { if (active) setState(value) }).catch(() => {})
    return () => { active = false }
  }, [])
  async function install() {
    setBusy(true)
    setError('')
    try { setState(await invoke<Installation>('install_optional_jouzu')) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return (
    <section className="rounded-xl border border-default p-4 text-sm" aria-label={zh ? '可选内核' : 'Optional kernel'}>
      <strong>{zh ? '可选内核：Jouzu' : 'Optional kernel: Jouzu'}</strong>
      <p>{zh ? '独立的 agent loop 与工具，可使用 Shisa 或自己的模型配置。不安装也可完整使用 DSH。' : 'An independent agent loop and tools, with Shisa or your own model setup. DSH does not require Jouzu.'}</p>
      <p>{zh ? '可执行本机命令及修改文件；不受 DSH Workspace Write 沙箱保护。' : 'Can run local commands and modify files; DSH Workspace Write does not sandbox Jouzu.'}</p>
      <p>{zh ? '已有 PATH 安装会优先使用，不会被此操作升级或卸载。安装到桌面专用目录，不修改全局 npm。' : 'Existing PATH installations take priority and are not upgraded or removed here. Installation uses an app-owned directory, not global npm.'}</p>
      {state?.externalDetected && <p>{zh ? '检测到 PATH 上已有 Jouzu，可直接跳过安装并继续；内核会验证其版本与 RPC 能力。' : 'Jouzu was found on PATH. Skip installation and continue; the kernel checks its version and RPC capability.'}</p>}
      <button type="button" className="mt-2 rounded border px-3 py-2 disabled:opacity-50" disabled={busy || state?.installed} onClick={() => { void install() }}>
        {busy ? (zh ? '正在安装（可能需要数分钟）…' : 'Installing (may take several minutes)…') : state?.installed ? (zh ? `桌面管理版本 ${state.version} 已安装` : `Managed ${state.version} installed`) : (zh ? '安装 Jouzu 0.2.0（可跳过）' : 'Install Jouzu 0.2.0 (optional)')}
      </button>
      {state?.installed && <p>{zh ? '继续完成引导或重启内核后生效；不会自动切换当前会话。' : 'Available after completing setup or restarting the kernel; your current session is not switched.'}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </section>
  )
}
