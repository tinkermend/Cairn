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
import type { Page } from 'playwright'
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
import {
  DEV_CREDENTIAL_KEY,
  type AiCommand,
  type SessionGrant,
  type SessionPolicyOverride,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { BrowserSessionManager } from '../../browser/session-manager.js'
import { executeOnPage } from '../../browser/surface.js'
import { ActionGate, createCallBarrier, gateActions } from './action-gate.js'
import { detectFabrication, takeStringField } from './extract.js'
import { banNewContext, withLaunchBanned } from './launch-guard.js'
import {
  PROBE_MODEL_CONFIG,
  createFakeChatClient,
  processModelEnvKeys,
  wrapModelClient,
  type OpenAiLike,
} from './model-client.js'
import { readLabEvents, snapshotResidue, unregisteredResidue } from './page-residue.js'

function countProfileProcesses(profileRoot: string): number {
  const out = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  return out.split('\n').filter((line) => line.includes(profileRoot)).length
}

function cssTarget(value: string) {
  return { framePath: [], candidates: [{ by: 'css' as const, value }] }
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
      // 每个用例领取一条 Run 且不结束，容量要覆盖本文件的领取次数，否则 claimRun 领不到。
      capacity: 32,
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
      await click!.call()
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
      await expect(click!.call()).rejects.toThrow('CAIRN_ABORTED:action')
      expect((await readLabEvents(page)).filter((e) => e.type === 'click').length).toBe(clicksBeforeAbort)
      expect(records).toHaveLength(1)

      const lost = new ActionGate()
      lost.markLeaseLost()
      const [lostClick] = gateActions(
        [{ name: 'Click', call: async () => page.click('#board') }],
        lost,
      )
      await expect(lostClick!.call()).rejects.toThrow('CAIRN_LEASE_LOST:action')
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

  // 只验证样本里的比对 helper：正式路径不做编造拦截，由场景里的确定性断言核对业务值。
  it('缺字段页上样本 helper 识别出假模型编造的值', async () => {
    const { page, grant } = await acquirePage('/hybrid-missing')
    await page.click('#query')
    const pageText = await page.locator('main').innerText()
    const field = takeStringField({ orderNo: 'SO-9999' }, 'orderNo')
    expect(field.ok).toBe(true)
    if (!field.ok) throw new Error('orderNo')
    expect(detectFabrication(pageText, field.value)).toBe(true)
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

  describe('正式适配层：完整 aiAct 循环里的停止', () => {
    type Injection = (ctx: { controller: AbortController; grant: SessionGrant }) => void

    const DONE_PLAN = [
      '<planning>已完成</planning>',
      '<log>完成</log>',
      '<complete success="true">已点击画布</complete>',
    ].join('\n')

    function completion(content: string) {
      return {
        id: `cairn-fake-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: PROBE_MODEL_CONFIG.MIDSCENE_MODEL_NAME,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    }

    /** qwen3-vl 族：bbox 为 xy 顺序、按 1000 归一化。 */
    async function tapPlan(page: Page, selector: string): Promise<string> {
      const box = await page.locator(selector).boundingBox()
      const viewport = page.viewportSize()
      if (!box || !viewport) throw new Error('无法计算画布坐标')
      const x = (value: number) => Math.round((value / viewport.width) * 1000)
      const y = (value: number) => Math.round((value / viewport.height) * 1000)
      const bbox = [x(box.x + 4), y(box.y + 4), x(box.x + box.width / 2), y(box.y + box.height / 2)]
      return [
        '<planning>点击画布色块</planning>',
        '<log>点击画布</log>',
        '<action-type>Tap</action-type>',
        `<action-param-json>${JSON.stringify({ locate: { prompt: '画布上的蓝色色块', bbox } })}</action-param-json>`,
      ].join('\n')
    }

    function clickCount(events: Array<{ type: string }>): number {
      return events.filter((event) => event.type === 'click').length
    }

    /**
     * 真 Midscene 规划循环 + 按序号回放的模型响应：第 1 次点 selector，之后一律完成。
     * beforePlanReturns 在第 1 次响应已从模型返回、动作尚未开始时触发——正是 SDK 自己不检查
     * abort 的窗口；返回 Promise 时响应被扣住，模拟卡在底层调用里的 SDK。
     */
    async function startScriptedAgent(input: {
      page: Page
      gate: ActionGate
      selector: string
      readonly?: boolean
      beforePlanReturns?: () => void | Promise<void>
      /** 第 2 次规划再点一次；钩子在它返回前触发。 */
      nextSelector?: string
      beforeNextPlanReturns?: () => void | Promise<void>
    }) {
      const { createFormalMidsceneAgent } = await import('./formal-agent.js')
      const plan = await tapPlan(input.page, input.selector)
      const nextPlan = input.nextSelector ? await tapPlan(input.page, input.nextSelector) : undefined
      let outbound = 0
      const scripted: OpenAiLike = {
        chat: {
          completions: {
            create: async () => {
              outbound += 1
              if (outbound === 1) {
                const response = completion(plan)
                await input.beforePlanReturns?.()
                return response
              }
              if (outbound === 2 && nextPlan) {
                const response = completion(nextPlan)
                await input.beforeNextPlanReturns?.()
                return response
              }
              return completion(DONE_PLAN)
            },
          },
        },
      }
      const agent = await createFormalMidsceneAgent({
        page: input.page,
        gate: input.gate,
        readonly: input.readonly ?? false,
        modelConfig: { ...PROBE_MODEL_CONFIG },
        wrapClient: () => wrapModelClient({ gate: input.gate, inner: scripted, records: [] }),
      })
      return { agent, outbound: () => outbound }
    }

    async function runScriptedAiAct(input: { readonly?: boolean; inject?: Injection }) {
      const { page, grant } = await acquirePage('/canvas')
      const controller = new AbortController()
      const { createStepGate } = await import('../port.js')
      const gate = createStepGate(manager, grant, controller.signal)
      const scripted = await startScriptedAgent({
        page,
        gate,
        selector: '#board',
        readonly: input.readonly,
        beforePlanReturns: () => input.inject?.({ controller, grant }),
      })
      const clicksBefore = clickCount(await readLabEvents(page))
      let error: unknown
      try {
        await scripted.agent.aiAct('点击画布上的蓝色色块')
      } catch (caught) {
        error = caught
      } finally {
        await scripted.agent.destroy().catch(() => undefined)
      }
      const newClicks = clickCount(await readLabEvents(page)) - clicksBefore
      const resultVisible = await page.locator('#result').isVisible()
      await manager.release(grant.leaseId, 's06-full-loop')
      return { error, newClicks, resultVisible, outbound: scripted.outbound() }
    }

    it('对照：不注入时回放的规划真的点中画布', async () => {
      const run = await runScriptedAiAct({})
      expect(run.error).toBeUndefined()
      expect(run.newClicks).toBeGreaterThan(0)
      expect(run.resultVisible).toBe(true)
      expect(run.outbound).toBe(2)
    })

    const injections: Array<[string, Injection]> = [
      ['取消', ({ controller }) => controller.abort(new Error('cancel requested'))],
      ['超时', ({ controller }) => controller.abort(new DOMException('step timeout', 'TimeoutError'))],
      ['真实丢租', ({ grant }) => manager.guard.revoke(grant.leaseId)],
    ]
    for (const [name, inject] of injections) {
      it(`规划已返回、动作未开始时${name}：零新动作、零续呼`, async () => {
        const run = await runScriptedAiAct({ inject })
        expect(run.newClicks).toBe(0)
        expect(run.resultVisible).toBe(false)
        expect(run.outbound).toBe(1)
      })
    }

    it('只读步骤在完整循环里同样拒绝动作通道', async () => {
      const run = await runScriptedAiAct({ readonly: true })
      expect(run.newClicks).toBe(0)
      expect(run.resultVisible).toBe(false)
    })

    it('AI 真正执行过动作后：destroy 无未登记残留，规则 popup 不被劫持，REUSE_PAGE 下一 Run 无残留', async () => {
      const first = await acquirePage('/canvas', { reuse: 'REUSE_PAGE' })
      const before = await snapshotResidue(first.page)
      const scripted = await startScriptedAgent({ page: first.page, gate: new ActionGate(), selector: '#board' })
      const clicksBefore = clickCount(await readLabEvents(first.page))
      await scripted.agent.aiAct('点击画布上的蓝色色块')
      expect(clickCount(await readLabEvents(first.page))).toBeGreaterThan(clicksBefore)
      await scripted.agent.destroy()
      expect(unregisteredResidue(before, await snapshotResidue(first.page))).toEqual([])

      const nav = await executeOnPage(first.page, {
        type: 'navigate',
        url: `${baseUrl}/popup`,
        allowedOrigins: [new URL(baseUrl).origin],
      })
      expect(nav.ok).toBe(true)
      const popup = first.page.waitForEvent('popup')
      const clicked = await executeOnPage(first.page, { type: 'click', target: cssTarget('#open-child') })
      expect(clicked.ok).toBe(true)
      const child = await popup
      expect(first.page.url()).toContain('/popup')
      expect(child.url()).toContain('popup-child')
      await child.close()
      await manager.release(first.grant.leaseId, 's06-residue-after-ai-1')

      const second = await acquirePage('/popup', { reuse: 'REUSE_PAGE' })
      try {
        expect(second.page).toBe(first.page)
        expect(unregisteredResidue(before, await snapshotResidue(second.page))).toEqual([])
      } finally {
        await manager.release(second.grant.leaseId, 's06-residue-after-ai-2')
      }
    })

    it('对照：SDK 默认的 PlaywrightAgent 会留下 popup / load 监听与 select 样式，残留检查看得见', async () => {
      // NEW_PAGE：这一页 release 时关闭，默认构造装上的监听不会带进后面的用例。
      const { page, grant } = await acquirePage('/popup')
      try {
        const before = await snapshotResidue(page)
        const { PlaywrightAgent } = await import('@midscene/web/playwright/agent')
        new PlaywrightAgent(page, { generateReport: false, modelConfig: { ...PROBE_MODEL_CONFIG } })
        await page.waitForFunction("Boolean(document.getElementById('midscene-force-select-rendering'))")
        expect(unregisteredResidue(before, await snapshotResidue(page))).toEqual(
          expect.arrayContaining(['popup', 'load', 'select-rendering-style']),
        )
      } finally {
        await manager.release(grant.leaseId, 's06-default-agent-residue')
      }
    })

    it('AI 点开的新窗口在步骤收尾时被关掉，并报未支持', async () => {
      const { page, grant } = await acquirePage('/popup')
      const pagesBefore = new Set(page.context().pages())
      const scripted = await startScriptedAgent({ page, gate: new ActionGate(), selector: '#open-child' })
      const popupOpened = page.waitForEvent('popup')
      try {
        await scripted.agent.aiAct('点击打开子窗')
        const popup = await popupOpened
        const command: AiCommand = {
          type: 'ai_action',
          instruction: '点击打开子窗',
          maxCalls: 5,
          maxOutputTokens: 256,
          requestTimeoutMs: 5_000,
          hangWaitMs: 50,
          allowedOrigins: [new URL(baseUrl).origin],
        }
        const { settleAiCommand } = await import('../port.js')
        await expect(settleAiCommand(page, pagesBefore, command, { ok: true, output: {} })).rejects.toMatchObject({
          code: 'AI_POPUP_UNSUPPORTED',
        })
        expect(popup.isClosed()).toBe(true)
        expect(page.context().pages().filter((item) => !pagesBefore.has(item))).toEqual([])
      } finally {
        await scripted.agent.destroy().catch(() => undefined)
        await manager.release(grant.leaseId, 's06-ai-popup')
      }
    })

    it('丢租分类用真实 SDK 验证：规划阶段丢租未放行动作；点过一次后丢租记 UNKNOWN', async () => {
      const { createStepGate, leaseLostError } = await import('../port.js')

      const idleRun = await acquirePage('/canvas')
      const idleGate = createStepGate(manager, idleRun.grant, new AbortController().signal)
      const idle = await startScriptedAgent({
        page: idleRun.page,
        gate: idleGate,
        selector: '#board',
        beforePlanReturns: () => manager.guard.revoke(idleRun.grant.leaseId),
      })
      await idle.agent.aiAct('点击画布上的蓝色色块').catch(() => undefined)
      await idle.agent.destroy()
      expect(idleGate.leaseLost).toBe(true)
      expect(idleGate.actionsStarted).toBe(0)
      expect(leaseLostError(idleGate).category).toBe('INFRASTRUCTURE')
      await manager.release(idleRun.grant.leaseId, 's06-lease-idle')

      const actedRun = await acquirePage('/canvas')
      const actedGate = createStepGate(manager, actedRun.grant, new AbortController().signal)
      const clicksBefore = clickCount(await readLabEvents(actedRun.page))
      const acted = await startScriptedAgent({
        page: actedRun.page,
        gate: actedGate,
        selector: '#board',
        nextSelector: '#board',
        beforeNextPlanReturns: () => manager.guard.revoke(actedRun.grant.leaseId),
      })
      await acted.agent.aiAct('连点两次画布').catch(() => undefined)
      await acted.agent.destroy()
      expect(clickCount(await readLabEvents(actedRun.page)) - clicksBefore).toBe(1)
      expect(actedGate.leaseLost).toBe(true)
      expect(actedGate.actionsStarted).toBeGreaterThan(0)
      expect(leaseLostError(actedGate).category).toBe('UNKNOWN')
      await manager.release(actedRun.grant.leaseId, 's06-lease-acted')
    })

    /**
     * 迟到调用：第 1 次规划被扣住，模拟步骤取消后 SDK 仍卡在底层调用里。gate 故意不接步骤信号，
     * 代表 gate 管不到的那部分，只靠「先 invalidate 再 release」隔离；下一 Run 用 REUSE_PAGE 取最坏情况。
     */
    async function lateCallAcrossRuns(invalidateFirst: boolean) {
      const first = await acquirePage('/canvas', { reuse: 'REUSE_PAGE' })
      const { waitWithHang } = await import('../port.js')
      const held = createCallBarrier()
      const scripted = await startScriptedAgent({
        page: first.page,
        gate: new ActionGate(),
        selector: '#board',
        beforePlanReturns: () => held.waitIf(1),
      })
      const work = scripted.agent.aiAct('点击画布上的蓝色色块').catch((error: unknown) => error)
      const stop = new AbortController()
      stop.abort()
      expect(await waitWithHang(work, 200, stop.signal)).toEqual({ done: false })
      if (invalidateFirst) await manager.invalidate(first.grant, 'ai_hung')
      await manager.release(first.grant.leaseId, 's06-late-call').catch(() => undefined)

      const second = await acquirePage('/canvas', { reuse: 'REUSE_PAGE' })
      try {
        const clicksBefore = clickCount(await readLabEvents(second.page))
        held.release()
        await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 20_000))])
        return {
          lateClicks: clickCount(await readLabEvents(second.page)) - clicksBefore,
          samePage: second.page === first.page,
          firstClosed: first.page.isClosed(),
        }
      } finally {
        await scripted.agent.destroy().catch(() => undefined)
        await manager.release(second.grant.leaseId, 's06-late-call-next')
      }
    }

    it('迟到不串 Run：先作废会话再释放，gate 管不到的迟到动作也碰不到下一 Run 的页面', async () => {
      const run = await lateCallAcrossRuns(true)
      expect(run.firstClosed).toBe(true)
      expect(run.samePage).toBe(false)
      expect(run.lateClicks).toBe(0)
    })

    it('对照：不作废会话时，同样的迟到动作会落到下一 Run 复用的页面', async () => {
      const run = await lateCallAcrossRuns(false)
      expect(run.samePage).toBe(true)
      expect(run.lateClicks).toBeGreaterThan(0)
    })
  })
})
