import type { NativeSession } from './types'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJouzuSession } from './jouzu'
import { createSink, ProcessFixture } from './process.fixture'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/node.exe', args: ['C:/fixture/jouzu/dist/cli.js'], env: { PATH: 'C:/fixture/bin' } }
const sessions: NativeSession[] = []

/**
 * A minimal Jouzu RPC peer.
 *
 * Answers the two control commands the bridge issues while opening
 * (`switch_session`, `get_state`) and exposes `emit` so a test can drive the
 * real event stream Jouzu 0.2.0 produces.
 */
function jouzuProcess(options: { sessionId?: string, switchTo?: string } = {}) {
  const sessionId = options.sessionId ?? 'jouzu-session-a'
  const fixture = new ProcessFixture((frame) => {
    if (frame.type === 'get_state') {
      fixture.send({ id: frame.id, type: 'response', command: 'get_state', success: true, data: { sessionId } })
      return
    }
    if (frame.type === 'switch_session') {
      fixture.send({ id: frame.id, type: 'response', command: 'switch_session', success: true, data: { sessionId: options.switchTo ?? sessionId } })
      return
    }
    if (frame.type === 'get_available_models') {
      fixture.send({ id: frame.id, type: 'response', command: 'get_available_models', success: true, data: { models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] } })
      return
    }
    if (frame.type === 'set_model' || frame.type === 'set_thinking_level' || frame.type === 'abort') {
      fixture.send({ id: frame.id, type: 'response', command: frame.type, success: true })
      return
    }
    if (frame.type === 'prompt') {
      fixture.send({ id: frame.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    }
  })
  return { fixture, sessionId }
}

function userMessage(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function open(fixture: ProcessFixture) {
  vi.mocked(spawn).mockReturnValue(fixture.child)
  return createJouzuSession(command, 'C:/fixture', null, createSink(), new AbortController().signal)
}

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()))
})

describe('jouzu native kernel', () => {
  it('launches the CLI in RPC mode and adopts the identity Jouzu reports', async () => {
    const { fixture, sessionId } = jouzuProcess()
    const session = await open(fixture)
    sessions.push(session)
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(['C:/fixture/jouzu/dist/cli.js', '--mode', 'rpc'])
    expect(session.id).toBe(sessionId)
  })

  it('forwards assistant text and reasoning deltas onto the official sink', async () => {
    const { fixture } = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('hi')], new AbortController().signal)
    await prompted
    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'planning' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'hello' } })
    fixture.send({ type: 'agent_settled' })
    await turn

    expect(sink.thinking).toHaveBeenCalledWith('jouzu:0:0', 'planning')
    expect(sink.text).toHaveBeenCalledWith('jouzu:0:1', 'hello')
  })

  it('reports tool execution start and end with the tool output', async () => {
    const { fixture } = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('list files')], new AbortController().signal)
    await prompted
    const args = { path: 'C:/fixture' }
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'ls' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-1', name: 'ls', arguments: args } } })
    fixture.send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'ls', args })
    fixture.send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'ls', result: { content: [{ type: 'text', text: 'a.txt\n' }] }, isError: false })
    fixture.send({ type: 'agent_settled' })
    await turn

    expect(sink.toolStart).toHaveBeenCalledWith('call-1', 'ls', JSON.stringify(args))
    expect(sink.toolEnd).toHaveBeenCalledWith('call-1', 'a.txt\n', false)
  })

  it('acknowledges Jouzu widget requests without surfacing them as content', async () => {
    const { fixture } = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const acknowledgement = fixture.next(frame => frame.type === 'extension_ui_response')
    fixture.send({ type: 'extension_ui_request', id: 'widget-1', method: 'setWidget', widgetKey: 'multiloop' })
    expect(await acknowledgement).toMatchObject({ id: 'widget-1', cancelled: true })
    expect(sink.text).not.toHaveBeenCalled()
    expect(sink.toolStart).not.toHaveBeenCalled()
  })

  it('survives Jouzu extension faults instead of failing the official session', async () => {
    const { fixture } = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('hi')], new AbortController().signal)
    await prompted
    fixture.send({ type: 'extension_error', extensionPath: 'node_modules/@lhl/pi-tasks', event: 'turn_start', error: 'This extension ctx is stale' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ok' } })
    fixture.send({ type: 'agent_settled' })
    await turn

    expect(sink.text).toHaveBeenCalledWith('jouzu:0:0', 'ok')
  })

  it('rejects a resume that lands on a different Jouzu session', async () => {
    const { fixture } = jouzuProcess({ switchTo: 'some-other-session' })
    vi.mocked(spawn).mockReturnValue(fixture.child)
    await expect(createJouzuSession(command, 'C:/fixture', 'expected-session', createSink(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
  })

  it('enumerates models through the Jouzu model command', async () => {
    const { fixture } = jouzuProcess()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, createSink(), new AbortController().signal)
    sessions.push(session)
    const catalog = await session.models!(new AbortController().signal)
    expect(catalog.models).toEqual([{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }])
  })
})

/**
 * Resume goes through the CLI (`jouzu --session <id> --mode rpc`), not an RPC
 * command. An earlier attempt issued `switch_session`, whose parameter is
 * `sessionPath` rather than `sessionId`; passing the id made Jouzu dereference
 * undefined internally and reject every turn with a bare TypeError.
 */
describe('jouzu resume', () => {
  it('resumes through the CLI session flag', async () => {
    const { fixture, sessionId } = jouzuProcess()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', sessionId, createSink(), new AbortController().signal)
    sessions.push(session)
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(['C:/fixture/jouzu/dist/cli.js', '--session', sessionId, '--mode', 'rpc'])
    expect(session.id).toBe(sessionId)
  })

  it('reports a mismatch when Jouzu attaches to another session', async () => {
    const { fixture } = jouzuProcess()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    await expect(createJouzuSession(command, 'C:/fixture', 'a-different-session', createSink(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'BRIDGE_RESUME_MISMATCH' })
  })

  it('never issues an RPC switch_session command', async () => {
    const { fixture, sessionId } = jouzuProcess()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', sessionId, createSink(), new AbortController().signal)
    sessions.push(session)
    expect(fixture.frames.some(frame => frame.type === 'switch_session')).toBe(false)
  })
})


describe('jouzu rejected prompt', () => {
  it('rejects submit when RPC preflight rejects, without waiting for agent_settled', async () => {
    const fixture = new ProcessFixture((frame) => {
      if (frame.type === 'get_state')
        fixture.send({ id: frame.id, type: 'response', success: true, data: { sessionId: 'rejected-prompt' } })
      if (frame.type === 'prompt')
        fixture.send({ id: frame.id, type: 'response', success: false, error: 'Model unavailable' })
    })
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, createSink(), new AbortController().signal)
    sessions.push(session)
    await expect(session.submit([userMessage('hello')], new AbortController().signal))
      .rejects.toMatchObject({ code: 'BRIDGE_NATIVE_REQUEST', message: 'Model unavailable' })
  })
})

describe('jouzu cancellation', () => {
  it('closes an unresponsive child instead of waiting forever after abort', async () => {
    vi.useFakeTimers()
    const fixture = new ProcessFixture((frame) => {
      if (frame.type === 'get_state')
        fixture.send({ id: frame.id, type: 'response', success: true, data: { sessionId: 'abort-test' } })
      if (frame.type === 'prompt' || frame.type === 'abort')
        fixture.send({ id: frame.id, type: 'response', success: true })
    })
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, createSink(), new AbortController().signal)
    const controller = new AbortController()
    try {
      const turn = session.submit([userMessage('work')], controller.signal)
      const rejected = expect(turn).rejects.toThrow('test cancellation')
      await vi.advanceTimersByTimeAsync(0)
      controller.abort(new Error('test cancellation'))
      await vi.advanceTimersByTimeAsync(6_000)
      await rejected
      expect(fixture.frames.some(frame => frame.type === 'abort')).toBe(true)
      expect(fixture.kill).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
      await session.dispose()
    }
  })
})

describe('jouzu model picker', () => {
  it('lists provider-qualified models and restores the actual default after switching', async () => {
    const available = [
      { provider: 'native', id: 'same-id', name: 'Native model' },
      { provider: 'shisa', id: 'same-id', name: 'Shisa model' },
    ]
    const fixture = new ProcessFixture((frame) => {
      if (frame.type === 'get_state')
        fixture.send({ id: frame.id, type: 'response', success: true, data: { sessionId: 'picker', model: available[0] } })
      if (frame.type === 'get_available_models')
        fixture.send({ id: frame.id, type: 'response', success: true, data: { models: available } })
      if (frame.type === 'set_model' || frame.type === 'prompt') {
        fixture.send({ id: frame.id, type: 'response', success: true })
        if (frame.type === 'prompt')
          fixture.send({ type: 'agent_settled' })
      }
    })
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const signal = new AbortController().signal
    const session = await createJouzuSession(command, 'C:/fixture', null, createSink(), signal)
    sessions.push(session)
    const catalog = await session.models!(signal)
    expect(catalog.defaultModel).toBe('native/same-id')
    expect(catalog.models.map(model => model.id)).toEqual(['native/same-id', 'shisa/same-id'])
    await session.submit([userMessage('first')], signal, { model: 'shisa/same-id', reasoningEffort: null })
    await session.submit([userMessage('second')], signal, { model: null, reasoningEffort: null })
    expect(fixture.frames.filter(frame => frame.type === 'set_model')).toEqual([
      expect.objectContaining({ provider: 'shisa', modelId: 'same-id' }),
      expect.objectContaining({ provider: 'native', modelId: 'same-id' }),
    ])
  })
})
