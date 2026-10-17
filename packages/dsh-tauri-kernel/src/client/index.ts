import type { ClientContext } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { locale } from './locales'
import { kernel } from './register/kernel'

export const name = PLUGIN_ID
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(locale.registerLocale, `${PLUGIN_ID}: locale`)
  // Onboarding is a shell-owned full-screen phase (plugins → kernel), not a
  // client popup: installing a kernel is a long task that belongs to the shell,
  // which owns the runtime and the progress channel. This plugin therefore only
  // contributes the kernel picker, never a first-run dialog.
  ctx.effect(kernel, `${PLUGIN_ID}: kernel`)
}
