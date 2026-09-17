import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  claimRun,
  claimSessionUse,
  enterRunWaitingForAuth,
  findAuthWaitLeaseForRun,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  requireCreatedSession,
  failRunValidation,
  findLiveSession,
  forceLeaseExpiresAt,
  getLeaseById,
  getRun,
  getSessionOperation,
  listRunEvidence,
  requestMaintenanceOperation,
  claimSessionOperation,
  findActiveLeaseForSession,
  getSessionById,
  listSessionEvents,
  newId,
  registerWorker,
  releaseSessionUse,
  markWorkerStopped,
  openIsolatedDb,
  schemaFor,
  setSessionAuthSummary,
  setSessionProbe,
  setSessionStatus,
  sql,
  consoleAccounts,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEFAULT_SESSION_POLICY,
  DEV_CREDENTIAL_KEY,
  SESSION_MAINTENANCE_PROTOCOL,
  type RunGrant,
  type RunSnapshot,
  type SessionPolicy,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { BrowserRuntimeError, currentOccupancyGrant, type BrowserHandle } from './runtime'
import { clearPlacementYields, placementYieldExcludes, yieldPlacement } from '../runtime/placement-backoff'
import { BrowserSessionManager, SessionLeaseError } from './session-manager'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_bsm`
const WORKER = `bsm-worker-${Date.now().toString(36)}`
const WORKER_INSTANCE = newId()

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'x' },
}

/*
 * 假句柄要覆盖 `loginWithCredentials` 与 `probeAuth` 真正调到的每个方法。
 * 漏一个不会是类型错误（这里整体 as unknown 转型），而是运行期 TypeError 被登录路径
 * catch 成 false，最后表现为一个与容量腾位毫无关系的 SESSION_AUTH_UNSUPPORTED。
 */
function stubBrowserHandle(
  profileDir: string,
  pages?: { baseUrl?: string; newPageUrl?: string },
): BrowserHandle {
  const locator = () => ({
    fill: async () => undefined,
    click: async () => undefined,
    count: async () => 0,
    first: () => ({ isVisible: async () => false }),
    waitFor: async () => undefined,
  })
  const stubPage = (startUrl: string) => {
    let current = startUrl
    return {
      evaluate: async () => true,
      goto: async (href: string) => {
        current = href
      },
      url: () => current,
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
  }
  return {
    profileDir,
    context: {
      close: async () => undefined,
      browser: () => null,
      pages: () => [],
      newPage: async () => stubPage(pages?.newPageUrl ?? 'http://127.0.0.1/'),
      on: () => undefined,
      off: () => undefined,
      route: async () => undefined,
      newCDPSession: async () => ({ on: () => undefined, send: async () => undefined }),
    },
    basePage: stubPage(pages?.baseUrl ?? 'http://127.0.0.1/'),
  } as unknown as BrowserHandle
}

describe('BrowserSessionManager（集成）', { timeout: 120_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let actorId: string
  let targetId: string
  let accountId: string
  let manualTargetId: string
  let profileRoot: string
  let baseUrl = ''
  let server: ReturnType<typeof createServer> | undefined
  const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-bsm-'))
    actorId = newId()
    targetId = newId()
    accountId = newId()
    manualTargetId = newId()

    /*
     * 内嵌登录夹具，不指向公网。
     *
     * 原来这里写 `https://example.com/`，没有 chromium 时整条认证路径根本跑不到，
     * 测试靠「launch 失败 → 容忍 BROWSER_UNAVAILABLE」通过。一旦机器上有浏览器，
     * example.com 上找不到 `[name=username]`，fill 会挂 30 秒然后抛出来——测试红了，
     * 但真正暴露的是两件事：夹具假定了不存在的页面，且登录失败会以异常逃逸。
     * 指向本地夹具后，认证路径在有无网络时都真的被执行。
     */
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/login') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<!doctype html><html><body><form method="POST" action="/login">
          <input name="username" id="user" /><input name="password" id="pass" type="password" />
          <button type="submit" id="go">登录</button></form></body></html>`)
        return
      }
      if (url.startsWith('/login') && req.method === 'POST') {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'bsm=ok; Path=/' })
        res.end()
        return
      }
      if (url === '/' || url.startsWith('/?')) {
        if (!(req.headers.cookie ?? '').includes('bsm=ok')) {
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
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${addr.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'bsm',
      email: `bsm-${actorId}@example.com`,
      status: 'active',
    })
    const { consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    if (!admin) throw new Error('missing admin role fixture')
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin.id,
    })
    await handle.db.insert(targets).values([
      {
        id: targetId,
        code: `bsm-${SCHEMA.slice(-6)}`,
        name: 'BSM',
        entryUrl: `${baseUrl}/`,
        loginUrl: `${baseUrl}/login`,
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: {
          username: { by: 'name', value: 'username' },
          password: { by: 'name', value: 'password' },
          submit: { by: 'css', value: 'button[type=submit]' },
        },
      },
      {
        id: manualTargetId,
        code: `bsm-m-${SCHEMA.slice(-5)}`,
        name: 'BSM-manual',
        entryUrl: `${baseUrl}/`,
        authMethod: 'manual',
        captchaMode: 'none',
      },
    ])
    // 只有 SESSION_ACCOUNT_REQUIRED 用这个账号（它必须存在，但键不会被碰）；
    // 其余用例各自 makeAccount，互不共享 Target + TargetAccount 键。
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'a',
      username: 'alice',
      status: 'active',
    })

    manager = new BrowserSessionManager(
      handle,
      {
        workerId: WORKER,
        workerInstanceId: WORKER_INSTANCE,
        profileRoot,
        headless: true,
        maxSessions: 32,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    await manager.reconcileOwn()
  })

  afterEach(() => {
    clearPlacementYields()
    manager.launchOverride = undefined
    manager.resolveCredential = undefined
    ;(manager as unknown as { browserUnavailable: boolean }).browserUnavailable = false
  })

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
    if (server) await new Promise<void>((r) => server!.close(() => r()))
  })

  /**
   * 每个用例自己领账号，避免共用同一个 Target + TargetAccount 键。
   *
   * 会话按设计不随 Run 结束关闭，所以共用键的用例会互相看到对方留下的活会话：
   * 容量用例会把别人的会话算进上限，重启自愈用例会撞 browser_sessions_key_live_idx。
   * 原来没暴露是因为有浏览器的机器上整条路径跑不到；现在真的跑了，必须让用例互不依赖。
   */
  async function makeAccount(target: 'password' | 'manual', label: string): Promise<string> {
    const id = newId()
    await handle.db.insert(targetAccounts).values({
      id,
      targetId: target === 'password' ? targetId : manualTargetId,
      displayName: label,
      username: `${label}-${newId().slice(0, 8)}`,
      status: 'active',
    })
    return id
  }

  async function makeRunningSnapshot(input: {
    targetId: string
    accountId: string
    sessionPolicy?: SessionPolicy
  }): Promise<{ snapshot: RunSnapshot; grant: RunGrant }> {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId: input.targetId,
      // 不能截 newId()：v7 前 48 位是毫秒时间戳，前 8 个 hex 只到时间戳高 32 位，
      // 同一个约 65 秒窗口内每次调用都一样，必撞 scenarios_target_name_idx。
      name: `r-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: input.accountId,
      actor: { id: actorId },
      sessionPolicy: input.sessionPolicy ?? { ...DEFAULT_SESSION_POLICY, reuse: 'NEW_PAGE' },
    })
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [created.detail.id],
    )
    const grant = await claimRun(handle, {
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      leaseTtlSeconds: 30,
    })
    if (!grant || grant.runId !== created.detail.id) throw new Error('claimRun 未领到本 Run')
    return { snapshot: (await getRun(handle.db, created.detail.id)).snapshot, grant }
  }

  async function occupyExisting(input: {
    targetId: string
    accountId: string
    runId: string
    workerId: string
    instanceId: string
    fencingToken?: number
  }) {
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId: input.targetId, targetAccountId: input.accountId },
      owner: { kind: 'RUN', runId: input.runId, runFencingToken: input.fencingToken ?? 1 },
      purpose: 'EXECUTION',
      holderWorkerId: input.workerId,
      holderInstanceId: input.instanceId,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)
    return claimed
  }

  it('SM37 未发布规则的 Run 冻结为 LEGACY', async () => {
    const account = await makeAccount('password', 'legacy')
    const { snapshot } = await makeRunningSnapshot({ targetId, accountId: account })
    expect(snapshot.authVerification?.capability ?? 'LEGACY').toBe('LEGACY')
  })

  it('无 targetAccountId → SESSION_ACCOUNT_REQUIRED', async () => {
    const { snapshot: run, grant } = await makeRunningSnapshot({ targetId, accountId })
    const { targetAccountId: _, ...noAccount } = run
    const result = await manager.acquire(noAccount as typeof run, grant)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SESSION_ACCOUNT_REQUIRED')
  })

  it('manual 认证：有浏览器时 WAITING_FOR_AUTH + 认证占用', async () => {
    const account = await makeAccount('manual', 'manual-auth')
    const { snapshot: run, grant } = await makeRunningSnapshot({ targetId: manualTargetId, accountId: account })
    const result = await manager.acquire(run, grant)
    if (!result.ok && result.waitingForAuth) {
      expect((await getRun(handle.db, run.runId)).status).toBe('WAITING_FOR_AUTH')
      return
    }
    if (!result.ok) {
      // 无 chromium：launch 先失败，认证路径未跑到——可接受
      expect(['BROWSER_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'PROFILE_LOCKED']).toContain(
        result.code,
      )
    }
  })

  it('acquire → renew → release；丢租 guard；LEASE_UNKNOWN', async () => {
    const account = await makeAccount('password', 'lease')
    const { snapshot: run, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    manager.resolveCredential = async () => ({ username: 'alice', password: 'x' })
    const result = await manager.acquire(run, grant)
    if (!result.ok) {
      expect(['BROWSER_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'SESSION_AUTH_UNSUPPORTED']).toContain(
        result.code,
      )
      await expect(manager.release(newId(), 'ghost')).rejects.toBeInstanceOf(SessionLeaseError)
      return
    }
    expect(manager.assertCommand(result.grant.leaseId).leaseId).toBe(result.grant.leaseId)
    expect(await manager.renew(result.grant.leaseId)).toBe('ok')

    await forceLeaseExpiresAt(handle.db, result.grant.leaseId, new Date(Date.now() - 1000))
    expect(await manager.renew(result.grant.leaseId)).toBe('lost')
    expect(() => manager.assertCommand(result.grant.leaseId)).toThrow()

    await manager.release(result.grant.leaseId, 'test')
    const lease = await getLeaseById(handle.db, result.grant.leaseId)
    expect(lease?.status === 'RELEASED' || lease?.status === 'EXPIRED').toBe(true)

    await expect(manager.release(newId(), 'ghost')).rejects.toMatchObject({
      code: 'SESSION_LEASE_UNKNOWN',
    })
  })

  it('容量上限：maxSessions=1 时第二键失败', async () => {
    const capInstance = newId()
    await registerWorker(handle.db, {
      workerId: `${WORKER}-cap`,
      instanceId: capInstance,
      capacity: 8,
      maxSessions: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const limited = new BrowserSessionManager(
      handle,
      {
        workerId: `${WORKER}-cap`,
        workerInstanceId: capInstance,
        profileRoot,
        headless: true,
        maxSessions: 1,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await limited.reconcileOwn()
    limited.resolveCredential = async () => ({ username: 'u', password: 'p' })

    const capA = await makeAccount('password', 'cap-a')
    const capB = await makeAccount('password', 'cap-b')
    const { snapshot: run1, grant: grant1 } = await makeRunningSnapshot({ targetId, accountId: capA })
    const { snapshot: run2, grant: grant2 } = await makeRunningSnapshot({ targetId, accountId: capB })
    const a = await limited.acquire(run1, grant1)
    if (!a.ok) {
      expect(['BROWSER_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'PROFILE_LOCKED']).toContain(a.code)
      await limited.shutdown()
      return
    }
    const b = await limited.acquire(run2, grant2)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe('SESSION_CAPACITY_EXCEEDED')
    await limited.release(a.grant.leaseId, 'done')
    await limited.shutdown()
  })

  it('重启自愈清掉名下 OPEN 会话', async () => {
    const account = await makeAccount('password', 'restart')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const { snapshot: run } = await makeRunningSnapshot({ targetId, accountId: account })
    await occupyExisting({
      targetId,
      accountId: account,
      runId: run.runId,
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
    })

    await handle.pool.query(`UPDATE workers SET heartbeat_expires_at = now() - interval '1 second' WHERE id = $1`, [
      WORKER,
    ])
    const freshInstance = newId()
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: freshInstance,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const fresh = new BrowserSessionManager(
      handle,
      {
        workerId: WORKER,
        workerInstanceId: freshInstance,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await fresh.reconcileOwn()
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
    await fresh.shutdown()
    await markWorkerStopped(handle.db, WORKER, freshInstance)
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
  })

  it('EXPIRED 会话入口已登录则复用，不再打回等待', async () => {
    const account = await makeAccount('manual', 'reuse-expired')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      health: 'HEALTHY',
      authState: 'EXPIRED',
    })
    manager.setWorkerInstance(WORKER_INSTANCE)
    manager.installLiveHandleForTest(session.id, stubBrowserHandle(profileRoot))
    const { snapshot: run, grant } = await makeRunningSnapshot({
      targetId: manualTargetId,
      accountId: account,
    })
    const result = await manager.acquire(run, grant)
    expect(result.ok).toBe(true)
    expect((await getSessionById(handle.db, session.id))?.authState).toBe('AUTHENTICATED')
    if (result.ok) await manager.release(result.grant.leaseId, 'test')
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
  })

  it('AH-01 清空 leaseToRun 后仍能经 AUTH_WAIT 租约定位会话', async () => {
    const account = await makeAccount('manual', 'ah01-lookup')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
    const { snapshot: run, grant } = await makeRunningSnapshot({
      targetId: manualTargetId,
      accountId: account,
    })
    manager.setWorkerInstance(WORKER_INSTANCE)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: WORKER,
      holderInstanceId: WORKER_INSTANCE,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)
    const waitGrant = await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: claimed.session.id,
      workerId: WORKER,
      workerInstanceId: WORKER_INSTANCE,
      holdSeconds: 120,
    })
    if (!waitGrant) throw new Error('enter wait failed')
    const waiting = await getRun(handle.db, run.runId)
    expect(waiting.status).toBe('WAITING_FOR_AUTH')
    expect(waiting.placement.sessionId).toBeNull()
    manager.leaseToRun.set(waitGrant.leaseId, run.runId)
    manager.leaseToRun.clear()
    const found = await manager.lookupRunSession(run.runId)
    expect(found.session?.id).toBe(claimed.session.id)
    await releaseSessionUse(handle.db, {
      leaseId: waitGrant.leaseId,
      holderWorkerId: WORKER,
      reason: 'test',
    })
    await handle.pool.query(
      `UPDATE runs SET status = 'CANCELLED', finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE id = $1`,
      [run.runId],
    )

    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: (await getSessionById(handle.db, claimed.session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: WORKER,
    })
  })

  it('AH-02 认证超时 reap：WAITING_FOR_AUTH → FAILED，会话仍 OPEN', async () => {
    const account = await makeAccount('manual', 'auth-timeout')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
    const { snapshot: run, grant } = await makeRunningSnapshot({
      targetId: manualTargetId,
      accountId: account,
    })
    manager.setWorkerInstance(WORKER_INSTANCE)
    const claimed = await claimSessionUse(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      owner: { kind: 'RUN', runId: grant.runId, runFencingToken: grant.fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: WORKER,
      holderInstanceId: WORKER_INSTANCE,
      leaseTtlSeconds: 30,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!claimed.ok) throw new Error(claimed.message ?? claimed.code)
    const waitGrant = await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: claimed.session.id,
      workerId: WORKER,
      workerInstanceId: WORKER_INSTANCE,
      holdSeconds: 1,
    })
    if (!waitGrant) throw new Error('enter wait failed')
    await handle.db.execute(sql`
      UPDATE session_leases SET wait_deadline_at = now() - interval '5 seconds'
       WHERE id = ${waitGrant.leaseId}
    `)

    const reaped = await manager.reap()
    expect(reaped).not.toHaveProperty('authTimeouts')
    expect(reaped.leasesExpired).toBeGreaterThanOrEqual(1)
    expect((await getRun(handle.db, run.runId)).status).toBe('FAILED')
    const evidence = (await listRunEvidence(handle.db, run.runId)).items.find((item) => item.type === 'error')
    expect(evidence?.payload).toMatchObject({ code: 'SESSION_AUTH_TIMEOUT' })
    const { stepRuns } = schemaFor(handle.db)
    const remaining = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, run.runId))
    expect(remaining.length).toBeGreaterThan(0)
    expect(remaining.every((row) => row.status === 'SKIPPED')).toBe(true)
    expect(await getLeaseById(handle.db, waitGrant.leaseId)).toMatchObject({
      status: 'EXPIRED',
      releaseReason: 'auth_wait_deadline',
    })
    const sess = await getSessionById(handle.db, claimed.session.id)
    expect(sess?.status).toBe('OPEN')

    await setSessionStatus(handle.db, {
      sessionId: claimed.session.id,
      expectedVersion: (await getSessionById(handle.db, claimed.session.id))!.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
      ownerWorkerId: WORKER,
    })
  })

  it('目标缺失 → SESSION_TARGET_MISSING，不建会话', async () => {
    const account = await makeAccount('password', 'missing-target')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    const result = await manager.acquire({ ...snapshot, targetId: newId() }, grant)
    expect(result).toMatchObject({ ok: false, code: 'SESSION_TARGET_MISSING' })
    const { rows } = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM browser_sessions WHERE target_account_id = $1`,
      [account],
    )
    expect(rows[0]?.n).toBe('0')
    await failRunValidation(handle.db, snapshot.runId, { grant })
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('FAILED')
  })

  it('策略非法 → SESSION_POLICY_INVALID，不抛、不回交', async () => {
    const account = await makeAccount('password', 'bad-policy')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    const result = await manager.acquire(
      {
        ...snapshot,
        sessionPolicy: { ...DEFAULT_SESSION_POLICY, idleTtlSeconds: 600, maxLifetimeSeconds: 600 },
      },
      grant,
    )
    expect(result).toMatchObject({ ok: false, code: 'SESSION_POLICY_INVALID' })
    const { rows } = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM browser_sessions WHERE target_account_id = $1`,
      [account],
    )
    expect(rows[0]?.n).toBe('0')
    await failRunValidation(handle.db, snapshot.runId, { grant })
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('FAILED')
  })

  it('PROFILE_LOCKED 把刚插入的行标 LOST，不放键', async () => {
    const account = await makeAccount('password', 'locked')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    manager.launchOverride = async () => {
      throw new BrowserRuntimeError('PROFILE_LOCKED', 'SingletonLock')
    }
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    expect(result).toMatchObject({ ok: false, code: 'PROFILE_LOCKED' })
    const { rows } = await handle.pool.query<{ status: string; close_reason: string | null }>(
      `SELECT status, close_reason FROM browser_sessions WHERE target_account_id = $1`,
      [account],
    )
    expect(rows).toEqual([{ status: 'LOST', close_reason: 'profile_locked' }])
    await expect(
      requireCreatedSession(handle.db, {
        key: { targetId, targetAccountId: account },
        ownerWorkerId: WORKER,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })

    expect(await yieldPlacement(handle, grant)).toBe('yielded')
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('RECOVERING')
  })

  it('会话位满先腾空闲无租约的会话；带租约的不腾', async () => {
    const evictInstance = newId()
    await registerWorker(handle.db, {
      workerId: `${WORKER}-evict`,
      instanceId: evictInstance,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const evictor = new BrowserSessionManager(
      handle,
      {
        workerId: `${WORKER}-evict`,
        workerInstanceId: evictInstance,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await evictor.reconcileOwn()
    const idle = await makeAccount('password', 'evict-idle')
    const busy = await makeAccount('password', 'evict-busy')
    const next = await makeAccount('password', 'evict-next')
    const idleSession = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: idle },
      ownerWorkerId: `${WORKER}-evict`,
      ownerWorkerInstanceId: evictInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: idleSession.id,
      expectedVersion: idleSession.version,
      status: 'OPEN',
    })
    const busySession = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: busy },
      ownerWorkerId: `${WORKER}-evict`,
      ownerWorkerInstanceId: evictInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: busySession.id,
      expectedVersion: busySession.version,
      status: 'OPEN',
    })
    const busyScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `busy-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const busyRun = await createRunWithSnapshot(handle.db, {
      scenarioId: busyScenario.id,
      targetAccountId: busy,
      actor: { id: actorId },
    })
    await occupyExisting({
      targetId,
      accountId: busy,
      runId: busyRun.detail.id,
      workerId: `${WORKER}-evict`,
      instanceId: evictInstance,
    })

    evictor.installLiveHandleForTest(idleSession.id, stubBrowserHandle(join(profileRoot, 'idle')))
    evictor.resolveCredential = async () => ({ username: 'u', password: 'p' })
    evictor.launchOverride = async (dir) => stubBrowserHandle(dir)
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: next })
    const result = await evictor.acquire(snapshot, grant)
    evictor.launchOverride = undefined
    expect(result.ok).toBe(true)
    expect((await getSessionById(handle.db, idleSession.id))?.status).toBe('CLOSED')
    expect((await getSessionById(handle.db, idleSession.id))?.closeReason).toBe('capacity_evict')
    expect((await getSessionById(handle.db, busySession.id))?.status).toBe('OPEN')
    const evicted = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: idle }, limit: 20 })
    expect(evicted.items.some((event) => event.type === 'session.evicted')).toBe(true)
    const created = await findLiveSession(handle.db, { targetId, targetAccountId: next })
    expect(created?.status).toBe('OPEN')
    expect(created?.ownerWorkerId).toBe(`${WORKER}-evict`)
    await evictor.shutdown()
  })

  it('会话位全被租约占住则回交，不腾带租约的会话', async () => {
    const fullInstance = newId()
    await registerWorker(handle.db, {
      workerId: `${WORKER}-full`,
      instanceId: fullInstance,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const full = new BrowserSessionManager(
      handle,
      {
        workerId: `${WORKER}-full`,
        workerInstanceId: fullInstance,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await full.reconcileOwn()
    const heldA = await makeAccount('password', 'full-a')
    const heldB = await makeAccount('password', 'full-b')
    const next = await makeAccount('password', 'full-next')
    for (const account of [heldA, heldB]) {
      const session = await requireCreatedSession(handle.db, {
        key: { targetId, targetAccountId: account },
        ownerWorkerId: `${WORKER}-full`,
        ownerWorkerInstanceId: fullInstance,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      })
      await setSessionStatus(handle.db, {
        sessionId: session.id,
        expectedVersion: session.version,
        status: 'OPEN',
      })
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: `full-${newId()}`,
        steps: [echoStep],
        actor: { id: actorId },
      })
      const run = await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        targetAccountId: account,
        actor: { id: actorId },
      })
      await occupyExisting({
        targetId,
        accountId: account,
        runId: run.detail.id,
        workerId: `${WORKER}-full`,
        instanceId: fullInstance,
      })
    }
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: next })
    const result = await full.acquire(snapshot, grant)
    expect(result).toMatchObject({ ok: false, code: 'SESSION_CAPACITY_EXCEEDED' })
    expect(await yieldPlacement(handle, grant)).toBe('yielded')
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('RECOVERING')
    expect(await findLiveSession(handle.db, { targetId, targetAccountId: next })).toBeNull()

    const cooling = placementYieldExcludes()
    expect(cooling).toContain(snapshot.runId)
    const before = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_leases WHERE run_id = $1`,
      [snapshot.runId],
    )
    expect(
      await claimRun(handle, {
        workerId: WORKER,
        instanceId: WORKER_INSTANCE,
        leaseTtlSeconds: 30,
        excludeRunIds: cooling,
      }),
    ).toBeNull()
    const after = await handle.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM run_leases WHERE run_id = $1`,
      [snapshot.runId],
    )
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
    expect(
      (
        await claimRun(handle, {
          workerId: WORKER,
          instanceId: WORKER_INSTANCE,
          leaseTtlSeconds: 30,
        })
      )?.runId,
    ).toBe(snapshot.runId)
    await full.shutdown()
  })

  it('同账号连续两次 acquire 只解析一次凭据；另一账号独立会话', async () => {
    let credCalls = 0
    manager.resolveCredential = async () => {
      credCalls += 1
      return { username: 'alice', password: 'x' }
    }
    const account = await makeAccount('password', 'reuse-once')
    const first = await makeRunningSnapshot({ targetId, accountId: account })
    const a = await manager.acquire(first.snapshot, first.grant)
    if (!a.ok) {
      expect(['BROWSER_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'PROFILE_LOCKED', 'SESSION_AUTH_UNSUPPORTED']).toContain(
        a.code,
      )
      manager.resolveCredential = undefined
      return
    }
    await manager.release(a.grant.leaseId, 'done')
    const second = await makeRunningSnapshot({ targetId, accountId: account })
    const b = await manager.acquire(second.snapshot, second.grant)
    expect(b.ok).toBe(true)
    expect(credCalls).toBe(1)
    if (b.ok) await manager.release(b.grant.leaseId, 'done')

    const other = await makeAccount('password', 'reuse-other')
    const third = await makeRunningSnapshot({ targetId, accountId: other })
    const c = await manager.acquire(third.snapshot, third.grant)
    expect(c.ok).toBe(true)
    expect(credCalls).toBe(2)
    const left = await findLiveSession(handle.db, { targetId, targetAccountId: account })
    const right = await findLiveSession(handle.db, { targetId, targetAccountId: other })
    expect(left?.profileKey).not.toBe(right?.profileKey)
    expect(left?.ownerWorkerId).toBe(WORKER)
    expect(right?.ownerWorkerId).toBe(WORKER)
    if (c.ok) await manager.release(c.grant.leaseId, 'done')
    manager.resolveCredential = undefined
  })

  it('stopAllLocal 无句柄则 LOST，同键不能再建', async () => {
    const healInstance = newId()
    await registerWorker(handle.db, {
      workerId: `${WORKER}-heal`,
      instanceId: healInstance,
      capacity: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const isolator = new BrowserSessionManager(
      handle,
      {
        workerId: `${WORKER}-heal`,
        workerInstanceId: healInstance,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await isolator.reconcileOwn()
    const account = await makeAccount('password', 'heal-lost')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: `${WORKER}-heal`,
      ownerWorkerInstanceId: healInstance,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const results = await isolator.stopAllLocal()
    expect(results).toEqual(expect.arrayContaining([{ sessionId: session.id, result: 'unconfirmed' }]))
    expect((await getSessionById(handle.db, session.id))?.status).toBe('LOST')
    await expect(
      requireCreatedSession(handle.db, {
        key: { targetId, targetAccountId: account },
        ownerWorkerId: `${WORKER}-heal`,
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 600,
        maxLifetimeSeconds: 3600,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await isolator.shutdown()
  })

  it('BROWSER_UNAVAILABLE 回交且自禁到下一轮 reap', async () => {
    let launches = 0
    manager.launchOverride = async () => {
      launches += 1
      throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', 'missing executable')
    }
    const account = await makeAccount('password', 'nobrowser')
    const first = await makeRunningSnapshot({ targetId, accountId: account })
    const a = await manager.acquire(first.snapshot, first.grant)
    expect(a).toMatchObject({ ok: false, code: 'BROWSER_UNAVAILABLE' })
    expect(await yieldPlacement(handle, first.grant)).toBe('yielded')
    expect((await getRun(handle.db, first.snapshot.runId)).status).toBe('RECOVERING')

    const second = await makeRunningSnapshot({ targetId, accountId: await makeAccount('password', 'nobrowser-2') })
    const b = await manager.acquire(second.snapshot, second.grant)
    expect(b).toMatchObject({ ok: false, code: 'BROWSER_UNAVAILABLE' })
    expect(launches).toBe(1)

    await manager.reap()
    const third = await makeRunningSnapshot({ targetId, accountId: await makeAccount('password', 'nobrowser-3') })
    await manager.acquire(third.snapshot, third.grant)
    expect(launches).toBe(2)
    manager.launchOverride = undefined
  })

  it('SM34A acquire 先写租约再启动，launch 期间 ALS 为 EXECUTION', async () => {
    const account = await makeAccount('password', 'als-launch')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    let purpose: string | undefined
    let activeBeforeLaunch = 0
    manager.resolveCredential = async () => ({ username: 'alice', password: 'x' })
    manager.launchOverride = async (dir) => {
      purpose = currentOccupancyGrant()?.purpose
      const { rows } = await handle.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session_leases
          WHERE holder_worker_id = $1 AND status = 'ACTIVE' AND purpose = 'EXECUTION'`,
        [WORKER],
      )
      activeBeforeLaunch = Number(rows[0]?.n ?? '0')
      return stubBrowserHandle(dir)
    }
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    manager.resolveCredential = undefined
    expect(result.ok).toBe(true)
    expect(purpose).toBe('EXECUTION')
    expect(activeBeforeLaunch).toBeGreaterThan(0)
    if (result.ok) await manager.release(result.grant.leaseId, 'test')
  })

  it('SM34B execute 期间安装 ALS，离开后清空', async () => {
    const account = await makeAccount('password', 'als-exec')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    manager.resolveCredential = async () => ({ username: 'alice', password: 'x' })
    manager.launchOverride = async (dir) => stubBrowserHandle(dir)
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    manager.resolveCredential = undefined
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const seen: Array<string | undefined> = []
    const page = manager.pageForGrant(result.grant) as { goto?: (...args: unknown[]) => Promise<unknown> } | undefined
    const origGoto = page?.goto?.bind(page)
    if (page && origGoto) {
      page.goto = async (...args: unknown[]) => {
        seen.push(currentOccupancyGrant()?.purpose)
        return origGoto(...args)
      }
    }
    const executed = await manager.execute(result.grant, {
      type: 'navigate',
      url: 'http://127.0.0.1/',
      allowedOrigins: ['http://127.0.0.1'],
    })
    expect(executed.ok).toBe(true)
    expect(seen).toEqual(['EXECUTION'])
    expect(currentOccupancyGrant()).toBeUndefined()
    await manager.release(result.grant.leaseId, 'test')
  })

  it('SM34C 同账号第二 Run 不能同时征用', async () => {
    const account = await makeAccount('password', 'als-busy')
    const first = await makeRunningSnapshot({ targetId, accountId: account })
    const otherScenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `r-${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const otherRun = await createRunWithSnapshot(handle.db, {
      scenarioId: otherScenario.id,
      targetAccountId: account,
      actor: { id: actorId },
      sessionPolicy: { ...DEFAULT_SESSION_POLICY, reuse: 'NEW_PAGE' },
    })
    const secondGrant: RunGrant = {
      runId: otherRun.detail.id,
      leaseId: newId(),
      fencingToken: 1,
      holderWorkerId: WORKER,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const secondSnapshot = (await getRun(handle.db, otherRun.detail.id)).snapshot
    manager.resolveCredential = async () => ({ username: 'alice', password: 'x' })
    let launches = 0
    manager.launchOverride = async (dir) => {
      launches += 1
      return stubBrowserHandle(dir)
    }
    const held = await manager.acquire(first.snapshot, first.grant)
    expect(held.ok).toBe(true)
    const blocked = await manager.acquire(secondSnapshot, secondGrant)
    expect(blocked).toMatchObject({ ok: false, code: 'SESSION_BUSY' })
    expect(launches).toBe(1)
    manager.launchOverride = undefined
    manager.resolveCredential = undefined
    if (held.ok) await manager.release(held.grant.leaseId, 'test')
  })

  it('SM34D 人工认证先 EXECUTION 再切 AUTH_WAIT', async () => {
    const account = await makeAccount('manual', 'als-wait')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId: manualTargetId, accountId: account })
    let purposeAtLaunch: string | undefined
    manager.launchOverride = async (dir) => {
      purposeAtLaunch = currentOccupancyGrant()?.purpose
      return stubBrowserHandle(dir)
    }
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    expect(purposeAtLaunch).toBe('EXECUTION')
    expect(result).toMatchObject({ ok: false, waitingForAuth: true })
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('WAITING_FOR_AUTH')
    const { rows } = await handle.pool.query<{ purpose: string }>(
      `SELECT purpose FROM session_leases
        WHERE holder_worker_id = $1 AND status = 'ACTIVE'`,
      [WORKER],
    )
    expect(rows.map((row) => row.purpose)).toEqual(['AUTH_WAIT'])
  })

  it('AUTH_WAIT 把已打开的登录页交给独占输入，不留空白 NEW_PAGE', async () => {
    const account = await makeAccount('password', 'wait-login-page')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    const loginUrl = `${baseUrl}/login`
    manager.launchOverride = async (dir) =>
      stubBrowserHandle(dir, { baseUrl: loginUrl, newPageUrl: 'about:blank' })
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    expect(result).toMatchObject({ ok: false, waitingForAuth: true })
    const lives = (
      manager as unknown as {
        lives: Map<
          string,
          {
            pages: Map<string, { page: { url: () => string } }>
            currentPageIdByRun: Map<string, string>
          }
        >
      }
    ).lives
    let current: string | undefined
    let anyLogin = false
    for (const live of lives.values()) {
      const currentId = live.currentPageIdByRun.get(snapshot.runId)
      const currentUrl = currentId ? live.pages.get(currentId)?.page.url() : undefined
      if (currentUrl) current = currentUrl
      for (const entry of live.pages.values()) {
        if (entry.page.url().includes('/login')) anyLogin = true
      }
    }
    expect(anyLogin).toBe(true)
    expect(current).toContain('/login')
  })

  it('F402 切 AUTH_WAIT 失败不得回报等待', async () => {
    const account = await makeAccount('manual', 'f402')
    const { snapshot, grant } = await makeRunningSnapshot({ targetId: manualTargetId, accountId: account })
    manager.launchOverride = async (dir) => {
      const occupancy = currentOccupancyGrant()
      if (occupancy) {
        await releaseSessionUse(handle.db, {
          leaseId: occupancy.leaseId,
          holderWorkerId: WORKER,
          reason: 'test_drop_execution',
        })
      }
      return stubBrowserHandle(dir)
    }
    const result = await manager.acquire(snapshot, grant)
    manager.launchOverride = undefined
    expect(result.ok).toBe(false)
    expect('waitingForAuth' in result && result.waitingForAuth).toBeFalsy()
    expect((await getRun(handle.db, snapshot.runId)).status).not.toBe('WAITING_FOR_AUTH')
    expect(await findAuthWaitLeaseForRun(handle.db, snapshot.runId)).toBeNull()
  })

  it('SLW04 AUTH_WAIT 持有者失联经 reap() 计次并标 LOST', async () => {
    const account = await makeAccount('password', 'slw04')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    const claimed = await occupyExisting({
      targetId,
      accountId: account,
      runId: snapshot.runId,
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      fencingToken: grant.fencingToken,
    })
    const waitGrant = await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: claimed.session.id,
      workerId: WORKER,
      workerInstanceId: WORKER_INSTANCE,
      holdSeconds: 600,
    })
    if (!waitGrant) throw new Error('enter wait failed')
    await forceLeaseExpiresAt(handle.db, waitGrant.leaseId, new Date(Date.now() - 5_000))
    const reaped = await manager.reap()
    expect(reaped.leasesExpired).toBeGreaterThanOrEqual(1)
    const lease = await getLeaseById(handle.db, waitGrant.leaseId)
    expect(lease?.status).toBe('EXPIRED')
    expect(lease?.releaseReason).toBe('auth_wait_holder_lost')
    expect((await getRun(handle.db, snapshot.runId)).status).toBe('RECOVERING')
    expect((await getSessionById(handle.db, claimed.session.id))?.status).toBe('LOST')
  })

  it('SLW05 MAINTENANCE 过期经 reap() 使操作 FAILED', async () => {
    const account = await makeAccount('password', 'slw05')
    const maintInstance = newId()
    const maintWorker = `${WORKER}-slw05`
    await registerWorker(handle.db, {
      workerId: maintWorker,
      instanceId: maintInstance,
      capacity: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS, SESSION_MAINTENANCE_PROTOCOL],
    })
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: account },
      body: { kind: 'PREPARE', idempotencyKey: `slw05-${account}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const claimed = await claimSessionOperation(handle.db, {
      workerId: maintWorker,
      instanceId: maintInstance,
      leaseTtlSeconds: 60,
    })
    expect(claimed?.grant?.leaseId).toBeTruthy()
    if (!claimed?.grant) throw new Error('未领到维护占用')
    await forceLeaseExpiresAt(handle.db, claimed.grant.leaseId, new Date(Date.now() - 5_000))
    const reaped = await manager.reap()
    expect(reaped.leasesExpired).toBeGreaterThanOrEqual(1)
    expect((await getSessionOperation(handle.db, claimed.operation.id))?.status).toBe('FAILED')
    expect((await getLeaseById(handle.db, claimed.grant.leaseId))?.releaseReason).toBe('lease_expired')
  })

  it('SL11 AUTH_DRIVEN 同实例后续 Run 复用会话且不再登录', async () => {
    await handle.db
      .update(targets)
      .set({
        sessionPolicy: {
          reclaim: 'AUTH_DRIVEN',
          keepAliveSeconds: 3600,
          authProbeIntervalSeconds: 900,
        },
      })
      .where(eq(targets.id, targetId))
    const sl11Worker = `${WORKER}-sl11`
    const sl11Instance = newId()
    await registerWorker(handle.db, {
      workerId: sl11Worker,
      instanceId: sl11Instance,
      capacity: 8,
      maxSessions: 8,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS, SESSION_MAINTENANCE_PROTOCOL],
    })
    const sl11 = new BrowserSessionManager(
      handle,
      {
        workerId: sl11Worker,
        workerInstanceId: sl11Instance,
        profileRoot,
        headless: true,
        maxSessions: 8,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await sl11.reconcileOwn()
    const account = await makeAccount('password', 'sl11-reuse')
    await requestMaintenanceOperation(handle.db, {
      key: { targetId, targetAccountId: account },
      body: { kind: 'PREPARE', idempotencyKey: `sl11-${account}-xxxxxxxx` },
      actor: { id: actorId },
    })
    const prepared = await claimSessionOperation(handle.db, {
      workerId: sl11Worker,
      instanceId: sl11Instance,
      leaseTtlSeconds: 60,
    })
    expect(prepared?.session).toBeTruthy()
    const preparedSession = prepared!.session
    await setSessionStatus(handle.db, {
      sessionId: preparedSession.id,
      expectedVersion: preparedSession.version,
      status: 'OPEN',
      ownerWorkerId: sl11Worker,
      ownerWorkerInstanceId: sl11Instance,
    })
    expect(
      await setSessionAuthSummary(handle.db, {
        sessionId: preparedSession.id,
        ownerWorkerId: sl11Worker,
        ownerWorkerInstanceId: sl11Instance,
        authState: 'AUTHENTICATED',
        identityState: 'MATCH',
        lastAuthError: null,
        authProfileRevision: 1,
        observedTier: 'IDENTITY_VERIFIED',
        recordSuccess: true,
      }),
    ).toBe(true)
    if (prepared?.grant) {
      await releaseSessionUse(handle.db, {
        leaseId: prepared.grant.leaseId,
        holderWorkerId: sl11Worker,
        reason: 'prepare_done',
      })
    }
    sl11.installLiveHandleForTest(preparedSession.id, stubBrowserHandle(join(profileRoot, 'sl11')))
    sl11.launchOverride = async () => {
      throw new Error('SL11 不应再 launch')
    }
    const policy = {
      ...DEFAULT_SESSION_POLICY,
      reuse: 'NEW_PAGE' as const,
      reclaim: 'AUTH_DRIVEN' as const,
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    }
    const runFor = async () => {
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: `r-${newId()}`,
        steps: [echoStep],
        actor: { id: actorId },
      })
      const created = await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        targetAccountId: account,
        actor: { id: actorId },
        sessionPolicy: policy,
      })
      await handle.pool.query(
        `UPDATE runs
            SET status = 'CANCELLED',
                finished_at = COALESCE(finished_at, now()),
                updated_at = now()
          WHERE status IN ('QUEUED', 'RECOVERING')
            AND id <> $1`,
        [created.detail.id],
      )
      const grant = await claimRun(handle, {
        workerId: sl11Worker,
        instanceId: sl11Instance,
        leaseTtlSeconds: 30,
      })
      if (!grant || grant.runId !== created.detail.id) throw new Error('claimRun 未领到本 Run')
      return { snapshot: (await getRun(handle.db, created.detail.id)).snapshot, grant }
    }
    const first = await runFor()
    const a = await sl11.acquire(first.snapshot, first.grant)
    expect(a.ok).toBe(true)
    if (!a.ok) throw new Error(a.message ?? a.code)
    expect(a.grant.sessionId).toBe(preparedSession.id)
    await sl11.release(a.grant.leaseId, 'run_done')
    const second = await runFor()
    const b = await sl11.acquire(second.snapshot, second.grant)
    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error(b.message ?? b.code)
    expect(b.grant.sessionId).toBe(preparedSession.id)
    expect((await getSessionById(handle.db, preparedSession.id))?.generation).toBe(preparedSession.generation)
    await sl11.release(b.grant.leaseId, 'run_done')
    const events = await listSessionEvents(handle.db, { key: { targetId, targetAccountId: account }, limit: 50 })
    expect(events.items.filter((event) => event.type === 'auth.attempt_started')).toHaveLength(0)
    sl11.launchOverride = undefined
    await sl11.shutdown()
    await handle.db.update(targets).set({ sessionPolicy: null }).where(eq(targets.id, targetId))
  })

  it('SL14 AUTH_DRIVEN 实例更替后旧行 LOST，保活列仍在且无死租约', async () => {
    const account = await makeAccount('password', 'sl14-lost')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
      reclaimMode: 'AUTH_DRIVEN',
      keepAliveSeconds: 3600,
      authProbeIntervalSeconds: 900,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
      ownerWorkerId: WORKER,
      ownerWorkerInstanceId: WORKER_INSTANCE,
    })
    expect(
      await setSessionAuthSummary(handle.db, {
        sessionId: session.id,
        ownerWorkerId: WORKER,
        ownerWorkerInstanceId: WORKER_INSTANCE,
        authState: 'AUTHENTICATED',
        identityState: 'MATCH',
        lastAuthError: null,
        authProfileRevision: 1,
        observedTier: 'IDENTITY_VERIFIED',
        recordSuccess: true,
      }),
    ).toBe(true)
    const { snapshot, grant } = await makeRunningSnapshot({ targetId, accountId: account })
    await occupyExisting({
      targetId,
      accountId: account,
      runId: snapshot.runId,
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      fencingToken: grant.fencingToken,
    })
    await handle.pool.query(`UPDATE workers SET heartbeat_expires_at = now() - interval '1 second' WHERE id = $1`, [
      WORKER,
    ])
    const freshInstance = newId()
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: freshInstance,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    const fresh = new BrowserSessionManager(
      handle,
      {
        workerId: WORKER,
        workerInstanceId: freshInstance,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await fresh.reconcileOwn()
    const lost = (await getSessionById(handle.db, session.id))!
    expect(lost.status).toBe('LOST')
    expect(lost.closeReason).toBe('owner_instance_replaced')
    expect(lost.reclaimMode).toBe('AUTH_DRIVEN')
    expect(lost.keepAliveUntil).toBeTruthy()
    expect(await findActiveLeaseForSession(handle.db, session.id)).toBeNull()
    await fresh.shutdown()
    await markWorkerStopped(handle.db, WORKER, freshInstance)
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: WORKER_INSTANCE,
      capacity: 32,
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    manager.setWorkerInstance(WORKER_INSTANCE)
  })
})
