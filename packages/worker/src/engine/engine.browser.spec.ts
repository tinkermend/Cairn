import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  claimSessionUse,
  claimRun,
  computeSnapshotDigest,
  consoleAccounts,
  countFailedRecoveries,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  saveScenarioDraft,
  eq,
  getRun,
  markRunWaitingForAuth,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  requestRunCancel,
  releaseSessionUse,
  requireCreatedSession,
  runs,
  sessionLeases,
  targetAuthProfiles,
  setSessionProbe,
  setSessionStatus,
  startAttempt,
  stepRuns,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEFAULT_EXECUTOR_VERSIONS,
  computeContextVersion,
  PLACEMENT_YIELD_CODES,
  SESSION_CONFIG_ERROR_CODES,
  runSnapshotSchema,
  targetAuthProfileDefinitionSchema,
  type AuthCheckpoint,
  type BrowserCommand,
  type BrowserCommandResult,
  type SessionErrorCode,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine.js'
import type { BrowserPort } from './ports.js'
import { clearPlacementYields, placementYieldExcludes } from '../runtime/placement-backoff.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_engb`

const clickTarget = {
  framePath: [],
  candidates: [{ by: 'text' as const, value: '查询' }],
}

function clickStep(id: string, effectType: Step['effectType'] = 'READ_ONLY'): Extract<Step, { type: 'click' }> {
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
      maxSessions: 32,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
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

  let authProfileRevision = 0

  async function setSharedCapability(capability: 'IDENTITY_VERIFIED' | 'LOGIN_VERIFIED') {
    authProfileRevision += 1
    const definition = targetAuthProfileDefinitionSchema.parse({
      verify: {
        mode: 'http',
        success: { status: 200, jsonPath: '$.ok', equals: true },
        failure: { status: 401 },
      },
      ...(capability === 'IDENTITY_VERIFIED'
        ? { identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' } }
        : {}),
      scope: { origins: ['https://shop.example.com'], pathPrefixes: ['/'] },
    })
    const observation = (
      authState: 'AUTHENTICATED' | 'EXPIRED',
      identityState: 'MATCH' | 'MISMATCH' | 'UNVERIFIED',
      observedIdentity: string | null,
    ) => ({
      authState,
      identityState,
      observedIdentity,
      unknownClass: null,
      evidenceSummary: 'seed',
      authProfileRevision,
      diagnosticCode: 'verified',
    })
    await handle.db.insert(targetAuthProfiles).values({
      id: newId(),
      targetId,
      revision: authProfileRevision,
      definition,
      digest: `d${authProfileRevision}`.padEnd(64, 'd'),
      validation: {
        recordedAt: '2026-09-16T00:00:00.000Z',
        actorId,
        operationId: newId(),
        steps: {
          valid_pass: observation('AUTHENTICATED', 'MATCH', 'alice'),
          server_revoked: observation('EXPIRED', 'UNVERIFIED', null),
          ...(capability === 'IDENTITY_VERIFIED'
            ? { other_account: observation('AUTHENTICATED', 'MISMATCH', 'bob') }
            : {}),
        },
      },
    })
    await handle.db
      .update(targets)
      .set({ currentAuthProfileRevision: authProfileRevision })
      .where(eq(targets.id, targetId))
    await handle.db
      .update(targetAccounts)
      .set({ expectedIdentity: capability === 'IDENTITY_VERIFIED' ? 'alice' : null })
      .where(eq(targetAccounts.id, accountId))
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
      ownerWorkerInstanceId: workerInstanceId,
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
    const lease = await claimSessionUse(handle.db, {
      key: { targetId, targetAccountId: account },
      owner: { kind: 'RUN', runId, runFencingToken: fencingToken },
      purpose: 'EXECUTION',
      holderWorkerId: workerId,
      holderInstanceId: workerInstanceId,
      leaseTtlSeconds: 60,
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    if (!lease.ok) throw new Error(lease.message ?? lease.code)
    return {
      sessionId: session.id,
      leaseId: lease.grant.leaseId,
      generation: lease.grant.generation,
      sessionFencingToken: lease.grant.sessionFencingToken,
      expiresAt: lease.grant.expiresAt,
    }
  }

  function fakePort(hooks: {
    acquire?: BrowserPort['acquire']
    execute?: BrowserPort['execute']
    release?: BrowserPort['release']
    describeHold?: BrowserPort['describeHold']
    recoverAuth?: BrowserPort['recoverAuth']
    restoreAuthGate?: BrowserPort['restoreAuthGate']
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
      describeHold: hooks.describeHold
        ? async (runId) => {
            calls.push('describeHold')
            return hooks.describeHold!(runId)
          }
        : undefined,
      recoverAuth: hooks.recoverAuth
        ? async (grant, input) => {
            calls.push('recoverAuth')
            return hooks.recoverAuth!(grant, input)
          }
        : undefined,
      restoreAuthGate: hooks.restoreAuthGate
        ? async (runId, grant) => {
            calls.push('restoreAuthGate')
            return hooks.restoreAuthGate!(runId, grant)
          }
        : undefined,
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
        await releaseSessionUse(handle.db, {
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
        await releaseSessionUse(handle.db, {
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

  it('popup 交接失败：点击已发出，SIDE_EFFECT 进 NEEDS_REVIEW 且不重试', async () => {
    const created = await queue([
      {
        ...clickStep(newId(), 'SIDE_EFFECT'),
        input: { target: clickTarget, pageAfter: 'popup' },
      },
    ])
    let executes = 0
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => {
        executes += 1
        return {
          ok: false,
          error: {
            code: 'PAGE_HANDOFF_NO_POPUP',
            category: 'UNKNOWN',
            retryable: false,
            safeMessage: '点击后没有出现可交接的弹出窗口',
          },
        }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    await engine.execute(created.detail.id, { grant })
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('NEEDS_REVIEW')
    expect(executes).toBe(1)
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

  it('fill.from 遇到对象会 JSON.stringify（P9 已知缺口，D0 不修）', async () => {
    const created = await queue([
      {
        id: newId(),
        name: '对象输出',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'extracted',
        input: { value: { orderNo: 'SO-1' } },
      },
      {
        id: newId(),
        name: '回填',
        type: 'fill',
        effectType: 'IDEMPOTENT',
        input: { target: clickTarget, from: 'extracted' },
      },
    ])
    let fillValue: unknown
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (_grant, command): Promise<BrowserCommandResult> => {
        if (command.type === 'fill') fillValue = command.value
        return { ok: true, output: {} }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    expect(fillValue).toBe(JSON.stringify({ orderNo: 'SO-1' }))
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

  it('fill.sensitive 的明文不进证据；tokenCount 不被误伤', async () => {
    const fill: Step = {
      id: newId(),
      name: '填写',
      type: 'fill',
      effectType: 'IDEMPOTENT',
      input: {
        target: clickTarget,
        value: 'hunter2-plain',
        sensitive: true,
      },
    }
    const extract: Step = {
      id: newId(),
      name: '提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'tokenCount',
      input: {
        target: clickTarget,
        as: 'text',
      },
    }
    const created = await queue([fill, extract])
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async (_grant, command): Promise<BrowserCommandResult> => {
        if (command.type === 'extract') return { ok: true, output: { value: 3, tokenCount: 3 } }
        return { ok: true, output: {} }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const dumped = JSON.stringify(await listRunEvidence(handle.db, created.detail.id))
    expect(dumped).not.toContain('hunter2-plain')
    expect(dumped).toContain('[redacted]')
    expect(dumped).toContain('tokenCount')
  })

  it('显式 screenshot:off 不产生截图证据', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `off-${newId()}`,
      steps: [clickStep(newId())],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      evidencePolicy: { screenshot: 'off' },
      actor: { id: actorId },
    })
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: '未找到',
        },
      }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    expect(evidence.items.some((item) => item.type === 'screenshot')).toBe(false)
  })

  it('试跑失败进入 HOLDING：不 release、不 SKIPPED，再试后继续同一会话', async () => {
    const steps = [clickStep(newId(), 'READ_ONLY'), clickStep(newId(), 'READ_ONLY')]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `hold-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps },
    })
    const created = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    expect(created.detail.debugMode).toBe('holdOnFailure')
    let attempts = 0
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => {
        attempts += 1
        if (attempts === 1) {
          return {
            ok: false,
            error: {
              code: 'TARGET_NOT_FOUND',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: '未找到',
            },
          }
        }
        return { ok: true, output: {} }
      },
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    const done = engine.execute(created.detail.id, { grant })
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).status).toBe('HOLDING')
    })
    const held = await getRun(handle.db, created.detail.id)
    expect(held.stepRuns[0]?.status).toBe('FAILED')
    expect(held.stepRuns[1]?.status).toBe('PENDING')
    expect(port.calls.filter((item) => item === 'release')).toEqual([])
    await engine.resumeDebug(
      created.detail.id,
      { action: 'retry_current', fencingToken: held.checkpoint?.fencingToken },
      actorId,
    )
    await done
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('SUCCEEDED')
    expect(after.stepRuns[0]?.attempts.length).toBe(2)
    expect(after.stepRuns.some((item) => item.status === 'SKIPPED')).toBe(false)
    expect(port.calls.filter((item) => item === 'release')).toEqual(['release'])
    expect(port.calls.filter((item) => item === 'acquire')).toEqual(['acquire'])
  })

  it('暂停在未跑步上后 continue 不会跳过当前步', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '第一步',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'first',
        input: { value: 'one' },
      },
      {
        id: newId(),
        name: '第二步',
        type: 'echo',
        effectType: 'READ_ONLY',
        outputKey: 'second',
        input: { value: 'two' },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `pause-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps },
    })
    const created = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    const engine = new ExecutionEngine(handle)
    const grant = await claimThis(created.detail.id)
    expect(engine.holds.resume(created.detail.id, { action: 'pause', actorId })).toBe(true)
    const done = engine.execute(created.detail.id, { grant })
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).status).toBe('HOLDING')
    })
    const held = await getRun(handle.db, created.detail.id)
    expect(held.stepRuns[0]?.status).toBe('PENDING')
    await engine.resumeDebug(
      created.detail.id,
      { action: 'continue', fencingToken: held.checkpoint?.fencingToken },
      actorId,
    )
    await done
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('SUCCEEDED')
    expect(after.context.first).toBe('one')
    expect(after.context.second).toBe('two')
    expect(after.stepRuns.every((item) => item.status === 'SUCCEEDED')).toBe(true)
  })

  it('副作用步骤再试必须确认，否则拒绝且不新开 Attempt', async () => {
    const steps = [clickStep(newId(), 'SIDE_EFFECT')]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `side-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps },
    })
    const created = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          category: 'VALIDATION',
          retryable: false,
          safeMessage: '未找到',
        },
      }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    const done = engine.execute(created.detail.id, { grant })
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).status).toBe('HOLDING')
    })
    const held = await getRun(handle.db, created.detail.id)
    await expect(
      engine.resumeDebug(
        created.detail.id,
        { action: 'retry_current', fencingToken: held.checkpoint?.fencingToken },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'SIDE_EFFECT_CONFIRM_REQUIRED' })
    expect((await getRun(handle.db, created.detail.id)).stepRuns[0]?.attempts).toHaveLength(1)
    await engine.resumeDebug(
      created.detail.id,
      { action: 'retry_current', fencingToken: held.checkpoint?.fencingToken, confirmSideEffect: true },
      actorId,
    )
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).stepRuns[0]?.attempts.length).toBe(2)
    })
    await engine.resumeDebug(created.detail.id, { action: 'stop' }, actorId)
    await done
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('FAILED')
    expect(after.stepRuns[0]?.attempts.length).toBe(2)
  })

  it('成功 Hold 后 continue 进入下一步，快照步骤不被截断', async () => {
    const steps = [clickStep(newId(), 'READ_ONLY'), clickStep(newId(), 'READ_ONLY')]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `hold-each-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps },
    })
    const created = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      targetAccountId: accountId,
      actor: { id: actorId },
      debugMode: 'holdAfterEach',
    })
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({ ok: true, output: {} }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    const done = engine.execute(created.detail.id, { grant })
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).status).toBe('HOLDING')
    })
    const held = await getRun(handle.db, created.detail.id)
    expect(held.checkpoint?.reason).toBe('step_succeeded')
    expect(held.snapshot.steps).toHaveLength(2)
    expect(held.stepRuns[1]?.status).toBe('PENDING')
    await engine.resumeDebug(
      created.detail.id,
      { action: 'continue', fencingToken: held.checkpoint?.fencingToken },
      actorId,
    )
    await vi.waitFor(async () => {
      const next = await getRun(handle.db, created.detail.id)
      expect(next.status).toBe('HOLDING')
      expect(next.stepRuns[1]?.status).toBe('SUCCEEDED')
    })
    const second = await getRun(handle.db, created.detail.id)
    await engine.resumeDebug(
      created.detail.id,
      { action: 'continue', fencingToken: second.checkpoint?.fencingToken },
      actorId,
    )
    await done
    const after = await getRun(handle.db, created.detail.id)
    expect(after.status).toBe('SUCCEEDED')
    expect(after.snapshot.steps).toHaveLength(2)
    expect(after.stepRuns.every((item) => item.status === 'SUCCEEDED')).toBe(true)
  })

  it('检查点页变后未确认不能再试', async () => {
    const pageRef = {
      sessionId: '00000000-0000-4000-8000-0000000000aa',
      sessionGeneration: 1,
      pageId: '00000000-0000-4000-8000-0000000000ab',
      documentEpoch: 1,
    }
    let epoch = 1
    const steps = [clickStep(newId(), 'READ_ONLY')]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `page-ack-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
      document: { schemaVersion: 1, inputs: [], steps },
    })
    const created = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 2,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          category: 'VALIDATION',
          retryable: false,
          safeMessage: '未找到',
        },
      }),
      describeHold: async () => ({
        pageRef: { ...pageRef, documentEpoch: epoch },
        url: epoch === 1 ? 'https://shop.example/a' : 'https://shop.example/b',
      }),
    })
    const engine = new ExecutionEngine(handle, port)
    const grant = await claimThis(created.detail.id)
    const done = engine.execute(created.detail.id, { grant })
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).status).toBe('HOLDING')
    })
    const held = await getRun(handle.db, created.detail.id)
    expect(held.checkpoint?.url).toBe('https://shop.example/a')
    epoch = 2
    await expect(
      engine.resumeDebug(
        created.detail.id,
        { action: 'retry_current', fencingToken: held.checkpoint?.fencingToken },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'PAGE_CHANGED_ACK_REQUIRED' })
    expect((await getRun(handle.db, created.detail.id)).stepRuns[0]?.attempts).toHaveLength(1)
    await engine.resumeDebug(
      created.detail.id,
      { action: 'retry_current', fencingToken: held.checkpoint?.fencingToken, pageChangedAck: true },
      actorId,
    )
    await vi.waitFor(async () => {
      expect((await getRun(handle.db, created.detail.id)).stepRuns[0]?.attempts.length).toBe(2)
    })
    await engine.resumeDebug(created.detail.id, { action: 'stop' }, actorId)
    await done
  })

  it('认证等待期间调试命令返回 RUN_WAITING_FOR_AUTH（SM17D）', async () => {
    const created = await queue(echoThenClick())
    await handle.db.update(runs).set({ status: 'WAITING_FOR_AUTH' }).where(eq(runs.id, created.detail.id))
    const engine = new ExecutionEngine(handle)
    await expect(
      engine.resumeDebug(created.detail.id, { action: 'continue', fencingToken: '1' }, actorId),
    ).rejects.toMatchObject({ code: 'RUN_WAITING_FOR_AUTH' })
  })

  it('旧模式收到门禁关闭则无法安全续跑，不调用 recoverAuth（SM42）', async () => {
    const created = await queue([clickStep(newId())])
    expect(created.detail.snapshot.authVerification?.capability ?? 'LEGACY').toBe('LEGACY')
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'AUTH_GATE_CLOSED',
          category: 'INFRASTRUCTURE',
          retryable: false,
          safeMessage: '登录已失效',
          cause: { code: 'not_dispatched', message: 'EXPIRED' },
        },
      }),
      recoverAuth: async () => ({ ok: true }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('FAILED')
    expect(detail.authCheckpoint?.status).toBe('unrecoverable')
    expect(port.calls).not.toContain('recoverAuth')
  })

  it('SIDE_EFFECT 已派发后认证门禁关闭进入核查（SM15）', async () => {
    await setSharedCapability('IDENTITY_VERIFIED')
    const created = await queue([clickStep(newId(), 'SIDE_EFFECT')])
    expect(created.detail.snapshot.authVerification?.capability).toBe('IDENTITY_VERIFIED')
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'AUTH_GATE_CLOSED',
          category: 'UNKNOWN',
          retryable: false,
          safeMessage: '登录已失效',
          cause: { code: 'dispatched', message: 'EXPIRED' },
        },
      }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('NEEDS_REVIEW')
    expect(detail.authCheckpoint?.interruptedClassification).toBe('side_effect_dispatched')
    expect(port.calls).not.toContain('recoverAuth')
  })

  it('LOGIN_VERIFIED 关门后失败且不重登（SM42）', async () => {
    await setSharedCapability('LOGIN_VERIFIED')
    const created = await queue([clickStep(newId())])
    expect(created.detail.snapshot.authVerification?.capability).toBe('LOGIN_VERIFIED')
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => ({
        ok: false,
        error: {
          code: 'AUTH_GATE_CLOSED',
          category: 'INFRASTRUCTURE',
          retryable: false,
          safeMessage: '登录已失效',
          cause: { code: 'not_dispatched', message: 'EXPIRED' },
        },
      }),
      recoverAuth: async () => ({ ok: true }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('FAILED')
    expect(detail.authCheckpoint?.unrecoverableCode).toBe('AUTH_CONTEXT_NOT_RECOVERABLE')
    expect(port.calls).not.toContain('recoverAuth')
  })

  it('IDENTITY_VERIFIED 自动恢复后不占重试次数继续原步骤（SM14/SM42）', async () => {
    await setSharedCapability('IDENTITY_VERIFIED')
    const created = await queue([clickStep(newId())])
    expect(created.detail.snapshot.authVerification?.capability).toBe('IDENTITY_VERIFIED')
    let executes = 0
    const port = fakePort({
      acquire: async (_run, grant) => ({ ok: true, grant: await openLease(created.detail.id, grant.fencingToken) }),
      execute: async () => {
        executes += 1
        if (executes === 1) {
          return {
            ok: false,
            error: {
              code: 'AUTH_GATE_CLOSED',
              category: 'INFRASTRUCTURE',
              retryable: false,
              safeMessage: '登录已失效',
              cause: { code: 'not_dispatched', message: 'EXPIRED' },
            },
          }
        }
        return { ok: true, output: {} }
      },
      recoverAuth: async () => ({ ok: true }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant: await claimThis(created.detail.id) })
    const detail = await getRun(handle.db, created.detail.id)
    expect(port.calls).toContain('recoverAuth')
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.authCheckpoint?.status).toBe('recovered')
    expect(detail.stepRuns[0]?.attempts).toHaveLength(2)
  })

  it('进行中的自动恢复不重复计数', async () => {
    await setSharedCapability('IDENTITY_VERIFIED')
    const created = await queue([clickStep(newId())])
    const grant = await claimThis(created.detail.id)
    const recovering: AuthCheckpoint = {
      schemaVersion: 1,
      status: 'recovering',
      closedAt: '2026-09-16T04:00:00.000Z',
      trigger: { kind: 'navigated_to_login', at: '2026-09-16T04:00:00.000Z', summary: '/login' },
      nextStepId: created.detail.snapshot.steps[0]!.id,
      nextOrdinal: 0,
      interruptedClassification: 'not_dispatched',
      contextVersion: await computeContextVersion(created.detail.context),
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant.fencingToken),
      recoveryRule: {
        reuse: 'NEW_PAGE',
        entryUrl: 'https://shop.example.com/',
        allowedOrigins: ['https://shop.example.com'],
      },
      capability: 'IDENTITY_VERIFIED',
      autoRecoveriesUsed: 1,
      manualRecoveriesUsed: 0,
      recoveryKind: 'auto',
    }
    await handle.db.update(runs).set({ authCheckpoint: recovering }).where(eq(runs.id, created.detail.id))
    let executes = 0
    const port = fakePort({
      acquire: async (_run, runGrant) => ({ ok: true, grant: await openLease(created.detail.id, runGrant.fencingToken) }),
      execute: async () => {
        executes += 1
        if (executes === 1) {
          return {
            ok: false,
            error: {
              code: 'AUTH_GATE_CLOSED',
              category: 'INFRASTRUCTURE',
              retryable: false,
              safeMessage: '登录已失效',
              cause: { code: 'not_dispatched', message: 'EXPIRED' },
            },
          }
        }
        return { ok: true, output: {} }
      },
      recoverAuth: async () => ({ ok: true }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant })
    const detail = await getRun(handle.db, created.detail.id)
    expect(port.calls).toContain('recoverAuth')
    expect(detail.authCheckpoint?.autoRecoveriesUsed).toBe(1)
    expect(detail.status).toBe('SUCCEEDED')
  })

  it('重启后 recovering 检查点先 restoreAuthGate，第一次派发不发浏览器命令', async () => {
    await setSharedCapability('IDENTITY_VERIFIED')
    const created = await queue([clickStep(newId())])
    const grant = await claimThis(created.detail.id)
    const recovering: AuthCheckpoint = {
      schemaVersion: 1,
      status: 'recovering',
      closedAt: '2026-09-16T04:00:00.000Z',
      trigger: { kind: 'navigated_to_login', at: '2026-09-16T04:00:00.000Z', summary: '/login' },
      nextStepId: created.detail.snapshot.steps[0]!.id,
      nextOrdinal: 0,
      interruptedClassification: 'not_dispatched',
      contextVersion: await computeContextVersion(created.detail.context),
      contextKeys: [],
      sessionGeneration: 1,
      fencingToken: String(grant.fencingToken),
      recoveryRule: {
        reuse: 'NEW_PAGE',
        entryUrl: 'https://shop.example.com/',
        allowedOrigins: ['https://shop.example.com'],
      },
      capability: 'IDENTITY_VERIFIED',
      autoRecoveriesUsed: 1,
      manualRecoveriesUsed: 0,
      recoveryKind: 'auto',
    }
    await handle.db.update(runs).set({ authCheckpoint: recovering }).where(eq(runs.id, created.detail.id))
    const port = fakePort({
      acquire: async (_run, runGrant) => ({ ok: true, grant: await openLease(created.detail.id, runGrant.fencingToken) }),
      restoreAuthGate: async () => true,
      execute: async () => ({ ok: true, output: {} }),
      recoverAuth: async () => ({ ok: true }),
    })
    const engine = new ExecutionEngine(handle, port)
    await engine.execute(created.detail.id, { grant })
    expect(port.calls.filter((item) => item === 'restoreAuthGate')).toEqual(['restoreAuthGate'])
    expect(port.calls.indexOf('restoreAuthGate')).toBeLessThan(port.calls.indexOf('recoverAuth'))
    expect(port.calls.filter((item) => item === 'execute')).toHaveLength(1)
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.authCheckpoint?.status).toBe('recovered')
  })
})
