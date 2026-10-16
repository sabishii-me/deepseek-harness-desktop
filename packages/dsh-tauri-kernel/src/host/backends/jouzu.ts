import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'
import type { NativeAttachments, NativeCommand, NativePermission, NativeSession, NativeSessionOpenOptions, NativeSink } from './types'
import { randomUUID } from 'node:crypto'
import { deferred, errorFrom, JsonLinesProcess, NativeBridgeError, nativeRuns, PendingRequests, record } from './transport'
import { nativeEnvironment } from '../utils/detection'

/**
 * Jouzu native kernel.
 *
 * Jouzu is a Pi-based agentic CLI (the `jouzu` npm package) that owns its own
 * agent loop, tools and flow control. The desktop kernel binds it exactly like
 * Codex and Claude: one child process per official session, speaking a
 * line-delimited JSON protocol whose events are projected onto `NativeSink`.
 *
 * Protocol — Pi RPC mode (`jouzu --mode rpc`), verified against Jouzu 0.2.0:
 *
 *   stdin  `{ id, type, ... }`, answered by
 *          `{ id, type: 'response', command, success, data? | error? }`.
 *   stdout also carries unsolicited events, each with its own `type`:
 *     `message_start` / `message_end`   full message objects
 *     `message_update`                  { assistantMessageEvent }
 *        -> thinking_start|thinking_delta|thinking_end
 *           text_start|text_delta|text_end
 *           toolcall_start|toolcall_delta|toolcall_end
 *     `tool_execution_start|update|end` { toolCallId, toolName, args, result, isError }
 *     `turn_start` / `turn_end`, `agent_start` / `agent_settled`
 *
 * Jouzu also emits `extension_ui_request` frames for widgets it renders itself
 * (`multiloop`, `schedule-prompts`, ...). Those are acknowledged so the child
 * never blocks, but never surfaced: DSH renders no Jouzu-private widget.
 */

interface JouzuRun {
  readonly result: { promise: Promise<void>, resolve: () => void, reject: (error: Error) => void }
  readonly signal: AbortSignal
  /** Tool-call argument fragments keyed by content index. */
  readonly fragments: Map<number, string>
  /** Tool calls announced by the assistant and awaiting their execution events. */
  readonly announced: Set<string>
  /** Arguments as presented to the official sink, keyed by tool-call id. */
  readonly presented: Map<string, string>
  settled: boolean
  failure?: Error
}

export async function createJouzuSession(command: NativeCommand, cwd: string, nativeSessionId: string | null, sink: NativeSink, signal: AbortSignal, options?: NativeSessionOpenOptions, _attachments?: NativeAttachments): Promise<NativeSession> {
  if (options?.forkFrom !== undefined && (nativeSessionId !== null || options.forkFrom === ''))
    throw new NativeBridgeError('BRIDGE_FORK_INVALID', 'Jouzu fork requires a source session and no existing native binding')
  const session = new JouzuSession(command, cwd, sink, nativeSessionId)
  try {
    await session.open(signal)
  }
  catch (error) {
    await session.dispose().catch(() => {})
    throw error
  }
  return session
}

class JouzuSession implements NativeSession {
  private readonly transport: JsonLinesProcess
  private readonly requests: PendingRequests
  private active?: JouzuRun
  private failure?: Error
  private disposed = false
  private disposePromise?: Promise<void>
  private nativeId = ''
  private catalog?: NativeModelCatalog
  private applied: NativeTurnOptions = { model: null, reasoningEffort: null }

  constructor(command: NativeCommand, cwd: string, private readonly sink: NativeSink, private readonly storedId: string | null) {
    this.transport = new JsonLinesProcess({ ...command, env: { ...(command.env ?? nativeEnvironment()) } }, ['--mode', 'rpc'], cwd)
    this.requests = new PendingRequests(value => this.transport.write(value))
    this.transport.onFailure((error) => {
      this.failure = error
      this.requests.failAll(error)
      this.active?.result.reject(error)
    })
    this.transport.onMessage(message => this.receive(message))
  }

  get id(): string {
    return this.nativeId
  }

  async open(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // A stored binding is resumed explicitly; a fresh session adopts the
    // identity Jouzu reports for the session it started.
    if (this.storedId !== null) {
      const resumed = await this.send('switch_session', { sessionId: this.storedId }, signal)
      const switched = identityOf(resumed ?? {})
      if (switched !== undefined && switched !== this.storedId)
        throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'Jouzu switched to a different session identity')
    }
    const state = await this.send('get_state', {}, signal)
    const id = identityOf(state ?? {})
    if (id === undefined)
      throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Jouzu did not report a session identity')
    if (this.storedId !== null && id !== this.storedId)
      throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'Jouzu resumed a different session identity')
    this.nativeId = id
  }

  async models(signal: AbortSignal): Promise<NativeModelCatalog> {
    if (this.catalog)
      return this.catalog
    const data = await this.send('get_available_models', {}, signal)
    const models: NativeModelCatalog = { models: [] }
    const list = Array.isArray(data?.models) ? data.models : []
    for (const entry of list) {
      const model = record(entry)
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined)
        continue
      models.models.push({
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        ...typeof model.description === 'string' ? { description: model.description } : {},
      })
    }
    this.catalog = models
    return models
  }

  async submit(messages: readonly UserMessage[], signal: AbortSignal, options?: NativeTurnOptions, _permission?: NativePermission): Promise<void> {
    signal.throwIfAborted()
    if (this.disposed || this.failure)
      throw this.failure ?? new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Jouzu session was disposed')
    if (this.active)
      throw new NativeBridgeError('BRIDGE_BUSY', 'Jouzu native session already has an active turn')
    const runs = nativeRuns(messages, undefined)
    if (runs.length === 0)
      throw new NativeBridgeError('BRIDGE_EMPTY_INPUT', 'Jouzu native turn requires a user message')
    const text = runs.map(run => run.map(part => part.type === 'text' ? part.text : '[image]').join('')).join('\n')
    if (options?.model !== null && options?.model !== undefined && options.model !== this.applied.model) {
      await this.send('set_model', { model: options.model }, signal)
      this.applied = { ...this.applied, model: options.model }
    }
    if (options?.reasoningEffort !== null && options?.reasoningEffort !== undefined && options.reasoningEffort !== this.applied.reasoningEffort) {
      await this.send('set_thinking_level', { level: options.reasoningEffort }, signal)
      this.applied = { ...this.applied, reasoningEffort: options.reasoningEffort }
    }
    const run: JouzuRun = {
      result: deferred<void>(),
      signal,
      fragments: new Map(),
      announced: new Set(),
      presented: new Map(),
      settled: false,
    }
    this.active = run
    const onAbort = (): void => {
      // Jouzu cancels cooperatively; the turn settles when it reports back.
      void this.send('abort', {}, AbortSignal.timeout(5_000)).catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.transport.write({ id: randomUUID(), type: 'prompt', message: text })
      await run.result.promise
      if (run.failure)
        throw run.failure
    }
    finally {
      signal.removeEventListener('abort', onAbort)
      if (this.active === run)
        this.active = undefined
    }
    signal.throwIfAborted()
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      const closed = new NativeBridgeError('BRIDGE_PROCESS_CLOSED', 'Jouzu session was disposed')
      this.requests.failAll(closed)
      this.active?.result.reject(closed)
      try {
        await this.transport.close(this.active === undefined)
      }
      catch (error) {
        throw errorFrom(error)
      }
    })()
    return this.disposePromise
  }

  private async send(command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const id = randomUUID()
    const settled = await this.requests.request(id, { id, type: command, ...params }, signal)
    return settled === undefined || settled === null ? undefined : record(settled)
  }

  private receive(message: Record<string, unknown>): void {
    const type = typeof message.type === 'string' ? message.type : undefined
    if (type === 'response') {
      const id = typeof message.id === 'string' ? message.id : undefined
      if (id === undefined)
        return
      if (message.success === false) {
        const detail = typeof message.error === 'string' ? message.error : 'Jouzu rejected the command'
        this.requests.settle(id, undefined, new NativeBridgeError('BRIDGE_NATIVE_REQUEST', detail))
        return
      }
      this.requests.settle(id, message.data ?? {})
      return
    }
    if (type === 'extension_ui_request') {
      // Acknowledge every widget request so the child never blocks on UI DSH
      // does not render. The request itself is intentionally dropped.
      const id = typeof message.id === 'string' ? message.id : undefined
      if (id !== undefined)
        this.transport.write({ type: 'extension_ui_response', id, cancelled: true })
      return
    }
    // `extension_error` reports a broken Jouzu extension. Through RPC this
    // fires for lifecycle hooks (`turn_start`, `agent_end`, ...) whenever a
    // Jouzu extension still holds a stale ctx; it is Jouzu's own condition, so
    // it must not fail the official session.
    if (type === 'extension_error')
      return
    const run = this.active
    if (run === undefined)
      return
    this.project(run, type, message)
  }

  /**
   * Project one Jouzu event onto the official sink.
   *
   * Only content the official session can represent is forwarded: assistant
   * text and reasoning, tool execution, and the terminal turn result. Jouzu's
   * own widgets and internal bookkeeping are dropped rather than invented.
   */
  private project(run: JouzuRun, type: string | undefined, message: Record<string, unknown>): void {
    if (type === 'message_update') {
      this.projectDelta(run, record(message.assistantMessageEvent ?? {}))
      return
    }
    if (type === 'tool_execution_start') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      const name = typeof message.toolName === 'string' ? message.toolName : undefined
      if (callId === undefined || name === undefined)
        return
      // The official sink only accepts `toolStart` for a call it has already
      // seen as an assistant tool-call block, so the presented arguments are
      // kept here and reused verbatim (the sink compares them for equality).
      const presented = run.presented.get(callId)
      if (presented === undefined)
        return
      run.announced.add(callId)
      this.sink.toolStart(callId, name, presented)
      return
    }
    if (type === 'tool_execution_end') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
      if (callId === undefined)
        return
      run.announced.delete(callId)
      const failed = message.isError === true
      if (failed && run.failure === undefined)
        run.failure = new NativeBridgeError('BRIDGE_NATIVE_TOOL', toolResultText(message.result) || 'Jouzu tool failed')
      this.sink.toolEnd(callId, toolResultText(message.result), failed)
      return
    }
    if (type === 'turn_end' || type === 'agent_settled') {
      if (run.settled)
        return
      run.settled = true
      run.result.resolve()
    }
  }

  private projectDelta(run: JouzuRun, event: Record<string, unknown>): void {
    const kind = typeof event.type === 'string' ? event.type : undefined
    const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0
    const lane = `jouzu:${index}`
    switch (kind) {
      case 'text_delta': {
        if (typeof event.delta === 'string' && event.delta !== '')
          this.sink.text(lane, event.delta)
        return
      }
      case 'thinking_delta': {
        if (typeof event.delta === 'string' && event.delta !== '')
          this.sink.thinking(lane, event.delta)
        return
      }
      case 'text_end': {
        // A stream is only settled once its final content is acknowledged;
        // deltas alone leave the official sink waiting forever.
        const text = typeof event.content === 'string' ? event.content : ''
        this.sink.assistant(lane, [{ type: 'text', text }])
        return
      }
      case 'thinking_end': {
        const text = typeof event.content === 'string' ? event.content : ''
        this.sink.assistant(lane, [{ type: 'thinking', text }])
        return
      }
      case 'toolcall_start': {
        run.fragments.set(index, '')
        return
      }
      case 'toolcall_delta': {
        if (typeof event.delta === 'string')
          run.fragments.set(index, (run.fragments.get(index) ?? '') + event.delta)
        return
      }
      case 'toolcall_end': {
        const fragments = run.fragments.get(index) ?? ''
        run.fragments.delete(index)
        const call = record(event.toolCall ?? {})
        const id = typeof call.id === 'string' ? call.id : undefined
        const name = typeof call.name === 'string' ? call.name : undefined
        if (id === undefined || name === undefined)
          return
        // Arguments arrive either as a complete object on `toolCall` or as the
        // JSON fragments accumulated above; prefer the object when present.
        const arguments_ = call.arguments === undefined ? fragments || '{}' : compact(call.arguments)
        run.presented.set(id, arguments_)
        this.sink.assistant(lane, [{ type: 'tool-call', id, name, arguments: arguments_ }])
        return
      }
      default:
        return
    }
  }
}

/** Jouzu reports its session identity under `sessionId` (or a snapshot's `id`). */
function identityOf(value: Record<string, unknown>): string | undefined {
  for (const key of ['sessionId', 'session_id', 'id'] as const) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '')
      return candidate
  }
  return undefined
}

/** Tool output: prefer Jouzu's text blocks, fall back to its structured content. */
function toolResultText(result: unknown): string {
  if (result === undefined || result === null)
    return ''
  if (typeof result === 'string')
    return result
  if (typeof result !== 'object')
    return String(result)
  const value = result as Record<string, unknown>
  const blocks = Array.isArray(value.content) ? value.content : []
  const text = blocks
    .map((block) => {
      if (block === null || typeof block !== 'object')
        return ''
      const entry = block as Record<string, unknown>
      return entry.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
    })
    .join('')
  if (text !== '')
    return text
  if (value.structuredContent !== undefined && value.structuredContent !== null)
    return compact(value.structuredContent)
  return compact(value.details ?? value)
}

function compact(value: unknown): string {
  if (value === undefined || value === null)
    return ''
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}
