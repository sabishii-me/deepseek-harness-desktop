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
    fixture.send({ type: 'turn_end' })
    await turn

    expect(sink.assistant).toHaveBeenCalledWith('jouzu:0', [{ type: 'thinking', text: 'ponder' }])
    expect(sink.assistant).toHaveBeenCalledWith('jouzu:1', [{ type: 'text', text: 'hello' }])
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
    fixture.send({ type: 'turn_end' })
    await turn

    // The presented arguments must be byte-identical to the ones used for
    // toolStart, because the official sink compares them for equality.
    const presented = JSON.stringify(args)
    expect(sink.assistant).toHaveBeenCalledWith('jouzu:0', [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: presented }])
    expect(sink.toolStart).toHaveBeenCalledWith('call-1', 'bash', presented)
    expect(sink.toolEnd).toHaveBeenCalledWith('call-1', 'hi\n', false)
  })
})
