import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import {
  acquireSessionLease,
  claimAuthHold,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createSession,
  forceLeaseExpiresAt,
  getLeaseById,
  getRun,
  getSessionById,
  markRunWaitingForAuth,
  newId,
  openIsolatedDb,
  setSessionStatus,
  sql,
  consoleAccounts,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db'
import { DEFAULT_SESSION_POLICY, DEV_CREDENTIAL_KEY } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { BrowserSessionManager, SessionLeaseError } from './session-manager'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_bsm`
const WORKER = `bsm-worker-${Date.now().toString(36)}`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'x' },
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
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    await manager.reconcileOwn()
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
  }) {
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
    await handle.db.execute(
      sql`UPDATE runs SET status = 'RUNNING', started_at = now() WHERE id = ${created.detail.id}`,
    )
    return (await getRun(handle.db, created.detail.id)).snapshot
  }

  it('无 targetAccountId → SESSION_ACCOUNT_REQUIRED', async () => {
    const run = await makeRunningSnapshot({ targetId, accountId })
    const { targetAccountId: _, ...noAccount } = run
    const result = await manager.acquire(noAccount as typeof run)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SESSION_ACCOUNT_REQUIRED')
  })

  it('manual 认证：有浏览器时 WAITING_FOR_AUTH + 认证占用', async () => {
    const account = await makeAccount('manual', 'manual-auth')
    const run = await makeRunningSnapshot({ targetId: manualTargetId, accountId: account })
    const result = await manager.acquire(run)
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
    const run = await makeRunningSnapshot({ targetId, accountId: account })
    manager.resolveCredential = async () => ({ username: 'alice', password: 'x' })
    const result = await manager.acquire(run)
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
    const limited = new BrowserSessionManager(
      handle,
      {
        workerId: `${WORKER}-cap`,
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
    const run1 = await makeRunningSnapshot({ targetId, accountId: capA })
    const run2 = await makeRunningSnapshot({ targetId, accountId: capB })
    const a = await limited.acquire(run1)
    if (!a.ok) {
      expect(['BROWSER_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'PROFILE_LOCKED']).toContain(a.code)
      await limited.shutdown()
      return
    }
    const b = await limited.acquire(run2)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe('SESSION_CAPACITY_EXCEEDED')
    await limited.release(a.grant.leaseId, 'done')
    await limited.shutdown()
  })

  it('重启自愈清掉名下 OPEN 会话', async () => {
    const account = await makeAccount('password', 'restart')
    const session = await createSession(handle.db, {
      key: { targetId, targetAccountId: account },
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
    const run = await makeRunningSnapshot({ targetId, accountId: account })
    await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId: run.runId,
      holderWorkerId: WORKER,
      leaseTtlSeconds: 30,
    })

    const fresh = new BrowserSessionManager(
      handle,
      {
        workerId: WORKER,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 30,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretProvider,
    )
    const result = await fresh.reconcileOwn()
    expect(result.sessionsClosed).toBeGreaterThanOrEqual(1)
    expect((await getSessionById(handle.db, session.id))?.status).toBe('CLOSED')
    await fresh.shutdown()
  })

  it('认证超时 reap：WAITING_FOR_AUTH → FAILED，会话仍 OPEN', async () => {
    const account = await makeAccount('manual', 'auth-timeout')
    const session = await createSession(handle.db, {
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
    await claimAuthHold(handle.db, {
      sessionId: session.id,
      workerId: WORKER,
      holdSeconds: 1,
    })
    await handle.db.execute(sql`
      UPDATE browser_sessions SET auth_hold_expires_at = now() - interval '5 seconds'
       WHERE id = ${session.id}
    `)

    const run = await makeRunningSnapshot({
      targetId: manualTargetId,
      accountId: account,
    })
    await markRunWaitingForAuth(handle.db, run.runId)

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
})
