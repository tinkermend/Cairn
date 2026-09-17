/**
 * Engine × 真浏览器垂直切片。CI 必须跑；没有 Chromium 直接失败，不准 skip。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { Logger } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  sessionLeases,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY, LOCAL_SECRET_PROVIDER, PROCESS_LOG_EVENTS, type Step } from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { saveServiceCaller, issueServiceCredential, authenticateService, createServiceRun, getServiceRun, listScenarioVersions, releaseServiceEvidence } from '@cairn/db'
import { serviceCallerBodySchema } from '@cairn/shared'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'
import { isPlayableWebm } from './video-encoder.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_elab`
const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const LOGIN_HTML = `<!doctype html><html><body>
<form method="POST" action="/login">
  <input name="username" id="user" />
  <input name="password" id="pass" type="password" />
  <button type="submit" id="go">登录</button>
</form>
</body></html>`

type LogLine = { level: string; event: string; fields: Record<string, unknown> }

function captureProcessLogs() {
  const lines: LogLine[] = []
  const take = (level: string) => (first: unknown, second?: unknown) => {
    if (first && typeof first === 'object' && typeof second === 'string') {
      lines.push({ level, event: second, fields: { ...(first as Record<string, unknown>) } })
    }
  }
  const spies = [
    vi.spyOn(Logger.prototype, 'log').mockImplementation(take('info') as never),
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(take('warn') as never),
    vi.spyOn(Logger.prototype, 'error').mockImplementation(take('error') as never),
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(take('debug') as never),
  ]
  return {
    lines,
    restore() {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

async function requireChromium(): Promise<void> {
  try {
    const { chromium } = await import('playwright')
    const browser = await Promise.race([
      chromium.launch({ headless: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
    ])
    await browser.close()
  } catch (error) {
    throw new Error(
      `Engine × 真浏览器垂直切片要求本机 Chromium。CI 已安装；本地请 pnpm --filter @cairn/worker browser:install。${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

describe('ExecutionEngine × 真浏览器（垂直切片）', { timeout: 180_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string
  let objects: ObjectService
  let objectDir = ''

  beforeAll(async () => {
    await requireChromium()
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    const secretId = newId()
    const secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
        return
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        req.resume()
        req.on('end', () => {
          res.writeHead(302, { Location: '/', 'Set-Cookie': 'lab=ok; Path=/' })
          res.end()
        })
        return
      }
      const cookie = req.headers.cookie ?? ''
      if (!cookie.includes('lab=ok')) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'engine-lab',
      email: `elab-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `elab-${SCHEMA.slice(-8)}`,
      name: 'Surface Lab',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
    })
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, 'lab'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'lab',
      username: 'lab',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })

    objectDir = mkdtempSync(join(tmpdir(), 'cairn-elab-obj-'))
    objects = new ObjectService(
      handle,
      new LocalObjectStore(objectDir, 32 * 1024 * 1024),
      {
        retainDays: 30,
        pendingTtlSeconds: 3600,
        maxBytes: 32 * 1024 * 1024,
        traceMaxBytes: 128 * 1024 * 1024,
        videoMaxBytes: 128 * 1024 * 1024,
        uploadMaxAttempts: 3,
      },
    )
    workerId = `elab-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-elab-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 60,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretsProvider,
      objects,
    )
    await manager.reconcileOwn()
  })

  async function claimThis(runId: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
    if (objectDir) rmSync(objectDir, { recursive: true, force: true })
    if (server) {
      await new Promise<void>((done) => server!.close(() => done()))
    }
  }, 30_000)

  it('Lifecycle → acquire → 登录 → navigate/click/extract → 提交栅栏 → release', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开受控页',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/` },
      },
      {
        id: newId(),
        name: '查询',
        type: 'click',
        effectType: 'READ_ONLY',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'role', value: 'button', name: '查询' }],
          },
        },
      },
      {
        id: newId(),
        name: '提取结果',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'hit',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'css', value: '#result' }],
          },
          as: 'text',
        },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `lab-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
    const logs = captureProcessLogs()
    try {
      await engine.execute(created.detail.id, { grant })
    } finally {
      logs.restore()
    }
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.hit).toBe('查到 42 条')
    expect(detail.stepRuns).toHaveLength(3)
    expect(detail.stepRuns.every((step) => step.attempts.length === 1)).toBe(true)
    const started = logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runStarted)
    const finished = logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.runFinished)
    const attemptStarted = logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.attemptStarted)
    const attemptFinished = logs.lines.filter((line) => line.event === PROCESS_LOG_EVENTS.attemptFinished)
    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.fields.exit).toBe('completed')
    expect(finished[0]?.fields.runId).toBe(detail.id)
    expect(finished[0]?.fields.leaseId).toBe(grant.leaseId)
    expect(attemptStarted).toHaveLength(3)
    expect(attemptFinished).toHaveLength(3)
    for (const line of [...attemptStarted, ...attemptFinished]) {
      expect(line.fields.runId).toBe(detail.id)
      expect(line.fields.stepRunId).toBeTruthy()
      expect(line.fields.attemptId).toBeTruthy()
      expect(line.fields.stepType).toMatch(/navigate|click|extract/)
      expect(JSON.stringify(line.fields)).not.toMatch(/password|cookie|secret/i)
    }
    expect(new Set(attemptFinished.map((line) => line.fields.attemptId))).toEqual(
      new Set(detail.stepRuns.flatMap((step) => step.attempts.map((attempt) => attempt.id))),
    )
    const leftover = await handle.db
      .select({ id: sessionLeases.id, status: sessionLeases.status })
      .from(sessionLeases)
      .where(eq(sessionLeases.runId, created.detail.id))
    expect(leftover.filter((row) => row.status === 'ACTIVE')).toEqual([])
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'screenshot' && item.status === 'available')).toBe(true)
    const video = evidence.items.find((item) => item.type === 'video' && !item.attemptId)
    expect(video?.status).toBe('available')
    expect(video?.contentType).toBe('video/webm')
    expect(video?.objectKey).toBeTruthy()
    const stored = await objects.getObject(video!.objectKey!)
    expect(isPlayableWebm(stored.body)).toBe(true)
    expect(created.detail.evidenceStatus).toBe('PENDING')
    expect(detail.evidenceStatus).toBe('COMPLETE')
  })

  it('服务任务复用真实 Engine：成功/失败/取消与发布输出；登录中总时限关闭浏览器', async () => {
    const actor = { id: actorId }
    const caller = (await saveServiceCaller(handle, null, serviceCallerBodySchema.parse({ name: '浏览器服务验收', owner: '平台', runTimeoutSeconds: 60 }), actor)).caller
    const issued = await issueServiceCredential(handle, caller.id, { name: '测试 Key', scopes: ['run:execute', 'run:read', 'run:cancel', 'evidence:read'], grants: [{ targetId, accountIds: [accountId], allowAnonymous: false }], expiresInDays: 1 }, actor)
    const principal = await authenticateService(handle, `Bearer ${issued.token}`)
    async function serviceRun(steps: Step[]) {
      const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `service-${newId()}`, steps, actor })
      const version = (await listScenarioVersions(handle, scenario.id)).items[0]!
      return createServiceRun(handle, principal, { scenarioId: scenario.id, scenarioVersionId: version.id, targetAccountId: accountId, input: {}, idempotencyKey: newId() }, newId())
    }
    const navigate = (): Step => ({ id: newId(), name: '打开', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: baseUrl } })
    const engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
    for (const mode of ['success', 'failure', 'cancel'] as const) {
      const steps: Step[] = [navigate(), mode === 'success'
        ? { id: newId(), name: '业务结果', type: 'echo', effectType: 'READ_ONLY', input: { value: 'approved-result' } }
        : { id: newId(), name: '等待不存在元素', type: 'click', effectType: 'READ_ONLY', policy: { timeoutMs: mode === 'cancel' ? 10000 : 200, retryLimit: 0 }, input: { target: { framePath: [], candidates: [{ by: 'css', value: '#service-missing' }] } } }]
      const created = await serviceRun(steps)
      const grant = await claimThis(created.detail.id)
      const logs = captureProcessLogs()
      try {
        const execution = engine.execute(grant.runId, { grant, cancelPollMs: 20 })
        if (mode === 'cancel') {
          await expect.poll(async () => (await getServiceRun(handle, principal, grant.runId)).stepRuns[1]?.attempts.length, { timeout: 10000 }).toBe(1)
          await getServiceRun(handle, principal, grant.runId, true)
        }
        await execution
      } finally {
        logs.restore()
      }
      const result = await getServiceRun(handle, principal, grant.runId)
      expect(result.status).toBe(mode === 'success' ? 'SUCCEEDED' : mode === 'failure' ? 'FAILED' : 'CANCELLED')
      expect(logs.lines.find((line) => line.event === PROCESS_LOG_EVENTS.runFinished)?.fields.exit).toBe(
        mode === 'success' ? 'completed' : mode === 'failure' ? 'failed' : 'cancelled',
      )
      if (mode === 'success') {
        expect(result.stepRuns[1]!.attempts[0]!.output).toBeNull()
        const output = (await listRunEvidence(handle.db, grant.runId)).items.find(e => e.type === 'output' && e.attemptId === result.stepRuns[1]!.attempts[0]!.id)!
        await releaseServiceEvidence(handle, grant.runId, output.id, true, actor)
        expect((await getServiceRun(handle, principal, grant.runId)).stepRuns[1]!.attempts[0]!.output).toBe('approved-result')
      }
    }
    // A login selector that never appears keeps authentication in flight until the service deadline.
    for (const live of await handle.db.select().from((await import('@cairn/db/testing')).browserSessions)) await manager.close(live.id, 'deadline_fixture')
    await handle.db.update(targets).set({ loginFields: { username: { by: 'css', value: '#never-login' }, password: { by: 'css', value: '#pass' }, submit: { by: 'css', value: '#go' } } }).where(eq(targets.id, targetId))
    await saveServiceCaller(handle, caller.id, serviceCallerBodySchema.parse({ name: caller.name, owner: caller.owner, runTimeoutSeconds: 1 }), actor)
    const timed = await serviceRun([navigate()])
    const grant = await claimThis(timed.detail.id)
    const start = Date.now()
    await engine.execute(grant.runId, { grant, cancelPollMs: 20 })
    expect(Date.now() - start).toBeLessThan(6000)
    expect(await getServiceRun(handle, principal, timed.detail.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'RUN_DEADLINE_EXCEEDED' })
    await handle.db.update(targets).set({ loginFields: { username: { by: 'name', value: 'username' }, password: { by: 'name', value: 'password' }, submit: { by: 'css', value: 'button[type=submit]' } } }).where(eq(targets.id, targetId))
  })

  async function runWithPolicy(
    steps: Step[],
    evidencePolicy: {
      screenshot?: 'off' | 'on_failure' | 'always'
      video?: 'off' | 'always'
      trace?: 'off' | 'on_failure' | 'always'
    },
  ) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `lab-ev-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      evidencePolicy,
      actor: { id: actorId },
    })
    const grant = await claimThis(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
    const started = Date.now()
    await engine.execute(created.detail.id, { grant: grant! })
    const ms = Date.now() - started
    const detail = await getRun(handle.db, created.detail.id)
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    return { detail, evidence, ms }
  }

  it('失败保留 Trace / 截图；成功 on_failure 丢弃 Trace', async () => {
    const failClick: Step = {
      id: newId(),
      name: '点不存在',
      type: 'click',
      effectType: 'READ_ONLY',
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'text', value: '不存在的按钮' }],
        },
      },
    }
    const failed = await runWithPolicy(
      [
        {
          id: newId(),
          name: '打开',
          type: 'navigate',
          effectType: 'IDEMPOTENT',
          input: { url: `${baseUrl}/` },
        },
        failClick,
      ],
      { screenshot: 'on_failure', trace: 'on_failure' },
    )
    expect(failed.detail.status).toBe('FAILED')
    expect(failed.evidence.items.some((item) => item.type === 'screenshot' && item.status === 'available')).toBe(true)
    expect(failed.evidence.items.some((item) => item.type === 'trace' && item.status === 'available')).toBe(true)
    expect(failed.detail.stepRuns.every((step) => step.attempts.length === 1)).toBe(true)

    const ok = await runWithPolicy(
      [
        {
          id: newId(),
          name: '打开',
          type: 'navigate',
          effectType: 'IDEMPOTENT',
          input: { url: `${baseUrl}/` },
        },
      ],
      { screenshot: 'on_failure', trace: 'on_failure' },
    )
    expect(ok.detail.status).toBe('SUCCEEDED')
    expect(ok.evidence.items.some((item) => item.type === 'trace')).toBe(false)
  })

  it('成功与失败都留整次录像，同一 Session 连跑两条互不串联', async () => {
    const nav = (): Step => ({
      id: newId(),
      name: '打开',
      type: 'navigate',
      effectType: 'IDEMPOTENT',
      input: { url: `${baseUrl}/` },
    })
    const failClick: Step = {
      id: newId(),
      name: '点不存在',
      type: 'click',
      effectType: 'READ_ONLY',
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'text', value: '不存在的按钮' }],
        },
      },
    }
    const ok = await runWithPolicy([nav()], { screenshot: 'always', video: 'always', trace: 'off' })
    expect(ok.detail.status).toBe('SUCCEEDED')
    const video1 = ok.evidence.items.find((item) => item.type === 'video')
    expect(video1?.status).toBe('available')
    expect(video1?.objectKey).toBeTruthy()
    expect(isPlayableWebm((await objects.getObject(video1!.objectKey!)).body)).toBe(true)
    expect(ok.evidence.items.some((item) => item.type === 'screenshot' && item.status === 'available')).toBe(true)
    expect(ok.detail.evidenceStatus).toBe('COMPLETE')

    const failed = await runWithPolicy([nav(), failClick], { screenshot: 'always', video: 'always', trace: 'off' })
    expect(failed.detail.status).toBe('FAILED')
    const video2 = failed.evidence.items.find((item) => item.type === 'video')
    expect(video2?.status).toBe('available')
    expect(video2?.objectKey).toBeTruthy()
    expect(isPlayableWebm((await objects.getObject(video2!.objectKey!)).body)).toBe(true)
    expect(video1?.objectKey).not.toBe(video2?.objectKey)
    expect(failed.evidence.items.some((item) => item.type === 'screenshot' && item.status === 'available')).toBe(true)
    expect(failed.detail.status).toBe('FAILED')
  })

  it('同一 Session 连续两个失败 Run 的 Trace 互不串联', async () => {
    const failStep = (): Step => ({
      id: newId(),
      name: '点不存在',
      type: 'click',
      effectType: 'READ_ONLY',
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'text', value: `missing-${newId()}` }],
        },
      },
    })
    const first = await runWithPolicy(
      [
        { id: newId(), name: '打开', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: `${baseUrl}/` } },
        failStep(),
      ],
      { trace: 'on_failure', screenshot: 'off' },
    )
    const second = await runWithPolicy(
      [
        { id: newId(), name: '打开', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: `${baseUrl}/` } },
        failStep(),
      ],
      { trace: 'on_failure', screenshot: 'off' },
    )
    const traces = [...first.evidence.items, ...second.evidence.items].filter((item) => item.type === 'trace')
    expect(traces).toHaveLength(2)
    expect(traces[0]?.objectKey).not.toBe(traces[1]?.objectKey)
    expect(traces[0]?.runId).not.toBe(traces[1]?.runId)
  })

  it('S04：Trace off / always 的单 Attempt 延迟与体积', async () => {
    const nav = (): Step[] => [
      { id: newId(), name: '打开', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: `${baseUrl}/` } },
    ]
    await runWithPolicy(nav(), { screenshot: 'off', trace: 'off' })
    const off = await runWithPolicy(nav(), { screenshot: 'off', trace: 'off' })
    const on = await runWithPolicy(nav(), { screenshot: 'off', trace: 'always' })
    const onTrace = on.evidence.items.find((item) => item.type === 'trace')
    const report = {
      offMs: off.ms,
      onMs: on.ms,
      offTraceBytes: 0,
      onTraceBytes: onTrace?.byteSize ?? 0,
      onTraceStatus: onTrace?.status ?? 'missing',
    }
    process.stdout.write(`S04_TRACE_COST ${JSON.stringify(report)}\n`)
    expect(off.detail.status).toBe('SUCCEEDED')
    expect(on.detail.status).toBe('SUCCEEDED')
    expect(off.evidence.items.some((item) => item.type === 'trace')).toBe(false)
    expect(onTrace?.status).toBe('available')
    expect(report.onTraceBytes).toBeGreaterThan(0)
  })
})
