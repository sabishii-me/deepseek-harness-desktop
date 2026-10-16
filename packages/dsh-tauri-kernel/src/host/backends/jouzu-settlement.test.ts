import type { NativeSession } from './types'
import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJouzuSession } from './jouzu'
import { createSink, ProcessFixture } from './process.fixture'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const command = { file: 'C:/fixture/node.exe', args: ['C:/fixture/jouzu/dist/cli.js'], env: { PATH: 'C:/fixture/bin' } }
const sessions: NativeSession[] = []

function jouzuProcess() {
  const fixture = new ProcessFixture((frame) => {
    if (frame.type === 'get_state') {
      fixture.send({ id: frame.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'jouzu-a' } })
      return
    }
    if (frame.type === 'prompt') {
      fixture.send({ id: frame.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    }
  })
  return fixture
}

function userMessage(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

beforeEach(() => vi.mocked(spawn).mockReset())
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()))
})

/**
 * The official sink refuses a turn whose streams never got a final
 * `assistant()` acknowledgement, which is what produced
 * `BRIDGE_ASSISTANT_UNSETTLED` for Jouzu. Deltas alone are not enough.
 */
describe('jouzu assistant settlement', () => {
  it('acknowledges each content block at its end event', async () => {
    const fixture = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('hi')], new AbortController().signal)
    await prompted

    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'ponder' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'ponder' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'hello' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'hello' } })
    fixture.send({ type: 'agent_settled' })
    await turn

    expect(sink.assistant).toHaveBeenCalledWith('jouzu:0:0', [{ type: 'thinking', text: 'ponder' }])
    expect(sink.assistant).toHaveBeenCalledWith('jouzu:0:1', [{ type: 'text', text: 'hello' }])
  })

  it('presents a tool call before announcing it started', async () => {
    const fixture = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('run it')], new AbortController().signal)
    await prompted

    const args = { command: 'echo hi' }
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-1', name: 'bash', arguments: args } } })
    fixture.send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args })
    fixture.send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false })
    fixture.send({ type: 'agent_settled' })
    await turn

    // The presented arguments must be byte-identical to the ones used for
    // toolStart, because the official sink compares them for equality.
    const presented = JSON.stringify(args)
    expect(sink.assistant).toHaveBeenCalledWith('jouzu:0:0', [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: presented }])
    expect(sink.toolStart).toHaveBeenCalledWith('call-1', 'bash', presented)
    expect(sink.toolEnd).toHaveBeenCalledWith('call-1', 'hi\n', false)
  })
})

/**
 * A Jouzu turn that calls a tool emits `turn_end` and then starts another turn
 * for the result:
 *
 *   agent_start, turn_start, tool_execution_start, tool_execution_end,
 *   turn_end, turn_start, turn_end, agent_settled
 *
 * Settling on the first `turn_end` handed the turn back to DSH while Jouzu was
 * still reasoning, which is why tool-using prompts (e.g. `git status`) never
 * produced a reply. Only `agent_settled` completes the run.
 */
describe('jouzu turn completion', () => {
  it('keeps the turn open across a tool round and settles on agent_settled', async () => {
    const fixture = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('run git status')], new AbortController().signal)
    await prompted

    const args = { command: 'git status' }
    let settled = false
    void turn.then(() => { settled = true })

    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call-1', name: 'bash', arguments: args } } })
    fixture.send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args })
    fixture.send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'clean\n' }] }, isError: false })
    fixture.send({ type: 'turn_end' })
    // The intermediate turn boundary must not release the turn.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Clean tree.' } })
    fixture.send({ type: 'turn_end' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    fixture.send({ type: 'agent_settled' })
    await turn
    expect(settled).toBe(true)
    expect(sink.toolEnd).toHaveBeenCalledWith('call-1', 'clean\n', false)
    expect(sink.assistant).toHaveBeenCalledWith('jouzu:1:0', [{ type: 'text', text: 'Clean tree.' }])
  })
})

/**
 * Jouzu restarts `contentIndex` at 0 on every turn, and a tool round ends one
 * turn and begins another. Lane ids therefore cannot be built from the index
 * alone: the second turn's `contentIndex=0` would reuse the first turn's lane,
 * which the official sink rejects with `BRIDGE_ASSISTANT_ALREADY_SETTLED`.
 *
 * Measured for a tool-using prompt:
 *   turn_start, thinking_start(0), toolcall_start(1), thinking_end(0),
 *   toolcall_end(1), tool_execution_*, turn_end,
 *   turn_start, text_start(0), text_end(0), turn_end, agent_settled
 */
describe('jouzu lane identity', () => {
  it('keeps lanes distinct when contentIndex restarts on the next turn', async () => {
    const fixture = jouzuProcess()
    const sink = createSink()
    // Unlike a bare spy, enforce the sink's single-commit identity contract.
    const committed = new Set<string>()
    sink.assistant.mockImplementation((id) => {
      if (committed.has(id))
        throw new Error('BRIDGE_ASSISTANT_ALREADY_SETTLED')
      committed.add(id)
    })
    sink.text.mockImplementation((id) => {
      if (committed.has(id))
        throw new Error('BRIDGE_ASSISTANT_ALREADY_SETTLED')
    })

    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)

    const prompted = fixture.next(frame => frame.type === 'prompt')
    const turn = session.submit([userMessage('run git status')], new AbortController().signal)
    await prompted

    const args = { command: 'git status' }
    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'checking' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'bash' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-1', name: 'bash', arguments: args } } })
    fixture.send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args })
    fixture.send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'clean\n' }] }, isError: false })
    fixture.send({ type: 'turn_end' })
    // Second turn restarts contentIndex at 0.
    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Clean tree.' } })
    fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Clean tree.' } })
    fixture.send({ type: 'turn_end' })
    fixture.send({ type: 'agent_settled' })
    await turn

    const lanes = sink.assistant.mock.calls.map(call => call[0])
    expect(new Set(lanes).size).toBe(lanes.length)
    expect(lanes).toContain('jouzu:0:0')
    expect(lanes).toContain('jouzu:1:0')
  })
})

describe('Jouzu final message reconciliation', () => {
  it.each([false, true])('confirms a final message with or without end deltas (incremental=%s)', async (incremental) => {
    const fixture = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)
    const turn = session.submit([userMessage('hello')], new AbortController().signal)
    fixture.send({ type: 'turn_start' })
    if (incremental)
      fixture.send({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hello' } })
    fixture.send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } })
    fixture.send({ type: 'agent_settled' })
    await turn
    expect(sink.assistant).toHaveBeenCalledExactlyOnceWith('jouzu:0:0', [{ type: 'text', text: 'hello' }])
  })

  it('labels a reasoning-only completion instead of promoting reasoning into an answer', async () => {
    const fixture = jouzuProcess()
    const sink = createSink()
    vi.mocked(spawn).mockReturnValue(fixture.child)
    const session = await createJouzuSession(command, 'C:/fixture', null, sink, new AbortController().signal)
    sessions.push(session)
    const turn = session.submit([userMessage('status')], new AbortController().signal)
    fixture.send({ type: 'turn_start' })
    fixture.send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private analysis' }] } })
    fixture.send({ type: 'agent_settled' })
    await turn
    expect(sink.assistant.mock.calls[0]![1]).toEqual([{ type: 'thinking', text: 'private analysis' }])
    expect(sink.assistant.mock.calls[1]![1]).toEqual([{ type: 'text', text: expect.stringContaining('[Jouzu 内核桥接提示]') }])
  })
})
