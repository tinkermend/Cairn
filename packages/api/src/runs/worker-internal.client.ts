import { Injectable } from '@nestjs/common'
import { Agent } from 'undici'
import {
  INTERNAL_REQUEST_TTL_SECONDS,
  INTERNAL_SIGNATURE_HEADERS,
  WORKER_FORWARD_AUTH_TIMEOUT_MS,
  WORKER_FORWARD_CONNECT_TIMEOUT_MS,
  WORKER_FORWARD_HEADER_TIMEOUT_MS,
  WORKER_RESULT_UNKNOWN_MESSAGE,
  assertWorkerEndpointAllowed,
  requireInternalSecret,
  signInternalHeaders,
} from '@cairn/shared'
import { config } from '../config/env'
import { trackInternalForward } from '../common/process-gauges'

const workerForwardDispatcher = new Agent({
  connectTimeout: WORKER_FORWARD_CONNECT_TIMEOUT_MS,
  bodyTimeout: 0,
})

type WorkerFetchInit = RequestInit & {
  dispatcher?: Agent
  headersTimeout?: number
  bodyTimeout?: number
}

export type WorkerCall = {
  workerId: string
  workerInstanceId: string
  actorId: string
  runId: string
  sessionGeneration: number
  path: string
  method: 'GET' | 'POST'
  endpoint: string
  timeout: 'headers' | 'auth' | 'stream'
  body?: string
  query?: Record<string, string | undefined>
}

export class WorkerForwardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'WorkerForwardError'
  }
}

@Injectable()
export class WorkerInternalClient {
  async requestJson(call: WorkerCall): Promise<unknown> {
    const release = trackInternalForward()
    try {
      const res = await this.send(call)
      const text = await res.text()
      if (!res.ok) throw decodeFailure(res.status, text)
      return text ? JSON.parse(text) : {}
    } finally {
      release()
    }
  }

  async requestStream(call: WorkerCall, signal: AbortSignal): Promise<Response> {
    const release = trackInternalForward()
    try {
      const res = await this.send(call, signal)
      if (!res.ok) {
        const text = await res.text()
        throw decodeFailure(res.status, text)
      }
      return holdForwardUntilClosed(res, signal, release)
    } catch (error) {
      release()
      throw error
    }
  }

  private async send(call: WorkerCall, signal?: AbortSignal): Promise<Response> {
    try {
      assertWorkerEndpointAllowed(call.endpoint, { networkMode: config.CAIRN_WORKER_NETWORK_MODE })
    } catch {
      throw new WorkerForwardError(503, 'WORKER_UNREACHABLE', '执行面暂时不可达')
    }
    const body = call.method === 'GET' ? '' : (call.body ?? '')
    const headers = await signInternalHeaders(requireInternalSecret(config.CAIRN_INTERNAL_AUTH_SECRET), {
      method: call.method,
      path: call.path,
      body,
      expiresUnix: Math.floor(Date.now() / 1000) + INTERNAL_REQUEST_TTL_SECONDS,
      actorId: call.actorId,
      runId: call.runId,
      sessionGeneration: call.sessionGeneration,
      workerInstanceId: call.workerInstanceId,
    })
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value) query.set(key, value)
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const headersTimeout =
      call.timeout === 'auth' ? WORKER_FORWARD_AUTH_TIMEOUT_MS : WORKER_FORWARD_HEADER_TIMEOUT_MS
    const timeout = call.timeout === 'stream' ? undefined : AbortSignal.timeout(headersTimeout)
    const combined = timeout && signal ? AbortSignal.any([signal, timeout]) : (timeout ?? signal)
    const init: WorkerFetchInit = {
      method: call.method,
      headers: {
        ...headers,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body || undefined,
      signal: combined,
      redirect: 'error',
      dispatcher: workerForwardDispatcher,
      headersTimeout,
      bodyTimeout: call.timeout === 'stream' ? 0 : headersTimeout,
    }
    try {
      return await fetch(`${call.endpoint}${call.path}${suffix}`, init)
    } catch {
      if (call.method === 'POST') {
        throw new WorkerForwardError(503, 'WORKER_RESULT_UNKNOWN', WORKER_RESULT_UNKNOWN_MESSAGE)
      }
      throw new WorkerForwardError(503, 'WORKER_UNREACHABLE', '执行面暂时不可达')
    }
  }
}

function holdForwardUntilClosed(res: Response, signal: AbortSignal, release: () => void): Response {
  const done = () => {
    signal.removeEventListener('abort', done)
    release()
  }
  signal.addEventListener('abort', done, { once: true })
  if (!res.body) {
    done()
    return res
  }
  const stream = res.body.pipeThrough(
    new TransformStream({
      flush: done,
    }),
  )
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function decodeFailure(status: number, text: string): WorkerForwardError {
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string }
    if (parsed.code && parsed.message) {
      return new WorkerForwardError(status, parsed.code, sanitizeMessage(parsed.message))
    }
  } catch {
    // 响应不是 JSON 时不回传原文，避免带出内网地址。
  }
  return new WorkerForwardError(
    status >= 400 ? status : 503,
    status === 401 ? 'UNAUTHORIZED' : 'WORKER_UNREACHABLE',
    '执行面暂时不可达',
  )
}

function sanitizeMessage(message: string): string {
  return /https?:\/\/|127\.0\.0\.1|localhost|:8091|:9222/i.test(message) ? '执行面暂时不可达' : message
}

export { INTERNAL_SIGNATURE_HEADERS }
