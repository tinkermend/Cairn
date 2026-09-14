import { Injectable } from '@nestjs/common'
import {
  INTERNAL_REQUEST_TTL_SECONDS,
  INTERNAL_SIGNATURE_HEADERS,
  assertWorkerEndpointAllowed,
  parseWorkerEndpoints,
  requireInternalSecret,
  signInternalHeaders,
} from '@cairn/shared'
import { config } from '../config/env'

export type WorkerCall = {
  workerId: string
  workerInstanceId: string
  actorId: string
  runId: string
  sessionGeneration: number
  path: string
  method: 'GET' | 'POST'
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
    const res = await this.send(call)
    const text = await res.text()
    if (!res.ok) throw decodeFailure(res.status, text)
    return text ? JSON.parse(text) : {}
  }

  async requestStream(call: WorkerCall, signal: AbortSignal): Promise<Response> {
    const res = await this.send(call, signal)
    if (!res.ok) {
      const text = await res.text()
      throw decodeFailure(res.status, text)
    }
    return res
  }

  private async send(call: WorkerCall, signal?: AbortSignal): Promise<Response> {
    const endpoints = parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS)
    const base = endpoints[call.workerId]
    if (!base) {
      throw new WorkerForwardError(503, 'WORKER_UNREACHABLE', '执行面暂时不可达')
    }
    try {
      assertWorkerEndpointAllowed(base, config.CAIRN_ENV)
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
    try {
      return await fetch(`${base}${call.path}${suffix}`, {
        method: call.method,
        headers: {
          ...headers,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body || undefined,
        signal,
      })
    } catch {
      throw new WorkerForwardError(503, 'WORKER_UNREACHABLE', '执行面暂时不可达')
    }
  }
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
