// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupJouzu } from './setup-jouzu'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
afterEach(() => { cleanup(); invoke.mockReset() })

describe('optional Jouzu onboarding', () => {
  it('does not install without an explicit click and shows failed installation', async () => {
    invoke.mockResolvedValueOnce({ installed: false, managed: false, version: '0.2.0' })
    invoke.mockRejectedValueOnce('Network unavailable')
    render(<SetupJouzu />)
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('get_jouzu_installation')
    fireEvent.click(screen.getByRole('button', { name: /Install Jouzu/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable')
    expect(invoke).toHaveBeenLastCalledWith('install_optional_jouzu')
  })

  it('does not offer reinstall or uninstall for an installed managed runtime', async () => {
    invoke.mockResolvedValue({ installed: true, managed: true, version: '0.2.0' })
    render(<SetupJouzu />)
    const button = await screen.findByRole('button', { name: 'Managed 0.2.0 installed' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
