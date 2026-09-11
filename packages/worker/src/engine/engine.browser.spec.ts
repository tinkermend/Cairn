import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  acquireSessionLease,
  claimRun,
  computeSnapshotDigest,
  consoleAccounts,
  countFailedRecoveries,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  listRunEvidence,
  markRunWaitingForAuth,
  newId,
  openIsolatedDb,
  registerWorker,
  requestRunCancel,
  releaseSessionLease,
  requireCreatedSession,
  runs,
  sessionLeases,
  setSessionProbe,
  setSessionStatus,
  startAttempt,
  stepRuns,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db'
import {
  DEFAULT_EXECUTOR_VERSIONS,
  PLACEMENT_YIELD_CODES,
  SESSION_CONFIG_ERROR_CODES,
  runSnapshotSchema,
  type BrowserCommand,
  type BrowserCommandResult,
  type SessionErrorCode,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExecutionEngine } from './engine.js'
import type { BrowserPort } from './ports.js'
import { clearPlacementYields, placementYieldExcludes } from '../runtime/placement-backoff.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engb`

const clickTarget = {
  framePath: [],
  candidates: [{ by: 'text' as const, value: '查询' }],
}

function clickStep(id: string, effectType: Step['effectType'] = 'READ_ONLY'): Step {
  return {
    id,
    name: '点击',
    type: 'click',
    effectType,
    input: { target: clickTarget },
  }
}

function echoThenClick(): Step[] {
  return [
    {
      id: newId(),
      name: '先回显',
      type: 'echo',
      effectType: 'READ_ONLY',
      outputKey: 'pre',
      input: { value: 'ready' },
    },
    clickStep(newId()),
  ]
}

describe('ExecutionEngine × BrowserPort（L1）', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'engine-browser',
      email: `engb-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `engb-${SCHEMA.slice(-8)}`,
      name: '浏览器引擎夹具',
      entryUrl: 'https://shop.example.com/',
      loginUrl: 'https://shop.example.com/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '店员',
      username: 'clerk',
      status: 'active',
    })
    workerId = `engb-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      lostAfterSeconds: 60,
    })
  })

  afterEach(() => {
    clearPlacementYields()
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function cancelOtherClaimable(keepRunId?: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND ($1::uuid IS NULL OR id <> $1)`,
      [keepRunId ?? null],
    )
  }

  async function claimThis(runId: string) {
    await cancelOtherClaimable(runId)
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 30,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  async function queue(steps: Step[]) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `browser-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
  }

  async function openLease(runId: string, fencingToken: number): Promise<SessionGrant> {
    const account = newId()
    await handle.db.insert(targetAccounts).values({
      id: account,
      targetId,
      displayName: `lease-${account}`,
      username: `u-${account}`,
      status: 'active',
    })
    const session = await requireCreatedSession(handle.db, {
      key: { targetId, targetAccountId: account },
      ownerWorkerId: workerId,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: session.id,
      expectedVersion: session.version,
      status: 'OPEN',
    })
    await setSessionProbe(handle.db, {
      sessionId: session.id,
      ownerWorkerId: workerId,
      health: 'HEALTHY',
      authState: 'AUTHENTICATED',
    })
    const lease = await acquireSessionLease(handle.db, {
      sessionId: session.id,
      runId,
      holderWorkerId: workerId,
      leaseTtlSeconds: 60,
      runFencingToken: fencingToken,
    })
    expect(lease.ok).toBe(true)
    if (!lease.ok) throw new Error('lease')
    return {
      sessionId: session.id,
      leaseId: lease.lease.id,
      generation: lease.lease.sessionGeneration,
      sessionFencingToken: lease.lease.sessionFencingToken,
      expiresAt: lease.lease.expiresAt.toISOString(),
    }
  }

  function fakePort(hooks: {
    acquire?: BrowserPort['acquire']
    execute?: BrowserPort['execute']
    release?: BrowserPort['release']
  }): BrowserPort & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      acquire: async (run, grant, signal) => {
        calls.push('acquire')
        if (hooks.acquire) return hooks.acquire(run, grant, signal)
        return { ok: false, code: 'BROWSER_UNAVAILABLE', message: 'unset' }
      },
      execute: async (grant, command, signal, evidence) => {
        calls.push('execute')
        if (hooks.execute) return hooks.execute(grant, command, signal, evidence)
        return { ok: true, output: {} }
      },
      release: async (grant, reason) => {
        calls.push('release')
        if (hooks.release) return hooks.release(grant, reason)
      },
    }
  }

  it('含浏览器步骤：acquire 恰好一次且在第一个 startAttempt 之前，结束时 release', async () => {
    const created = await queue(echoThenClick())
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({ ok: true, output: {} }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect(port.calls[0]).toBe('acquire')
    expect(port.calls.filter((item) => item === 'acquire')).toEqual(['acquire'])
    expect(port.calls.filter((item) => item === 'release')).toEqual(['release'])
    expect(port.calls.indexOf('execute')).toBeGreaterThan(port.calls.indexOf('acquire'))
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.pre).toBe('ready')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(1)
  })

  it.each([...PLACEMENT_YIELD_CODES])('acquire %s 走 placement_yield：RECOVERING、无 Attempt、不计恢复', async (code) => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async () => ({ ok: false, code, message: code }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('RECOVERING')
    expect(detail.stepRuns.every((step) => step.attempts.length === 0)).toBe(true)
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(0)
    expect(placementYieldExcludes()).toContain(created.detail.id)
  })

  it('连续三次 SESSION_BUSY 回交不进 NEEDS_REVIEW', async () => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async () => ({ ok: false, code: 'SESSION_BUSY', message: 'busy' }),
    })
    const engine = new ExecutionEngine(handle, port)
    for (let i = 0; i < 3; i++) {
      const grant = await claimThis(created.detail.id)
      await engine.execute(created.detail.id, { grant })
    }
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
    expect((await getRun(handle.db, created.detail.id)).status).not.toBe('NEEDS_REVIEW')
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(0)
  })

  it.each([...SESSION_CONFIG_ERROR_CODES])('acquire %s 真失败，不回交', async (code) => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async () => ({ ok: false, code, message: code }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('FAILED')
    expect(placementYieldExcludes()).not.toContain(created.detail.id)
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(0)
  })

  it('恢复重领已有终态 Attempt 时 SESSION_BUSY 仍可回交', async () => {
    const created = await queue([clickStep(newId())])
    const grant = await claimThis(created.detail.id)
    const detail = await getRun(handle.db, created.detail.id)
    const started = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: detail.stepRuns[0]!.id,
      inputPayload: {},
      grant,
    })
    expect(started).not.toBeNull()
    await handle.pool.query(`UPDATE attempts SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`, [
      started!.attemptId,
    ])
    const recoveries = await countFailedRecoveries(handle.db, created.detail.id)
    const port = fakePort({
      acquire: async () => ({ ok: false, code: 'SESSION_BUSY', message: 'busy' }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('RECOVERING')
    expect(await countFailedRecoveries(handle.db, created.detail.id)).toBe(recoveries)
  })

  it('失败路径也会 release', async () => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () =>
        ({
          ok: false,
          error: {
            code: 'TARGET_NOT_FOUND',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: '未找到',
          },
          diagnostics: {
            outcome: 'NOT_FOUND',
            candidatesTried: [{ index: 0, by: 'text', value: '查询', matches: 0 }],
            framePathResolved: ['main'],
          },
          screenshot: { missingReason: 'storeUnavailable' },
        }) satisfies BrowserCommandResult,
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect(port.calls.filter((item) => item === 'release')).toEqual(['release'])
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('FAILED')
    expect(after.stepRuns[0]?.attempts[0]?.status).toBe('FAILED')
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'error')).toBe(true)
    expect(evidence.items.find((item) => item.type === 'log')?.payload).toEqual({
      outcome: 'NOT_FOUND',
      candidatesTried: [{ index: 0, by: 'text', value: '查询', matches: 0 }],
      framePathResolved: ['main'],
    })
    const shot = evidence.items.find((item) => item.type === 'screenshot')
    expect(shot?.missingReason).toBe('storeUnavailable')
    expect(shot?.objectKey).toBeUndefined()
  })

  it('命令成功后提交前撤租约：READ_ONLY 不写 SUCCEEDED', async () => {
    const created = await queue([clickStep(newId(), 'READ_ONLY')])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (grant) => {
        await releaseSessionLease(handle.db, {
          leaseId: grant.leaseId,
          holderWorkerId: workerId,
          reason: 'test_revoke',
        })
        return { ok: true, output: {} }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.stepRuns[0]?.attempts[0]?.status).toBe('FAILED')
    expect(after.stepRuns[0]?.attempts[0]?.status).not.toBe('SUCCEEDED')
    expect(after.status).toBe('FAILED')
    expect(after.stepRuns[0]?.attempts[0]?.error?.code).toBe('SESSION_LEASE_LOST')
    expect(port.calls).toContain('release')
  })

  it('命令成功后提交前撤租约：SIDE_EFFECT 进 NEEDS_REVIEW', async () => {
    const created = await queue([clickStep(newId(), 'SIDE_EFFECT')])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (grant) => {
        await releaseSessionLease(handle.db, {
          leaseId: grant.leaseId,
          holderWorkerId: workerId,
          reason: 'test_revoke',
        })
        return { ok: true, output: {} }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('NEEDS_REVIEW')
    expect(after.stepRuns[0]?.attempts[0]?.status).toBe('FAILED')
  })

  it('extract 写入 context 供后续 from 使用；assert 失败带 expected/actual', async () => {
    const extractId = newId()
    const fillId = newId()
    const assertId = newId()
    const created = await queue([
      {
        id: extractId,
        name: '提取',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'title',
        input: { target: clickTarget, as: 'text' },
      },
      {
        id: fillId,
        name: '回填',
        type: 'fill',
        effectType: 'IDEMPOTENT',
        input: { target: clickTarget, from: 'title' },
      },
      {
        id: assertId,
        name: '断言',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: { target: clickTarget, expect: { kind: 'text_equals', value: '不对' } },
      },
    ])
    const seen: BrowserCommand[] = []
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (_grant, command): Promise<BrowserCommandResult> => {
        seen.push(command)
        if (command.type === 'extract') return { ok: true, output: { value: '订单标题' } }
        if (command.type === 'fill') return { ok: true, output: {} }
        return {
          ok: false,
          error: {
            code: 'ASSERT_FAILED',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: '断言不成立',
          },
          output: { passed: false, expected: '不对', actual: '订单标题' },
        }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.context.title).toBe('订单标题')
    expect(seen.find((item) => item.type === 'fill')).toMatchObject({ value: '订单标题' })
    expect(after.stepRuns[2]?.attempts[0]?.output).toEqual({
      passed: false,
      expected: '不对',
      actual: '订单标题',
    })
    expect(after.status).toBe('FAILED')
  })

  it('navigate 越出 Target 源时命令带 allowedOrigins，失败不改写成成功', async () => {
    const created = await queue([
      {
        id: newId(),
        name: '外站',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: 'https://evil.example/' },
      },
    ])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (_grant, command) => {
        expect(command.type).toBe('navigate')
        if (command.type === 'navigate') {
          expect(command.allowedOrigins).toContain('https://shop.example.com')
        }
        return {
          ok: false,
          error: {
            code: 'NAVIGATE_OUT_OF_SCOPE',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '越界',
          },
        }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('FAILED')
    expect(after.stepRuns[0]?.attempts[0]?.status).toBe('FAILED')
  })

  it('含 click 的 Snapshot 版本不对则 FAILED；只含 Echo 的不因 click 版本变化失效', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'versions',
      steps: [clickStep(newId())],
      actor: { id: actorId },
    })
    const runId = newId()
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      steps: [clickStep(newId())],
      input: {},
      createdAt: new Date().toISOString(),
      executorVersions: { ...DEFAULT_EXECUTOR_VERSIONS, click: '99' },
    })
    const digest = computeSnapshotDigest(snapshot)
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      createdByConsoleAccountId: actorId,
      status: 'QUEUED',
      snapshot: { ...snapshot, digest },
      snapshotDigest: digest,
      context: {},
    })
    await handle.db.insert(stepRuns).values({
      id: newId(),
      runId,
      stepId: snapshot.steps[0]!.id,
      ordinal: 0,
      status: 'PENDING',
    })
    const port = fakePort({})
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(runId)
    await engine.execute(runId, { grant })
    expect((await getRun(handle.db, runId)).status).toBe('FAILED')
    expect(port.calls).toEqual([])

    const echoOnly = await queue([
      {
        id: newId(),
        name: 'echo',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 1 },
      },
    ])
    expect(echoOnly.detail.snapshot.executorVersions).toEqual({ echo: '1' })
    const echoEngine = new ExecutionEngine(handle)
    const echoGrant = await claimThis(echoOnly.detail.id)
    await echoEngine.execute(echoOnly.detail.id, { grant: echoGrant })
    expect((await getRun(handle.db, echoOnly.detail.id)).status).toBe('SUCCEEDED')
  })

  it('Engine 源码不抄第二份回交 / 配置错误码清单', () => {
    const text = readFileSync(join(__dirname, 'engine.ts'), 'utf8')
    expect(text).not.toMatch(/SESSION_BUSY[\s\S]*SESSION_CAPACITY_EXCEEDED/)
    expect(text).toContain('isPlacementYieldCode')
    expect(text).toContain('isSessionConfigErrorCode')
  })

  it('acquire waitingForAuth：Engine 停手、不 release、Run 保持 WAITING_FOR_AUTH', async () => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async (_run, grant) => {
        await markRunWaitingForAuth(handle.db, grant)
        return {
          ok: false,
          code: 'SESSION_AUTH_UNSUPPORTED' as SessionErrorCode,
          message: '等待目标系统登录',
          waitingForAuth: true,
        }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
    expect(port.calls).toEqual(['acquire'])
  })

  it('浏览器 Run 取消后仍 release', async () => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (_grant, _command, signal): Promise<BrowserCommandResult> => {
        const started = Date.now()
        while (!signal?.aborted && Date.now() - started < 3_000) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return {
          ok: false,
          error: {
            code: 'CANCELLED',
            category: 'CANCELLED',
            retryable: false,
            safeMessage: '步骤已取消',
          },
        }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    const running = engine.execute(created.detail.id, { grant, cancelPollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    await running
    expect((await getRun(handle.db, created.detail.id)).status).toBe('CANCELLED')
    expect(port.calls.filter((item) => item === 'release')).toEqual(['release'])
  })

  it('无残留 ACTIVE 会话租约在失败回交路径', async () => {
    const created = await queue([clickStep(newId())])
    const port = fakePort({
      acquire: async () => ({ ok: false, code: 'SESSION_BUSY' as SessionErrorCode, message: 'busy' }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const leftover = await handle.db
      .select({ id: sessionLeases.id })
      .from(sessionLeases)
      .where(eq(sessionLeases.runId, created.detail.id))
    expect(leftover).toEqual([])
  })
})
