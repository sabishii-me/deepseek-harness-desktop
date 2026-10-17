// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { SessionListStateLike } from './settings-trigger'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SETTINGS_ONBOARDING_SLOT } from '../constants'
import { SettingsTrigger } from './settings-trigger'

vi.mock('dsh-tauri/client', () => ({
  cn: () => '',
  uniq: <T,>(values: T[]) => [...new Set(values)],
  useStore: (value: unknown) => value,
}))
vi.mock('../locales', () => ({ locale: { text: (key: string) => key, useLocale: () => 'en' } }))
const sectionsMock = vi.hoisted(() => ({
  onboarding: [{ id: 'first' }, { id: 'second' }] as { id: string }[],
  allowOnboarding: true,
}))
vi.mock('../store', () => ({
  store: {
    settings: { open: false, launcherAvailable: false, openAt: vi.fn() },
    sections: sectionsMock,
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Menu: ({ anchor }: { anchor: ReactNode }) => anchor }))
vi.mock('@deepseek-ai/dsh-client-ui-renderer', () => ({
  SlotOutlet: ({ slotKey, ownerProps }: { slotKey: string, ownerProps: { stepId: string, complete: () => void } }) =>
    slotKey === SETTINGS_ONBOARDING_SLOT ? <button type="button" onClick={ownerProps.complete}>{ownerProps.stepId}</button> : null,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('resets completed onboarding steps when the session list leaves and reenters its ready phase', () => {
  let state: SessionListStateLike = { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }
  function selectSessions<S>(selector: (state: SessionListStateLike) => S): S {
    return selector(state)
  }
  const view = render(<SettingsTrigger wide useSessions={selectSessions} />)
  fireEvent.click(view.getByRole('button', { name: 'first' }))
  expect(view.getByRole('button', { name: 'second' })).toBeTruthy()
  state = { ...state, phase: 'pending' }
  view.rerender(<SettingsTrigger wide useSessions={selectSessions} />)
  expect(view.queryByRole('button', { name: 'second' })).toBeNull()
  state = { ...state, phase: 'ready' }
  view.rerender(<SettingsTrigger wide useSessions={selectSessions} />)
  expect(view.getByRole('button', { name: 'first' })).toBeTruthy()
})

it('holds its onboarding steps while the shell flow owns the screen', () => {
  // 首次启动时壳层用全屏流程占着界面，这里不能再弹一份；交还控制权后恢复。
  let state: SessionListStateLike = { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }
  function selectSessions<S>(selector: (state: SessionListStateLike) => S): S {
    return selector(state)
  }
  sectionsMock.allowOnboarding = false
  const view = render(<SettingsTrigger wide useSessions={selectSessions} />)
  expect(view.queryByRole('button', { name: 'first' })).toBeNull()
  sectionsMock.allowOnboarding = true
  view.rerender(<SettingsTrigger wide useSessions={selectSessions} />)
  expect(view.getByRole('button', { name: 'first' })).toBeTruthy()
  // 后续用例沿用默认值
  sectionsMock.allowOnboarding = true
})
