/**
 * Engine × 真浏览器垂直切片。CI 必须跑；没有 Chromium 直接失败，不准 skip。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
} from '@cairn/db'
import { DEV_CREDENTIAL_KEY, LOCAL_SECRET_PROVIDER, type Step } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

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
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-elab-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 60,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretsProvider,
    )
    await manager.reconcileOwn()
  })

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
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant: grant! })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.hit).toBe('查到 42 条')
    expect(detail.stepRuns).toHaveLength(3)
    expect(detail.stepRuns.every((step) => step.attempts.length === 1)).toBe(true)
    const leftover = await handle.db
      .select({ id: sessionLeases.id, status: sessionLeases.status })
      .from(sessionLeases)
      .where(eq(sessionLeases.runId, created.detail.id))
    expect(leftover.filter((row) => row.status === 'ACTIVE')).toEqual([])
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'screenshot' || item.type === 'trace')).toBe(false)
    expect(created.detail.evidenceStatus).toBe('PENDING')
    expect(detail.evidenceStatus === 'COMPLETE' || detail.evidenceStatus === 'PENDING').toBe(true)
  })

  async function runWithPolicy(
    steps: Step[],
    evidencePolicy: { screenshot?: 'off' | 'on_failure' | 'always'; trace?: 'off' | 'on_failure' | 'always' },
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
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(created.detail.id)
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
