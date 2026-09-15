import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DomainError } from '@cairn/db'
import {
  INTERNAL_SIGNATURE_HEADERS,
  WORKER_RUNS_INTERNAL_PATH_PREFIX,
  acquireAuthControlBodySchema,
  authControlInputBodySchema,
  authControlTokenBodySchema,
  debugActionSchema,
  entityIdSchema,
  observeOperationSchema,
  requireInternalSecret,
  resumeAuthBodySchema,
  targetObservationSchema,
  verifyInternalHeaders,
  workerInternalPath,
  workerRunsInternalPath,
} from '@cairn/shared'
import type { BrowserSessionManager } from '../browser/session-manager'
import type { ExecutionEngine } from '../engine/engine'

const MAX_BODY = 65_536
const PREFIX = '/internal/managed-browser'

export type ManagedBrowserHttp = {
  server: Server
  close: () => Promise<void>
}

export async function startManagedBrowserHttp(input: {
  host: string
  port: number
  secret: string
  workerInstanceId: string
  sessions: BrowserSessionManager
  engine?: ExecutionEngine
}): Promise<ManagedBrowserHttp> {
  const secret = requireInternalSecret(input.secret)
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      secret,
      workerInstanceId: input.workerInstanceId,
      sessions: input.sessions,
      engine: input.engine,
    }).catch((error) => writeError(res, error))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(input.port, input.host, () => resolve())
  })
  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    secret: Uint8Array
    workerInstanceId: string
    sessions: BrowserSessionManager
    engine?: ExecutionEngine
  },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (
    !url.pathname.startsWith(PREFIX) &&
    !url.pathname.startsWith(WORKER_RUNS_INTERNAL_PATH_PREFIX)
  ) {
    writeJson(res, 404, { code: 'NOT_FOUND', message: '未知内部入口' })
    return
  }
  const raw = req.method === 'POST' ? await readBody(req) : ''
  if (req.method !== 'POST') req.resume()
  const actorId = header(req, INTERNAL_SIGNATURE_HEADERS.actor)
  const runId = header(req, INTERNAL_SIGNATURE_HEADERS.run)
  const sessionGeneration = Number(header(req, INTERNAL_SIGNATURE_HEADERS.sessionGeneration))
  const workerInstanceId = header(req, INTERNAL_SIGNATURE_HEADERS.workerInstance)
  const expiresUnix = Number(header(req, INTERNAL_SIGNATURE_HEADERS.expires))
  const signature = header(req, INTERNAL_SIGNATURE_HEADERS.signature)
  if (!actorId || !runId || !Number.isFinite(sessionGeneration) || !workerInstanceId || !signature) {
    writeJson(res, 401, { code: 'UNAUTHORIZED', message: '内部签名不完整' })
    return
  }
  if (workerInstanceId !== ctx.workerInstanceId) {
    writeJson(res, 409, { code: 'WORKER_GENERATION_MISMATCH', message: 'Worker 进程代次不匹配' })
    return
  }
  const ok = await verifyInternalHeaders(ctx.secret, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    path: url.pathname,
    body: raw,
    expiresUnix,
    actorId,
    runId,
    sessionGeneration,
    workerInstanceId,
    signature,
  })
  if (!ok) {
    writeJson(res, 401, { code: 'UNAUTHORIZED', message: '内部签名无效' })
    return
  }
  entityIdSchema.parse(actorId)
  entityIdSchema.parse(runId)
  const pageId = url.searchParams.get('pageId') ?? undefined
  if (req.method === 'GET' && url.pathname === workerInternalPath('/meta')) {
    writeJson(res, 200, await ctx.sessions.describeRunBrowser({ runId, actorId, pageId }))
    return
  }
  if (req.method === 'GET' && url.pathname === workerInternalPath('/frames')) {
    await streamFrames(req, res, ctx.sessions, { runId, actorId, pageId })
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/auth-control/acquire')) {
    const body = acquireAuthControlBodySchema.parse(raw ? JSON.parse(raw) : {})
    writeJson(
      res,
      200,
      await ctx.sessions.acquireRunAuthControl({ runId, actor: { id: actorId }, pageId: body.pageId ?? pageId }),
    )
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/auth-control/heartbeat')) {
    const body = authControlTokenBodySchema.parse(JSON.parse(raw || '{}'))
    writeJson(
      res,
      200,
      await ctx.sessions.heartbeatRunAuthControl({
        runId,
        actorId,
        token: body.token,
        pageId: body.pageId ?? pageId,
      }),
    )
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/auth-control/input')) {
    const body = authControlInputBodySchema.parse(JSON.parse(raw || '{}'))
    writeJson(
      res,
      200,
      await ctx.sessions.inputRunAuthControl({
        runId,
        actorId,
        token: body.token,
        command: body.command,
      }),
    )
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/auth-control/release')) {
    const body = authControlTokenBodySchema.parse(JSON.parse(raw || '{}'))
    writeJson(
      res,
      200,
      { released: await ctx.sessions.releaseRunAuthControl({ runId, actor: { id: actorId }, token: body.token }) },
    )
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/resume-auth')) {
    const body = resumeAuthBodySchema.parse(raw ? JSON.parse(raw) : {})
    await ctx.sessions.resumeRunAuth({
      runId,
      actor: { id: actorId },
      token: body.token,
      note: body.note,
    })
    writeJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === workerInternalPath('/observe')) {
    const body = observeOperationSchema.parse(raw ? JSON.parse(raw) : {})
    writeJson(
      res,
      200,
      targetObservationSchema.parse(await ctx.sessions.observeRun({ runId, actorId, op: body })),
    )
    return
  }
  if (req.method === 'POST' && url.pathname === workerRunsInternalPath('/debug-resume')) {
    if (!ctx.engine) {
      writeJson(res, 503, { code: 'WORKER_UNREACHABLE', message: '执行引擎未就绪' })
      return
    }
    const body = debugActionSchema.parse(raw ? JSON.parse(raw) : {})
    ctx.sessions.invalidateObserveGrant(runId)
    writeJson(res, 200, await ctx.engine.resumeDebug(runId, body, actorId))
    return
  }
  writeJson(res, 404, { code: 'NOT_FOUND', message: '未知内部入口' })
}

async function streamFrames(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: BrowserSessionManager,
  input: { runId: string; actorId: string; pageId?: string },
): Promise<void> {
  const controller = new AbortController()
  bindSseAbort(req, res, controller)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  try {
    await sessions.subscribeRunFrames({
      ...input,
      signal: controller.signal,
      onFrame: (frame) => {
        if (controller.signal.aborted || res.writableEnded) return
        res.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
      },
    })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function bindSseAbort(req: IncomingMessage, res: ServerResponse, controller: AbortController): void {
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  // Node 24 在 GET 读完空 body 后 req.destroyed=true 并 emit('close')，不是客户端断开。
  res.once('close', () => {
    if (!res.writableEnded) abort()
  })
  res.once('error', abort)
  req.socket?.once('close', abort)
  req.socket?.once('error', abort)
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'ZodError')
  ) {
    writeJson(res, 400, { code: 'BAD_REQUEST', message: '请求不合法' })
    return
  }
  if (error instanceof DomainError) {
    const status =
      error.kind === 'not_found'
        ? 404
        : error.kind === 'unauthorized' || error.kind === 'forbidden'
          ? 403
          : error.kind === 'unavailable'
            ? 503
            : error.kind === 'conflict'
              ? 409
              : 400
    writeJson(res, status, { code: error.code, message: error.message })
    return
  }
  writeJson(res, 500, { code: 'INTERNAL', message: '内部处理失败' })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) })
  res.end(raw)
}
