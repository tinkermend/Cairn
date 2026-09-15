import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  acquireSessionLease,
  claimRun,
  enterRunWaitingForAuth,
  createRunWithSnapshot,
  createScenarioWithVersion,
  requireCreatedSession,
  failRunValidation,
  findLiveSession,
  forceLeaseExpiresAt,
  getLeaseById,
  getRun,
  getSessionById,
  newId,
  registerWorker,
  markWorkerStopped,
  openIsolatedDb,
  setSessionStatus,
  sql,
  consoleAccounts,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { DEFAULT_SESSION_POLICY, DEV_CREDENTIAL_KEY, type RunGrant, type RunSnapshot } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { BrowserRuntimeError, type BrowserHandle } from './runtime'
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
function stubBrowserHandle(profileDir: string): BrowserHandle {
  const locator = () => ({
    fill: async () => undefined,
    click: async () => undefined,
    count: async () => 0,
    first: () => ({ isVisible: async () => false }),
    waitFor: async () => undefined,
  })
  const stubPage = () => ({
    evaluate: async () => true,
    goto: async () => undefined,
    url: () => 'http://127.0.0.1/',
    waitForLoadState: async () => undefined,
    waitForFunction: async () => undefined,
    locator,
    isClosed: () => false,
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => ({}),
    close: async () => undefined,
    context: () => ({}),
  })
  return {
    profileDir,
    context: {
      close: async () => undefined,
      browser: () => null,
      pages: () => [],
      newPage: async () => stubPage(),
    },
    basePage: stubPage(),
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
        maxSessions: 2,
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
      lostAfterSeconds: 60,
    })
    await manager.reconcileOwn()
  })

  afterEach(() => {
    clearPlacementYields()
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
      sessionPolicy: { ...DEFAULT_SESSION_POLICY, reuse: 'NEW_PAGE' },
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
      lostAfterSeconds: 60,
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
    await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: run.runId,
      holderWorkerId: WORKER,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
    })

    await handle.pool.query(`UPDATE workers SET heartbeat_expires_at = now() - interval '1 second' WHERE id = $1`, [
      WORKER,
    ])
    const freshInstance = newId()
    await registerWorker(handle.db, {
      workerId: WORKER,
      instanceId: freshInstance,
      capacity: 32,
      lostAfterSeconds: 60,
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
      lostAfterSeconds: 60,
    })
  })

  it('认证超时 reap：WAITING_FOR_AUTH → FAILED，会话仍 OPEN', async () => {
    const account = await makeAccount('manual', 'auth-timeout')
    const session = await requireCreatedSession(handle.db, {
      key: { targetId: manualTargetId, targetAccountId: account },
      ownerWorkerId: WORKER,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    const { snapshot: run, grant } = await makeRunningSnapshot({
      targetId: manualTargetId,
      accountId: account,
    })
    manager.setWorkerInstance(WORKER_INSTANCE)
    await enterRunWaitingForAuth(handle.db, {
      grant,
      sessionId: session.id,
      workerId: WORKER,
      workerInstanceId: WORKER_INSTANCE,
      holdSeconds: 1,
    })
    await handle.db.execute(sql`
      UPDATE browser_sessions SET auth_hold_expires_at = now() - interval '5 seconds'
       WHERE id = ${session.id}
    `)

    const n = await manager.reapAuthTimeouts()
    expect(n).toBeGreaterThanOrEqual(1)
    expect((await getRun(handle.db, run.runId)).status).toBe('FAILED')
    const sess = await getSessionById(handle.db, session.id)
    expect(sess?.status).toBe('OPEN')
    expect(sess?.authHoldWorkerId).toBeNull()
    expect(sess?.authState).toBe('EXPIRED')

    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: (await getSessionById(handle.db, session.id))!.version,
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
    await acquireSessionLease(handle.db, {
      sessionId: busySession.id,
      runId: busyRun.detail.id,
      holderWorkerId: `${WORKER}-evict`,
      leaseTtlSeconds: 30,
      runFencingToken: 1,
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
      await acquireSessionLease(handle.db, {
        sessionId: session.id,
        runId: run.detail.id,
        holderWorkerId: `${WORKER}-full`,
        leaseTtlSeconds: 30,
        runFencingToken: 1,
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
})
