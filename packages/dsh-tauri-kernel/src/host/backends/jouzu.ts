import type { JouzuModelAccess } from '../service/jouzu-model-access'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { NativeModelCatalog, NativeTurnOptions } from '../../shared/native-model'
import type { NativeAttachments, NativeCommand, NativePermission, NativeContent, NativeSession, NativeSessionOpenOptions, NativeSink } from './types'
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
  /**
   * Zero-based turn counter within this run.
   *
   * Jouzu restarts `contentIndex` at 0 for every turn, and a tool round ends
   * one turn and begins another, so the index alone is not unique across a
   * run. Lane ids combine this counter with the index; reusing a lane after it
   * was settled is rejected by the official sink as
   * `BRIDGE_ASSISTANT_ALREADY_SETTLED`.
   */
  segment: number
  /** Whether the current segment has already carried content. */
  usedSegment: boolean
  finalText: boolean
  finalThinking: boolean
  readonly confirmed: Set<string>
  /** Tool-call argument fragments keyed by lane. */
  readonly fragments: Map<string, string>
  /** Tool calls announced by the assistant and awaiting their execution events. */
  readonly announced: Set<string>
  /** Arguments as presented to the official sink, keyed by tool-call id. */
  readonly presented: Map<string, string>
  readonly pendingCalls: { lane: string, content: NativeContent }[]
  settled: boolean
  failure?: Error
}

export async function createJouzuSession(command: NativeCommand, cwd: string, nativeSessionId: string | null, sink: NativeSink, signal: AbortSignal, options?: NativeSessionOpenOptions, _attachments?: NativeAttachments, modelAccess?: JouzuModelAccess): Promise<NativeSession> {
  if (options?.forkFrom !== undefined && (nativeSessionId !== null || options.forkFrom === ''))
    throw new NativeBridgeError('BRIDGE_FORK_INVALID', 'Jouzu fork requires a source session and no existing native binding')
  if (options?.forkFrom !== undefined)
    throw new NativeBridgeError('BRIDGE_FORK_UNSUPPORTED', 'Jouzu kernel fork is not implemented; the source session was not changed.')
  const session = new JouzuSession(modelAccess?.command ?? command, cwd, sink, nativeSessionId, modelAccess)
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
  private baselineModel?: string
  private applied: NativeTurnOptions = { model: null, reasoningEffort: null }

  constructor(command: NativeCommand, cwd: string, private readonly sink: NativeSink, private readonly storedId: string | null, private readonly modelAccess?: JouzuModelAccess) {
    // A stored binding is resumed through the CLI, the same way Codex and
    // Claude resume theirs; Jouzu's `--session <id>` selects the session to
    // reopen before the RPC surface is attached.
    this.transport = new JsonLinesProcess(
      { ...command, env: { ...(command.env ?? nativeEnvironment()) } },
      storedId === null ? ['--mode', 'rpc'] : ['--session', storedId, '--mode', 'rpc'],
      cwd,
    )
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
    // Resuming happens through the CLI launch; `open` only confirms that the
    // session Jouzu actually attached to is the one that was requested.
    const state = await this.send('get_state', {}, signal)
    const id = identityOf(state ?? {})
    if (id === undefined)
      throw new NativeBridgeError('BRIDGE_PROTOCOL', 'Jouzu did not report a session identity')
    if (this.storedId !== null && id !== this.storedId)
      throw new NativeBridgeError('BRIDGE_RESUME_MISMATCH', 'Jouzu resumed a different session identity')
    this.nativeId = id
    const model = state?.model
    if (model !== null && typeof model === 'object') {
      const selected = model as Record<string, unknown>
      if (typeof selected.provider === 'string' && typeof selected.id === 'string') {
        this.baselineModel = `${selected.provider}/${selected.id}`
        this.applied.model = this.baselineModel
      }
    }
  }

  async models(signal: AbortSignal): Promise<NativeModelCatalog> {
    if (this.catalog)
      return this.withHostedModels(this.catalog, signal)
    const data = await this.send('get_available_models', {}, signal)
    const models: NativeModelCatalog = { models: [] }
    const list = Array.isArray(data?.models) ? data.models : []
    const seen = new Set<string>()
    for (const entry of list) {
      const model = record(entry)
      if (model.provider === 'dsh-bridge')
        continue
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined)
        continue
      const provider = typeof model.provider === 'string' ? model.provider : undefined
      // Jouzu serves the same model id through several providers, while the
      // official catalog requires unique ids. Jouzu's own `--model` selector
      // accepts `provider/id`, so the provider-qualified form is both unique
      // and directly usable when the model is handed back.
      const qualified = provider === undefined ? id : `${provider}/${id}`
      if (seen.has(qualified))
        continue
      seen.add(qualified)
      models.models.push({
        id: qualified,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        ...typeof model.description === 'string' ? { description: model.description } : {},
      })
    }
    if (this.baselineModel !== undefined && seen.has(this.baselineModel))
      models.defaultModel = this.baselineModel
    this.catalog = models
    return this.withHostedModels(models, signal)
  }

  private async withHostedModels(catalog: NativeModelCatalog, signal: AbortSignal): Promise<NativeModelCatalog> {
    if (!this.modelAccess)
      return catalog
    const hosted = await this.modelAccess.catalog(signal)
    return { ...catalog, models: [...catalog.models, ...hosted.models] }
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
    const selectedModel = options === undefined ? undefined : options.model ?? this.baselineModel
    if (selectedModel !== undefined && selectedModel !== this.applied.model) {
      // Jouzu addresses a model by the pair (`provider`, `modelId`); the
      // catalog exposes exactly that pair joined as `provider/id`.
      const separator = selectedModel.indexOf('/')
      if (separator <= 0 || separator === selectedModel.length - 1)
        throw new NativeBridgeError('BRIDGE_MODEL_UNAVAILABLE', 'Jouzu models must be selected as `provider/id`.')
      const hosted = await this.modelAccess?.select({ model: selectedModel, reasoningEffort: options?.reasoningEffort ?? null }, signal)
      await this.send('set_model', hosted ? { provider: 'dsh-bridge', modelId: 'selected' } : { provider: selectedModel.slice(0, separator), modelId: selectedModel.slice(separator + 1) }, signal)
      this.applied = { ...this.applied, model: selectedModel }
    }
    if (selectedModel?.startsWith('dsh/shisa/'))
      await this.modelAccess?.select({ model: selectedModel, reasoningEffort: options?.reasoningEffort ?? null }, signal)
    if (!selectedModel?.startsWith('dsh/shisa/') && options?.reasoningEffort !== null && options?.reasoningEffort !== undefined && options.reasoningEffort !== this.applied.reasoningEffort) {
      await this.send('set_thinking_level', { level: options.reasoningEffort }, signal)
      this.applied = { ...this.applied, reasoningEffort: options.reasoningEffort }
    }
    const run: JouzuRun = {
      result: deferred<void>(),
      signal,
      segment: 0,
      usedSegment: false,
      finalText: false,
      finalThinking: false,
      confirmed: new Set(),
      fragments: new Map(),
      announced: new Set(),
      presented: new Map(),
      pendingCalls: [],
      settled: false,
    }
    this.active = run
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (abortTimer !== undefined)
        return
      const reason = signal.reason instanceof Error ? signal.reason : new NativeBridgeError('BRIDGE_ABORTED', 'Jouzu turn cancelled')
      // Allow cooperative shutdown, then fail and close this child. Never leave
      // the official turn waiting indefinitely for a native settlement event.
      abortTimer = setTimeout(() => {
        this.transport.fail(reason)
        void this.transport.close().catch(() => {})
      }, 5_000)
      void this.send('abort', {}, AbortSignal.timeout(5_000)).catch((error) => {
        this.transport.fail(errorFrom(error))
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.send('prompt', { message: text }, signal)
      await run.result.promise
      if (run.failure)
        throw run.failure
    }
    finally {
      clearTimeout(abortTimer)
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
      finally {
        await this.modelAccess?.dispose()
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
    if (type === 'message_end') {
      const completed = record(message.message ?? {})
      if (completed.role !== 'assistant' || !Array.isArray(completed.content))
        return
      // Final messages are authoritative even when the provider emits no
      // incremental *_end event. Confirm each block at most once.
      completed.content.forEach((value, contentIndex) => {
        const block = record(value)
        if (block.type === 'text' && typeof block.text === 'string')
          this.projectDelta(run, { type: 'text_end', contentIndex, content: block.text })
        else if (block.type === 'thinking' && typeof block.thinking === 'string')
          this.projectDelta(run, { type: 'thinking_end', contentIndex, content: block.thinking })
        else if (block.type === 'toolCall')
          this.projectDelta(run, { type: 'toolcall_end', contentIndex, toolCall: block })
      })
      return
    }
    if (type === 'message_update') {
      this.projectDelta(run, record(message.assistantMessageEvent ?? {}))
      return
    }
    if (type === 'tool_execution_start') {
      // Tool-call deltas may finish before reasoning/text blocks finish.
      // Present calls at execution time, after the assistant message is done,
      // instead of crossing an official tool boundary with an open stream.
      for (const pending of run.pendingCalls.splice(0))
        this.sink.assistant(pending.lane, [pending.content])
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
      this.sink.toolEnd(callId, toolResultText(message.result), failed)
      return
    }
    // `turn_end` closes one tool-loop round, not the whole run: a turn that
    // calls a tool emits `turn_end` and then starts another turn for the
    // result. Only `agent_settled` marks the point at which Jouzu has nothing
    // further to say, so that is the sole completion signal. Each new turn
    // advances the segment, which keeps lane ids unique across the run.
    if (type === 'turn_start') {
      // The first turn keeps segment 0; every later turn advances it so lanes
      // stay unique even though Jouzu restarts contentIndex at 0.
      if (run.usedSegment)
        run.segment++
      run.usedSegment = true
      run.finalText = false
      run.finalThinking = false
      return
    }
    if (type === 'agent_settled') {
      if (run.settled)
        return
      if (!run.finalText && run.finalThinking) {
        this.sink.assistant(`jouzu:${run.segment}:bridge-notice`, [{
          type: 'text',
          text: '[Jouzu 内核桥接提示] 本轮模型只返回了思考内容，没有最终回答正文。工具结果仍保留在上方；思考内容没有被转换成回答。',
        }])
      }
      run.settled = true
      run.result.resolve()
    }
  }

  private projectDelta(run: JouzuRun, event: Record<string, unknown>): void {
    const kind = typeof event.type === 'string' ? event.type : undefined
    const index = typeof event.contentIndex === 'number' ? event.contentIndex : 0
    const lane = `jouzu:${run.segment}:${index}`
    if ((kind === 'text_end' || kind === 'thinking_end' || kind === 'toolcall_end') && run.confirmed.has(lane))
      return
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
        run.finalText ||= text.trim().length > 0
        run.confirmed.add(lane)
        this.sink.assistant(lane, [{ type: 'text', text }])
        return
      }
      case 'thinking_end': {
        const text = typeof event.content === 'string' ? event.content : ''
        run.finalThinking ||= text.trim().length > 0
        run.confirmed.add(lane)
        this.sink.assistant(lane, [{ type: 'thinking', text }])
        return
      }
      case 'toolcall_start': {
        run.fragments.set(lane, '')
        return
      }
      case 'toolcall_delta': {
        if (typeof event.delta === 'string')
          run.fragments.set(lane, (run.fragments.get(lane) ?? '') + event.delta)
        return
      }
      case 'toolcall_end': {
        const fragments = run.fragments.get(lane) ?? ''
        run.fragments.delete(lane)
        const call = record(event.toolCall ?? {})
        const id = typeof call.id === 'string' ? call.id : undefined
        const name = typeof call.name === 'string' ? call.name : undefined
        if (id === undefined || name === undefined)
          return
        // Arguments arrive either as a complete object on `toolCall` or as the
        // JSON fragments accumulated above; prefer the object when present.
        const arguments_ = call.arguments === undefined ? fragments || '{}' : compact(call.arguments)
        run.confirmed.add(lane)
        run.presented.set(id, arguments_)
        run.pendingCalls.push({ lane, content: { type: 'tool-call', id, name, arguments: arguments_ } })
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
