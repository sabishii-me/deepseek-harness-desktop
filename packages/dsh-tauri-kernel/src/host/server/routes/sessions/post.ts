import type { EventHandlerRequest } from 'h3'
import type { CreateBody } from '../../../types'
import { defineEventHandler, HTTPError, readBody } from 'h3'
import { NATIVE_BACKENDS } from '../../../../shared/types'
import { session } from '../../../service/session'

export default defineEventHandler<EventHandlerRequest, Promise<{ sessionId: string }>>(async (event) => {
  const body = await readBody<CreateBody>(event)
  if (body === null || typeof body !== 'object' || !NATIVE_BACKENDS.includes(body.backend))
    throw new HTTPError({ statusCode: 400, message: `BRIDGE_BACKEND_INVALID: 请选择 ${NATIVE_BACKENDS.join('、')} 之一。` })
  for (const key of ['workspaceId', 'cwd', 'agentPreset'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim()))
      throw new HTTPError({ statusCode: 400, message: `BRIDGE_REQUEST_INVALID: ${key}` })
  }
  if (body.workspaceId !== undefined && body.cwd !== undefined)
    throw new HTTPError({ statusCode: 400, message: 'BRIDGE_LOCATION_INVALID: workspaceId 与 cwd 不能同时指定。' })
  try {
    return await session.create(body.backend, body.workspaceId, body.cwd, body.agentPreset)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    // `message` is typed as string, but a thrown value can still carry an
    // undefined `message` at runtime, which previously crashed the guard below
    // with a bare TypeError instead of reporting the bridge reason.
    if (typeof message !== 'string' || !message.startsWith('BRIDGE_'))
      throw error
    throw new HTTPError({ statusCode: 400, message })
  }
})
