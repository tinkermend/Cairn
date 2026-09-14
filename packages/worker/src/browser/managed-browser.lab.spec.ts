/**
 * S-LIVE：有 CAIRN_S_LIVE=1 且能启动 Chromium 才测画面 / 输入 / popup。
 * 跳过不等于通过，也不能把默认 capabilities.open 写成 BV08。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY, type Step } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createFakeChatClient } from '../ai/midscene/model-client.js'
import { ActionGate } from '../ai/midscene/action-gate.js'
import { BrowserSessionManager } from './session-manager.js'
import { applyAuthInput } from './managed-helpers.js'
import { startScreencast } from './screencast.js'

const enabled = process.env.CAIRN_S_LIVE === '1' || process.env.CAIRN_S_LIVE === 'true'
const SCHEMA = `cairn_test_${Date.now().toString(36)}_slive`

const PROBE_HTML = `<!doctype html><html lang="zh-CN"><body>
<input id="name" />
<button type="button" id="open-child">打开子窗</button>
<script>
document.getElementById('open-child').addEventListener('click', () => {
  window.open('/child.html', 'lab-child', 'width=360,height=240')
})
</script>
</body></html>`

const CHILD_HTML = `<!doctype html><html lang="zh-CN"><body><h1 id="child">子页</h1></body></html>`
const LOGIN_HTML = `<!doctype html><html><body>
<form method="POST" action="/login">
  <input name="username" id="user" />
  <input name="password" id="pass" type="password" />
  <button type="submit" id="go">登录</button>
</form>
</body></html>`

async function requireChromium(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await Promise.race([
    chromium.launch({ headless: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
  ])
  await browser.close()
}

function cssTarget(value: string) {
  return { framePath: [], candidates: [{ by: 'css' as const, value }] }
}

describe.skipIf(!enabled)('S-LIVE 受管浏览器探针', { timeout: 180_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string
  let profileRoot = ''

  beforeAll(async () => {
    await requireChromium()
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    const secretId = newId()
    const secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
        return
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        req.resume()
        req.on('end', () => {
          res.writeHead(302, { Location: '/probe.html', 'Set-Cookie': 'lab=ok; Path=/' })
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
      if (url.pathname === '/child.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(CHILD_HTML)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PROBE_HTML)
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 's-live',
      email: `slive-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `slive-${SCHEMA.slice(-8)}`,
      name: 'S-LIVE',
      entryUrl: `${baseUrl}/probe.html`,
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
      provider: 'local',
      ciphertext: secretsProvider.encrypt(secretId, 'lab'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'lab',
      username: 'lab',
      secretProvider: 'local',
      secretId,
      status: 'active',
    })

    workerId = `slive-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
    })
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-slive-'))
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        profileRoot,
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
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
    if (server) await new Promise<void>((done) => server!.close(() => done()))
  }, 30_000)

  async function acquireProbe() {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/probe.html` },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `slive-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runGrant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(runGrant?.runId).toBe(created.detail.id)
    const acquired = await manager.acquire(created.detail.snapshot, runGrant!)
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) throw new Error(acquired.message)
    const page = manager.pageForGrant(acquired.grant)
    if (!page) throw new Error('pageForGrant 为空')
    return { page, grant: acquired.grant, snapshot: created.detail.snapshot }
  }

  it('画面首帧、中文输入、popup 后 pageForGrant 交给 AI 适配层同一页', async () => {
    const { page, grant } = await acquireProbe()
    const origin = new URL(baseUrl).origin
    const nav = await manager.execute(grant, {
      type: 'navigate',
      url: `${baseUrl}/probe.html`,
      allowedOrigins: [origin],
    })
    expect(nav.ok).toBe(true)
    const current = manager.pageForGrant(grant)
    if (!current) throw new Error('导航后 pageForGrant 为空')

    const started = Date.now()
    const cast = await startScreencast(current, {
      sessionId: grant.sessionId,
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-0000000000aa',
      documentEpoch: 0,
    })
    const deadline = Date.now() + 3_000
    while (!cast.latest && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const firstFrameMs = Date.now() - started
    expect(cast.latest, '首帧超时，不能把跳过写成 BV08').toBeTruthy()
    expect(firstFrameMs).toBeLessThanOrEqual(3_000)
    expect(cast.latest?.image.startsWith('data:image/jpeg;base64,')).toBe(true)
    await cast.stop()

    await current.locator('#name').click()
    await applyAuthInput(current, {
      type: 'insert_text',
      text: '中文探针',
      pageRef: {
        sessionId: grant.sessionId,
        sessionGeneration: 1,
        pageId: '00000000-0000-4000-8000-0000000000aa',
        documentEpoch: 0,
      },
      commandId: newId(),
      seq: 1,
      frameId: 'lab',
      viewport: { width: 1280, height: 720 },
    })
    expect(await current.locator('#name').inputValue()).toBe('中文探针')

    const before = manager.pageForGrant(grant)
    const handoff = await manager.execute(grant, {
      type: 'click',
      target: cssTarget('#open-child'),
      pageAfter: 'popup',
    })
    expect(handoff).toMatchObject({ ok: true, output: { pageAfter: 'popup' } })
    const handed = manager.pageForGrant(grant)
    expect(handed).toBeTruthy()
    expect(handed).not.toBe(before)
    expect(handed!.url()).toContain('/child.html')
    expect(await handed!.locator('#child').innerText()).toBe('子页')

    const runDir = mkdtempSync(join(tmpdir(), 'cairn-slive-ai-'))
    try {
      const { createManagedMidsceneAgent } = await import('../ai/midscene/managed-page-agent.js')
      const agent = await createManagedMidsceneAgent({
        page: handed!,
        gate: new ActionGate(),
        modelClient: createFakeChatClient(() => ({ choices: [] })),
        runDir,
      })
      expect(agent.page).toBe(manager.pageForGrant(grant))
      expect(agent.page.url()).toContain('/child.html')
      await agent.destroy()
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }

    const browser = handed!.context().browser()
    // 记录版本与单次首帧；不把一次样本写成 BV08 p95 / 20 次循环通过。
    expect(browser?.version()).toBeTruthy()
    expect(firstFrameMs).toBeGreaterThan(0)
    expect(process.platform).toBeTruthy()

    await manager.release(grant.leaseId, 's-live')
  })
})
