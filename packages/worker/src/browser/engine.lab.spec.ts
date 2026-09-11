/**
 * Engine × 真浏览器垂直切片。CI 必须跑；没有 Chromium 直接失败，不准 skip。
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
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
import { ExecutionEngine } from '../engine/engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_elab`
const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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
  })
})
