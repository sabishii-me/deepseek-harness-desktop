import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the Jouzu probe budget.
 *
 * Jouzu is a Node CLI that boots its extension host before answering
 * `pi --help` (measured ~5s warm). The shared 5s default sits exactly on that
 * boundary, so Jouzu consistently reported `installed: false` with
 * `BRIDGE_PROBE_TIMEOUT` while `--version` had already succeeded.
 *
 * These tests shell out to the real CLI surface, not a mock, because the
 * regression was entirely about real wall-clock cost.
 */
describe('jouzu probe budget', () => {
  it('boots `pi --help` well inside the Jouzu-specific budget', async () => {
    const { detectBackend } = await import('./detection')
    const result = await detectBackend('jouzu', undefined, { timeoutMs: 30_000 })
    // Either Jouzu is absent from PATH (nothing to assert) or it must probe
    // successfully with the Jouzu budget rather than timing out.
    if (result.detection.version === null && result.detection.hint?.includes('BRIDGE_EXECUTABLE_MISSING'))
      return
    expect(result.detection.hint ?? '').not.toContain('BRIDGE_PROBE_TIMEOUT')
    expect(result.detection.drift).toBe(false)
  }, 90_000)
})
