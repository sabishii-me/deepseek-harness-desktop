import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ONBOARDING_ALLOW_MESSAGE, registerOnboardingAllow } from './onboarding-allow'

const mocks = vi.hoisted(() => ({
  setAllowOnboarding: vi.fn(),
  listenParent: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (feature: (...args: never[]) => void) => feature,
  listenParent: mocks.listenParent,
}))

vi.mock('../store/modules/sections', () => ({
  sections: { setAllowOnboarding: mocks.setAllowOnboarding },
}))

describe('registerOnboardingAllow', () => {
  beforeEach(() => {
    mocks.setAllowOnboarding.mockClear()
    mocks.listenParent.mockReset()
  })

  it('turns in-frame onboarding off while the shell flow owns the screen', () => {
    mocks.listenParent.mockImplementation((fn: (message: unknown) => void) => {
      fn({ type: ONBOARDING_ALLOW_MESSAGE, allow: false })
      return () => {}
    })
    ;(registerOnboardingAllow as (controller: unknown) => void)({ add: vi.fn() })
    expect(mocks.setAllowOnboarding).toHaveBeenCalledWith(false)
  })

  it('hands control back once the shell flow ends', () => {
    mocks.listenParent.mockImplementation((fn: (message: unknown) => void) => {
      fn({ type: ONBOARDING_ALLOW_MESSAGE, allow: true })
      return () => {}
    })
    ;(registerOnboardingAllow as (controller: unknown) => void)({ add: vi.fn() })
    expect(mocks.setAllowOnboarding).toHaveBeenCalledWith(true)
  })

  it('ignores messages without a boolean, keeping the core default', () => {
    mocks.listenParent.mockImplementation((fn: (message: unknown) => void) => {
      fn({ type: ONBOARDING_ALLOW_MESSAGE })
      fn({ type: ONBOARDING_ALLOW_MESSAGE, allow: 'yes' })
      return () => {}
    })
    ;(registerOnboardingAllow as (controller: unknown) => void)({ add: vi.fn() })
    expect(mocks.setAllowOnboarding).not.toHaveBeenCalled()
  })
})
