import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  claimSessionOperation,
  claimSessionUse,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  forceLastUsedAt,
  getSessionById,
  listDueRetainedSessions,
  listSessionEvents,
  newId,
  observeAuthProfileValidation,
  occupyAutoLoginBudget,
  openIsolatedDb,
  publishTargetAuthProfile,
  registerWorker,
  requestMaintenanceOperation,
  requireCreatedSession,
  schemaFor,
  setSessionAuthSummary,
  setSessionStatus,
  startAuthProfileValidation,
  consoleAccounts,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  SESSION_MAINTENANCE_PROTOCOL,
  evaluateAuthVerify,
  targetAuthProfileDefinitionSchema,
  type Step,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import type { BrowserHandle } from './runtime'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { BrowserSessionManager } from './session-manager'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'x' },
}

function cookieHandle(baseUrl: string, jar: { cookie: string }, profileDir: string): BrowserHandle {
  let address = `${baseUrl}/`
  const locator = () => ({
    fill: async () => undefined,
    click: async () => {
      const res = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        redirect: 'manual',
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie?.includes('bsm=ok')) jar.cookie = 'bsm=ok'
      address = `${baseUrl}/`
    },
    count: async () => 1,
    first: () => ({ isVisible: async () => true }),
    waitFor: async () => undefined,
  })
  const page = {
    evaluate: async () => true,
    goto: async (url: string) => {
      address = url
    },
    url: () => address,
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator,
    isClosed: () => false,
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => ({}),
    close: async () => undefined,
    context: () => ({}),
  }
  return {
    profileDir,
    context: {
      close: async () => undefined,
      browser: () => null,
      pages: () => [],
      newPage: async () => page,
      on: () => undefined,
      off: () => undefined,
      route: async () => undefined,
      newCDPSession: async () => ({ on: () => undefined, send: async () => undefined }),
      request: {
        get: async (url: string) => {
          const res = await fetch(url, { headers: jar.cookie ? { cookie: jar.cookie } : {} })
          const text = await res.text()
          let json: unknown = text
          try {
            json = JSON.parse(text)
          } catch {
            /* keep text */
          }
          return {
            status: () => res.status,
            json: async () => json,
            text: async () => text,
          }
        },
      },
    },
    basePage: page,
  } as unknown as BrowserHandle
}

function signalPage(address: string) {
  const page = new EventEmitter() as EventEmitter & {
    address: string
    url: () => string
    locator: ReturnType<typeof vi.fn>
    isClosed: () => boolean
    goto: (url: string) => Promise<void>
  }
  page.address = address
  page.url = () => page.address
  page.locator = vi.fn(() => ({ first: () => ({ isVisible: async () => false }) }))
  page.isClosed = () => false
  page.goto = async (url: string) => {
    page.address = url
  }
  return page
}

describe('认证驱动保活全链路', { timeout: 120_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let actorId: string
  let targetId: string
  let profileRoot: string
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined
  const workerId = `adr-int-${Date.now().toString(36)}`
  const instanceId = newId()
  const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_test_${Date.now().toString(36)}_adr`)
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-adr-'))
    actorId = newId()
    targetId = newId()
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      const cookie = req.headers.cookie ?? ''
      if (url.startsWith('/auth')) {
        if (!cookie.includes('bsm=ok')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end('{}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, user: 'alice' }))
        return
      }
      if (url.startsWith('/login') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<!doctype html><html><body><form method="POST" action="/login"><input name="username"/><input name="password" type="password"/><button type="submit">登录</button></form></body></html>')
        return
      }
      if (url.startsWith('/login') && req.method === 'POST') {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'bsm=ok; Path=/' })
        res.end()
        return
      }
      if (url === '/' || url.startsWith('/?')) {
        if (!cookie.includes('bsm=ok')) {
          res.writeHead(302, { Location: '/login' })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>home</h1></body></html>')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${addr.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'adr-int',
      email: `adr-int-${actorId}@example.com`,
      status: 'active',
    })
    const { consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin.id })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `adr-${targetId.slice(0, 8)}`,
      name: '保活全链路',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
      sessionPolicy: {
        reclaim: 'AUTH_DRIVEN',
        keepAliveSeconds: 3600,
        authProbeIntervalSeconds: 90,
      },
    })

    const definition = targetAuthProfileDefinitionSchema.parse({
      verify: {
        mode: 'http',
        path: '/auth',
        success: { status: 200, jsonPath: '$.ok', equals: true },
        failure: { status: 401 },
      },
      scope: { origins: [new URL(baseUrl).origin], pathPrefixes: ['/auth'] },
      renew: 'relogin',
    })
    const published = await publishTargetAuthProfile(handle.db, {
      targetId,
      expectedRevision: 0,
      definition,
      actor: { id: actorId },
    })
    const validator = newId()
    await handle.db.insert(targetAccounts).values({
      id: validator,
      targetId,
      displayName: 'validator',
      username: 'validator',
      status: 'active',
    })
    const started = await startAuthProfileValidation(handle.db, {
      targetId,
      targetAccountId: validator,
      expectedRevision: published.current!.revision,
      idempotencyKey: `val-${validator}`,
      actor: { id: actorId },
    })
    const { sessionOperations } = schemaFor(handle.db)
    await handle.db.update(sessionOperations).set({ status: 'WAITING_FOR_AUTH' }).where(eq(sessionOperations.id, started.operation.id))
    const verifyUrl = `${baseUrl}/auth`
    await observeAuthProfileValidation(handle.db, {
      targetId,
      operationId: started.operation.id,
      step: 'valid_pass',
      observation: evaluateAuthVerify({
        definition,
        raw: { kind: 'http', status: 200, body: { ok: true, user: 'alice' }, url: verifyUrl },
        expectedIdentity: null,
        revision: published.current!.revision,
      }),
      actor: { id: actorId },
    })
    await observeAuthProfileValidation(handle.db, {
      targetId,
      operationId: started.operation.id,
      step: 'server_revoked',
      observation: evaluateAuthVerify({
        definition,
        raw: { kind: 'http', status: 401, body: {}, url: verifyUrl },
        expectedIdentity: null,
        revision: published.current!.revision,
      }),
      actor: { id: actorId },
    })

    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId: instanceId,
        profileRoot,
        headless: true,
        maxSessions: 16,
        defaultLeaseTtlSeconds: 60,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 16,
      maxSessions: 16,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS, SESSION_MAINTENANCE_PROTOCOL],
    })
    await manager.reconcileOwn()
    manager.resolveAccountCredential = async () => ({ username: 'alice', password: 'x' })
  })

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  })

  async function makeAccount(label: string): Promise<string> {
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId,
      displayName: label,
      username: `${label}-${id.slice(0, 8)}`,
      status: 'active',
    })
    return id
  }

  async function openAuthDriven(accountId: string) {
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 14_400,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 90,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    expect(
      await setSessionAuthSummary(handle.db, {
        sessionId: session.id,
        ownerWorkerId: workerId,
        ownerWorkerInstanceId: instanceId,
        authState: 'AUTHENTICATED',
        identityState: 'MATCH',
        lastAuthError: null,
        authProfileRevision: 1,
        observedTier: 'LOGIN_VERIFIED',
        recordSuccess: true,
      }),
    ).toBe(true)
    return (await getSessionById(handle.db, session.id))!
  }

  async function runBackgroundVerify(session: { id: string; generation: number; targetAccountId: string }) {
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: session.targetAccountId },
      body: {
        kind: 'VERIFY_AUTH',
        idempotencyKey: `bg-${session.targetAccountId}-${newId().slice(0, 8)}`,
        expectedSessionId: session.id,
        expectedGeneration: session.generation,
      },
      origin: 'BACKGROUND',
    })
    const claimed = await claimSessionOperation(handle.db, {
      workerId,
      instanceId,
      leaseTtlSeconds: 60,
    })
    expect(claimed?.operation.kind).toBe('VERIFY_AUTH')
    expect(claimed?.grant && claimed.session).toBeTruthy()
    await manager.attachMaintenanceOperation({
      operation: claimed!.operation,
      grant: claimed!.grant,
      session: claimed!.session,
      reusedRunId: null,
    })
    return claimed!
  }

  it('SL01 IDLE 空闲超时经 reap 关闭且 close_reason = idle_or_max_lifetime', async () => {
    const accountId = await makeAccount('sl01')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: accountId },
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 30,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: workerId,
      ownerWorkerInstanceId: instanceId,
    })
    await forceLastUsedAt(handle.db, session.id, new Date(Date.now() - 120_000))
    manager.installLiveHandleForTest(session.id, cookieHandle(baseUrl, { cookie: '' }, join(profileRoot, 'sl01')))
    const reaped = await manager.reap()
    expect(reaped.sessionsClosed).toBeGreaterThanOrEqual(1)
    const closed = (await getSessionById(handle.db, session.id))!
    expect(closed.status).toBe('CLOSED')
    expect(closed.closeReason).toBe('idle_or_max_lifetime')
  })

  it('SL04 目标 Cookie 失效后兜底 VERIFY 自动重登并续期', async () => {
    const accountId = await makeAccount('sl04')
    const session = await openAuthDriven(accountId)
    const beforeSuccess = session.lastAuthSuccessAt!.getTime()
    const beforeKeep = session.keepAliveUntil!.getTime()
    const jar = { cookie: 'bsm=ok' }
    manager.installLiveHandleForTest(session.id, cookieHandle(baseUrl, jar, join(profileRoot, 'sl04')))
    jar.cookie = ''
    const claimed = await runBackgroundVerify(session)
    const after = (await getSessionById(handle.db, session.id))!
    expect(after.authState).toBe('AUTHENTICATED')
    expect(after.lastAuthSuccessAt!.getTime()).toBeGreaterThan(beforeSuccess)
    expect(after.keepAliveUntil!.getTime()).toBeGreaterThan(beforeKeep)
    expect(jar.cookie).toContain('bsm=ok')
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 50 })
    expect(events.items.some((event) => event.type === 'auth.attempt_started')).toBe(true)
    expect(events.items.some((event) => event.type === 'session.keepalive_extended')).toBe(true)
    expect(claimed.operation.id).toBeTruthy()
  })

  it('SL05 Cookie 失效且预算暂停时放弃保活、不重登', async () => {
    const accountId = await makeAccount('sl05')
    const session = await openAuthDriven(accountId)
    const beforeKeep = session.keepAliveUntil!.getTime()
    const jar = { cookie: '' }
    manager.installLiveHandleForTest(session.id, cookieHandle(baseUrl, jar, join(profileRoot, 'sl05')))
    expect((await occupyAutoLoginBudget(handle.db, { targetId, targetAccountId: accountId })).ok).toBe(true)
    expect((await occupyAutoLoginBudget(handle.db, { targetId, targetAccountId: accountId })).ok).toBe(false)
    await runBackgroundVerify(session)
    const after = (await getSessionById(handle.db, session.id))!
    expect(after.nextAuthCheckAt).toBeNull()
    expect(after.keepAliveUntil?.getTime()).toBe(beforeKeep)
    expect(jar.cookie).toBe('')
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 50 })
    expect(events.items.some((event) => event.type === 'auth.attempt_started')).toBe(false)
    const { sessionOperations } = schemaFor(handle.db)
    const [op] = await handle.db
      .select()
      .from(sessionOperations)
      .where(eq(sessionOperations.targetAccountId, accountId))
    expect(op?.errorCode).toBe('SESSION_KEEPALIVE_ABANDONED')
  })

  it('SL06 无租约时页面跳登录落信号并排 VERIFY；EXECUTION 只走 D', async () => {
    const idleAccount = await makeAccount('sl06-idle')
    const idle = await openAuthDriven(idleAccount)
    const idlePage = signalPage(`${baseUrl}/`)
    manager.installLiveHandleForTest(idle.id, {
      ...cookieHandle(baseUrl, { cookie: 'bsm=ok' }, join(profileRoot, 'sl06-idle')),
      basePage: idlePage,
    } as BrowserHandle)
    await manager.attachSessionAuthObserver(idle.id)
    idlePage.address = `${baseUrl}/login`
    idlePage.emit('framenavigated')
    await vi.waitFor(async () => {
      const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: idleAccount }, limit: 20 })
      expect(events.items.some((event) => event.type === 'auth.signal_observed')).toBe(true)
    })
    const { sessionOperations } = schemaFor(handle.db)
    await vi.waitFor(async () => {
      const queued = await handle.db.select().from(sessionOperations).where(eq(sessionOperations.targetAccountId, idleAccount))
      expect(queued.some((row) => row.kind === 'VERIFY_AUTH' && row.origin === 'BACKGROUND')).toBe(true)
    })

    const execAccount = await makeAccount('sl06-exec')
    const exec = await openAuthDriven(execAccount)
    const execPage = signalPage(`${baseUrl}/`)
    manager.installLiveHandleForTest(exec.id, {
      ...cookieHandle(baseUrl, { cookie: 'bsm=ok' }, join(profileRoot, 'sl06-exec')),
      basePage: execPage,
    } as BrowserHandle)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `r-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: execAccount,
      actor: { id: actorId },
    })
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: execAccount },
      owner: { kind: 'RUN', runId: run.detail.id, runFencingToken: 1 },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 3600,
    })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error(claimed.message)
    manager.guard.install(claimed.grant)
    manager.leaseToSession.set(claimed.grant.leaseId, exec.id)
    manager.leaseToRun.set(claimed.grant.leaseId, run.detail.id)
    const observe = vi.spyOn(manager, 'observeInRunAuth')
    await manager.attachSessionAuthObserver(exec.id)
    execPage.address = `${baseUrl}/login`
    execPage.emit('framenavigated')
    await vi.waitFor(() => {
      expect(manager.runAuth.get(claimed.grant.leaseId)).toMatchObject({ pendingSignal: true })
      expect(observe).toHaveBeenCalled()
    })
    const execEvents = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: execAccount }, limit: 20 })
    expect(execEvents.items.some((event) => event.type === 'auth.signal_observed')).toBe(false)
    const execOps = await handle.db.select().from(sessionOperations).where(eq(sessionOperations.targetAccountId, execAccount))
    expect(execOps.some((row) => row.kind === 'VERIFY_AUTH' && row.origin === 'BACKGROUND')).toBe(false)
    await handle.db
      .update(sessionOperations)
      .set({
        status: 'FAILED',
        errorCode: 'SESSION_NOT_CLAIMABLE',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sessionOperations.targetAccountId, idleAccount))
  })

  it('SL07 静置不发信号，到期后兜底巡检完成一次核验', async () => {
    const accountId = await makeAccount('sl07')
    const session = await openAuthDriven(accountId)
    const page = signalPage(`${baseUrl}/`)
    manager.installLiveHandleForTest(session.id, {
      ...cookieHandle(baseUrl, { cookie: 'bsm=ok' }, join(profileRoot, 'sl07')),
      basePage: page,
    } as BrowserHandle)
    await manager.attachSessionAuthObserver(session.id)
    const observer = manager.lives.get(session.id)?.authObserver as { inspect?: () => Promise<void> } | undefined
    await observer?.inspect?.()
    const silent = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 20 })
    expect(silent.items.some((event) => event.type === 'auth.signal_observed')).toBe(false)
    const { browserSessions } = schemaFor(handle.db)
    await handle.db
      .update(browserSessions)
      .set({ nextAuthCheckAt: new Date(Date.now() - 1000) })
      .where(eq(browserSessions.id, session.id))
    const due = await listDueRetainedSessions(handle.db, workerId)
    expect(due.some((row) => row.session.id === session.id)).toBe(true)
    const beforeSuccess = session.lastAuthSuccessAt!.getTime()
    await runBackgroundVerify(session)
    const after = (await getSessionById(handle.db, session.id))!
    expect(after.authState).toBe('AUTHENTICATED')
    expect(after.lastAuthSuccessAt!.getTime()).toBeGreaterThanOrEqual(beforeSuccess)
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: accountId }, limit: 20 })
    expect(events.items.some((event) => event.type === 'auth.signal_observed')).toBe(false)
    expect(events.items.some((event) => event.type === 'auth.attempt_started')).toBe(false)
  })
})
