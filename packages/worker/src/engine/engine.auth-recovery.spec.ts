import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { openIsolatedDb, schemaFor, newId, createScenarioWithVersion, createRunWithSnapshot, registerWorker, claimRun, startAttempt, getRun, eq } from '@cairn/db/testing'
import { authGateClosedError, computeContextVersion, resolveEvidencePolicy, type AuthCheckpoint } from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from './engine'
import { systemClock } from './clock'
let db: Awaited<ReturnType<typeof openIsolatedDb>>, input: any, engine: any, recover: ReturnType<typeof vi.fn>
beforeEach(async () => {
  db = await openIsolatedDb(`cairn_auth_recovery_${newId().replaceAll('-', '')}`)
  const tables = schemaFor(db.db), actor = { id: newId() }, targetId = newId()
  await db.db.insert(tables.consoleAccounts).values({ ...actor, email: `${actor.id}@example.com`, displayName: 'tester', status: 'active' })
  await db.db.insert(tables.targets).values({ id: targetId, code: targetId, name: 'target', entryUrl: 'https://app.example/' })
  const step = { id: newId(), type: 'echo' as const, name: 'step', effectType: 'IDEMPOTENT' as const, input: { value: 'ok' } }
  const scenario = await createScenarioWithVersion(db.db, { targetId, name: 'recovery', steps: [step], actor })
  const created = await createRunWithSnapshot(db.db, { scenarioId: scenario.id, actor })
  const workerId = newId(), instanceId = newId()
  await registerWorker(db.db, {
    workerId,
    instanceId,
    capacity: 8,
    lostAfterSeconds: 60,
    protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
  })
  const grant = (await claimRun(db, { workerId, instanceId, leaseTtlSeconds: 60 }))!
  const stepRunId = created.detail.stepRuns[0]!.id
  const attempt = (await startAttempt(db.db, { runId: grant.runId, stepRunId, inputPayload: {}, grant }))!
  recover = vi.fn(async () => ({ ok: true }))
  engine = new ExecutionEngine(db as any, { recoverAuth: recover, describeHold: async () => ({ url: 'https://app.example/' }) } as any)
  input = { runId: grant.runId, grant, step, stepRunId, stepOrdinal: 0, ...attempt, context: {}, input: {}, sessionGrant: { sessionId: newId(), generation: 1 },
    snapshot: { ...created.detail.snapshot, authVerification: { capability: 'IDENTITY_VERIFIED' }, targetAuth: { entryUrl: 'https://app.example/', loginUrl: 'https://app.example/login' }, allowedOrigins: ['https://app.example'], runAuthRecovery: { maxAutoRecoveriesPerRun: 1, maxManualRecoveriesPerRun: 1 } },
    policy: { timeoutMs: 5000, retryLimit: 1 }, last: true, secrets: [], outcome: { kind: 'failed', error: { ...authGateClosedError('not_dispatched'), cause: { code: 'not_dispatched', message: 'EXPIRED' } } }, debugMode: 'runThrough', stop: new AbortController().signal }
})
afterEach(async () => { await db?.close() })
const detail = () => getRun(db.db, input.runId)
const change = async (values: Record<string, unknown>) => { const { runs } = schemaFor(db.db); await db.db.update(runs).set(values).where(eq(runs.id, input.runId)) }
it('未派发恢复新增 Attempt，已关闭 Attempt 保持原样', async () => {
  expect((await engine.handleAuthGate(input)).kind).toBe('retry')
  const row = await detail()
  expect(row.authCheckpoint?.status).toBe('recovered')
  expect(row.stepRuns[0]?.attempts.map(a => a.status)).toEqual(['FAILED', 'RUNNING'])
  expect(row.authCheckpoint?.autoRecoveriesUsed).toBe(1)
})
it('已派发且重试次数用尽，终结 Run 和 StepRun，不执行登录', async () => {
  input.policy.retryLimit = 0; input.outcome.error.cause.code = 'idempotent_failed'
  await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('FAILED'); expect((await detail()).stepRuns[0]?.status).toBe('FAILED'); expect(recover).not.toHaveBeenCalled()
})
it('取消抢先落库时不登录、不写恢复检查点', async () => {
  await change({ cancelRequestedAt: new Date() }); await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('CANCELLED'); expect((await detail()).authCheckpoint).toBeNull(); expect(recover).not.toHaveBeenCalled()
})
it('自动路径要求人工但人工限额为零，明确失败', async () => {
  input.snapshot.runAuthRecovery.maxManualRecoveriesPerRun = 0
  recover.mockResolvedValue({ ok: false, manualRequired: true, code: 'AUTH_AUTO_LOGIN_PAUSED' })
  await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('FAILED'); expect((await detail()).authCheckpoint?.unrecoverableCode).toBe('AUTH_RECOVERY_LIMIT'); expect(recover).toHaveBeenCalledTimes(1)
})
it('转人工先持久化 manual 类别及次数', async () => {
  recover.mockImplementation(async (_grant: unknown, request: any) => {
    if (request.kind === 'auto') return { ok: false, manualRequired: true, code: 'AUTH_NOT_VERIFIED' }
    expect((await detail()).authCheckpoint?.recoveryKind).toBe('manual'); expect((await detail()).authCheckpoint?.manualRecoveriesUsed).toBe(1)
    return { ok: false, waitingForAuth: true }
  })
  expect(await engine.handleAuthGate(input)).toEqual({ kind: 'stop' }); expect(recover).toHaveBeenCalledTimes(2)
})
it('恢复端口异常会终结 Run，不留下 RUNNING 空转', async () => {
  recover.mockRejectedValue(new Error('login disconnected')); await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('FAILED'); expect((await detail()).stepRuns[0]?.status).toBe('FAILED')
})
it('副作用已派发进入核查，绝不重登', async () => {
  input.step.effectType = 'SIDE_EFFECT'; input.outcome.error.cause.code = 'idempotent_failed'; await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('NEEDS_REVIEW'); expect(recover).not.toHaveBeenCalled()
})
it('恢复期间 context 被修改则不能续跑', async () => {
  recover.mockImplementation(async () => { await change({ context: { changed: true } }); return { ok: true } })
  await engine.handleAuthGate(input); expect((await detail()).authCheckpoint?.status).toBe('unrecoverable'); expect((await detail()).status).toBe('FAILED')
})
it('接管 recovering 检查点先验证原 context，不用新值覆盖', async () => {
  const checkpoint: AuthCheckpoint = { schemaVersion: 1, status: 'recovering', closedAt: new Date().toISOString(), trigger: { kind: 'navigated_to_login', at: new Date().toISOString(), summary: '/login' }, nextStepId: input.step.id, nextOrdinal: 0, interruptedClassification: 'not_dispatched', contextVersion: await computeContextVersion({ old: true }), contextKeys: ['old'], sessionGeneration: 1, fencingToken: '1', recoveryRule: { reuse: 'NEW_PAGE', entryUrl: 'https://app.example/', allowedOrigins: ['https://app.example'] }, capability: 'IDENTITY_VERIFIED', recoveryKind: 'auto', autoRecoveriesUsed: 1, manualRecoveriesUsed: 0 }
  await change({ authCheckpoint: checkpoint }); await engine.handleAuthGate(input)
  expect((await detail()).status).toBe('FAILED'); expect(recover).not.toHaveBeenCalled()
})

it('门禁未派发不挤占后续普通失败的重试额度', async () => {
  engine.runExecutor = vi.fn()
    .mockResolvedValueOnce({ ...input.outcome, timedOut: false, aborted: false })
    .mockResolvedValueOnce({ kind: 'failed', error: { code: 'TRANSIENT', category: 'INFRASTRUCTURE', retryable: true, safeMessage: 'temporary' }, timedOut: false, aborted: false })
    .mockResolvedValueOnce({ kind: 'success', output: {}, timedOut: false, aborted: false })
  engine.collectAfterFacts = vi.fn(async () => undefined)
  await engine.completeAttempt({ ...input, clock: systemClock, yielding: () => false, taint: { hung: false }, evidencePolicy: resolveEvidencePolicy({}), mapBudget: { usedMs: 0 } })
  const row = await detail()
  expect(row.status).toBe('SUCCEEDED')
  expect(row.stepRuns[0]?.attempts).toHaveLength(3)
  expect(engine.runExecutor).toHaveBeenCalledTimes(3)
})
