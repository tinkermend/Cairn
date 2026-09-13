/**
 * S06 离线：受管 Page + 适配层控制面。需要真实 PG 与 Chromium。
 * 不因缺少 VL 模型 skip。
 */
import { execFileSync } from 'node:child_process'
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
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db'
import { DEV_CREDENTIAL_KEY, type SessionPolicyOverride, type Step } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { BrowserSessionManager } from '../../browser/session-manager.js'
import { executeOnPage } from '../../browser/surface.js'
import { ActionGate, createCallBarrier, gateActions } from './action-gate.js'
import { detectFabrication, takeStringField } from './extract.js'
import { banNewContext, withLaunchBanned } from './launch-guard.js'
import {
  createFakeChatClient,
  processModelEnvKeys,
  wrapModelClient,
} from './model-client.js'
import { readLabEvents, snapshotResidue, unregisteredResidue } from './page-residue.js'

function countProfileProcesses(profileRoot: string): number {
  const out = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  return out.split('\n').filter((line) => line.includes(profileRoot)).length
}

function cssTarget(value: string) {
  return { framePath: [] as string[], candidates: [{ by: 'css' as const, value }] }
}

const SCHEMA = `cairn_test_${Date.now().toString(36)}_s06`
const LAB_PUBLIC = resolve(__dirname, '../../../../../tests/target-surface-lab/public')
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
  const { chromium } = await import('playwright')
  const browser = await Promise.race([
    chromium.launch({ headless: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
  ])
  await browser.close()
}

describe('S06 适配层 × 受管 Page（离线）', { timeout: 180_000 }, () => {
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
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MIDSCENE_') || key.startsWith('OPENAI_')) delete process.env[key]
    }
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
      const raw = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const relative = extname(raw) ? raw : `${raw}.html`
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
      displayName: 's06-lab',
      email: `s06-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `s06-${SCHEMA.slice(-8)}`,
      name: 'S06 Lab',
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

    workerId = `s06-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
    })
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-s06-'))
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

  async function acquirePage(path: string, sessionPolicy?: SessionPolicyOverride) {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}${path}` },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `s06-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      sessionPolicy,
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
    const nav = await executeOnPage(page, {
      type: 'navigate',
      url: `${baseUrl}${path}`,
      allowedOrigins: [new URL(baseUrl).origin],
    })
    expect(nav.ok).toBe(true)
    return { page, grant: acquired.grant, snapshot: created.detail.snapshot }
  }

  it('受管 acquire 后包装动作：屏障 + abort/丢租后零新 click', async () => {
    const { page, grant } = await acquirePage('/canvas')
    const playwright = await import('playwright')
    await withLaunchBanned(playwright, async () => {
      const controller = new AbortController()
      const gate = new ActionGate(controller.signal)
      const barrier = createCallBarrier()
      const records: Array<{ n: number; params: unknown }> = []
      const wrapped = wrapModelClient({
        gate,
        records,
        barrier,
        inner: createFakeChatClient(() => ({ id: 'ok' })),
      })
      const [click] = gateActions(
        [
          {
            name: 'Click',
            call: async () => {
              await page.click('#board')
            },
          },
        ],
        gate,
      )
      const before = await readLabEvents(page)
      await click.call({})
      const afterClick = await readLabEvents(page)
      expect(afterClick.filter((e) => e.type === 'click').length).toBeGreaterThan(
        before.filter((e) => e.type === 'click').length,
      )
      expect(await page.locator('#order-no').textContent()).toBe('SO-1001')

      const pending = wrapped.chat.completions.create({ model: 'held' })
      const clicksBeforeAbort = (await readLabEvents(page)).filter((e) => e.type === 'click').length
      controller.abort()
      barrier.release()
      await expect(pending).rejects.toThrow('CAIRN_ABORTED:model')
      await expect(click.call({})).rejects.toThrow('CAIRN_ABORTED:action')
      expect((await readLabEvents(page)).filter((e) => e.type === 'click').length).toBe(clicksBeforeAbort)
      expect(records).toHaveLength(1)

      const lost = new ActionGate()
      lost.markLeaseLost()
      const [lostClick] = gateActions(
        [{ name: 'Click', call: async () => page.click('#board') }],
        lost,
      )
      await expect(lostClick.call({})).rejects.toThrow('CAIRN_LEASE_LOST:action')
      expect((await readLabEvents(page)).filter((e) => e.type === 'click').length).toBe(clicksBeforeAbort)
      expect(processModelEnvKeys()).toEqual([])
    })
    await manager.release(grant.leaseId, 's06-abort')
  })

  it('画布单号先取字符串再规则 fill', async () => {
    const { page, grant } = await acquirePage('/canvas')
    await page.click('#board')
    const pageText = await page.locator('main').innerText()
    const field = takeStringField({ orderNo: 'SO-1001' }, 'orderNo')
    expect(field.ok).toBe(true)
    if (!field.ok) throw new Error('orderNo')
    expect(detectFabrication(pageText, field.value)).toBe(false)
    const filled = await executeOnPage(page, {
      type: 'fill',
      target: cssTarget('#echo'),
      value: field.value,
    })
    expect(filled.ok).toBe(true)
    expect(await page.locator('#echo').inputValue()).toBe('SO-1001')
    await manager.release(grant.leaseId, 's06-fill')
  })

  it('缺字段页上假模型编造不得交给 fill', async () => {
    const { page, grant } = await acquirePage('/hybrid-missing')
    await page.click('#query')
    const pageText = await page.locator('main').innerText()
    const modelOutput = { orderNo: 'SO-9999' }
    const field = takeStringField(modelOutput, 'orderNo')
    expect(field.ok).toBe(true)
    if (field.ok) {
      expect(detectFabrication(pageText, field.value)).toBe(true)
    }
    expect(await page.locator('#echo').inputValue()).toBe('')
    await manager.release(grant.leaseId, 's06-fabricate')
  })

  it('适配层安全标志下构造 Agent，destroy 后规则 popup 不被劫持', async () => {
    const { page, grant } = await acquirePage('/popup')
    const before = await snapshotResidue(page)
    const pagesBefore = new Set(page.context().pages())
    const procsBefore = countProfileProcesses(profileRoot)
    expect(procsBefore).toBeGreaterThan(0)
    const runDir = mkdtempSync(join(tmpdir(), 'cairn-midscene-run-'))
    const playwright = await import('playwright')
    try {
      await withLaunchBanned(playwright, async () => {
        const restoreCtx = banNewContext(page.context().browser())
        try {
          const { createManagedMidsceneAgent } = await import('./managed-page-agent.js')
          const agent = await createManagedMidsceneAgent({
            page,
            gate: new ActionGate(),
            modelClient: createFakeChatClient(() => ({ choices: [] })),
            runDir,
          })
          expect(processModelEnvKeys()).toEqual([])
          expect(page).toBe(manager.pageForGrant(grant))
          expect(page.url()).toContain('/popup')
          expect(page.context().pages().filter((item) => !pagesBefore.has(item))).toEqual([])
          expect(countProfileProcesses(profileRoot)).toBe(procsBefore)
          const afterCreate = await snapshotResidue(page)
          expect(unregisteredResidue(before, afterCreate)).toEqual([])
          await agent.destroy()
          const afterDestroy = await snapshotResidue(page)
          expect(unregisteredResidue(before, afterDestroy)).toEqual([])
          expect(processModelEnvKeys()).toEqual([])
        } finally {
          restoreCtx()
        }
      })

      const popup = page.waitForEvent('popup')
      await executeOnPage(page, {
        type: 'click',
        target: cssTarget('#open-child'),
      })
      const child = await popup
      expect(page.url()).toContain('/popup')
      expect(child.url()).toContain('popup-child')
      await child.close()
    } finally {
      await manager.release(grant.leaseId, 's06-residue')
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('REUSE_PAGE 下一 Run 没有适配层残留', async () => {
    const first = await acquirePage('/popup', { reuse: 'REUSE_PAGE' })
    const runDir = mkdtempSync(join(tmpdir(), 'cairn-midscene-run-'))
    try {
      const { createManagedMidsceneAgent } = await import('./managed-page-agent.js')
      const agent = await createManagedMidsceneAgent({
        page: first.page,
        gate: new ActionGate(),
        modelClient: (await import('./model-client.js')).createFakeChatClient(() => ({ choices: [] })),
        runDir,
      })
      await agent.destroy()
      const afterFirst = await snapshotResidue(first.page)
      await manager.release(first.grant.leaseId, 's06-reuse-1')

      const second = await acquirePage('/popup', { reuse: 'REUSE_PAGE' })
      try {
        const afterSecond = await snapshotResidue(second.page)
        expect(unregisteredResidue(afterFirst, afterSecond)).toEqual([])
        expect(second.page).toBe(first.page)
      } finally {
        await manager.release(second.grant.leaseId, 's06-reuse-2')
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
