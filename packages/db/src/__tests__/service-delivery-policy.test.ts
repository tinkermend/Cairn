import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createAccountBodySchema,
  createTargetBodySchema,
  serviceCallerBodySchema,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { openContractDb, DRIVERS } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'
import { listOperationAuditEvents } from '../audit/list.js'

const handles: DbHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.close()
})

const testStep: Step = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: '业务步骤',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'test-value' },
}

async function createStoredObject(db: api.Db, runId: string) {
  const object = await api.reserveStoredObject(db, {
    runId,
    retainUntil: new Date(Date.now() + 3600000),
  })
  await api.commitStoredObject(db, {
    id: object.id,
    contentType: 'image/png',
    byteSize: 100,
    digest: 'sha256:' + 'a'.repeat(64),
  })
  return object
}

async function fixture(
  driver: (typeof DRIVERS)[number],
  deliveryPolicy = {
    runOutput: true,
    finalScreenshot: true,
    failureScreenshot: true,
  },
) {
  const h = await openContractDb(driver)
  handles.push(h)
  const db = expose(h)

  const rbac = new api.RbacStore(db, {
    hash: async (s: string) => s,
    verify: async (s: string, hash: string) => s === hash,
  })
  const adminRole = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: 'delivery-admin',
      displayName: '交付测试管理员',
      password: 'test-password',
      roleIds: [adminRole.id],
    }),
    null,
  )

  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: 'delivery-target',
      name: '交付目标',
      entryUrl: 'https://example.com',
    }),
    actor,
  )

  const caller = await api.saveServiceCaller(
    db,
    null,
    serviceCallerBodySchema.parse({
      name: '自动化调用方',
      owner: 'team-auto',
      status: 'active',
      requestsPerMinute: 60,
      maxOutstandingRuns: 5,
      runTimeoutSeconds: 600,
      deliveryPolicy,
    }),
    actor,
  )

  const cred = await api.issueServiceCredential(
    db,
    caller.caller.id,
    {
      name: '主凭据',
      scopes: ['run:execute', 'run:read', 'evidence:read'],
      grants: [{ targetId: target.id, allowAnonymous: true, accountIds: [] }],
      expiresInDays: 90,
    },
    actor,
  )

  const principal = await api.authenticateService(db, `Bearer ${cred.token}`)

  const scenario = await api.createScenarioWithVersion(
    db,
    {
      targetId: target.id,
      name: '交付巡检场景',
      steps: [testStep],
      outputs: {
        metrics: [{ key: 'item_count', name: '商品数', fromContextKey: 'count', unit: '件' }],
        summaryTemplate: '巡检完成，在售商品 ${item_count}',
        dataRowFields: [{ columnKey: 'status_col', columnHeader: '状态', fromContextKey: 'status' }],
      },
      actor,
    },
  )

  const versions = await api.listScenarioVersions(db, scenario.id)
  const scenarioVersionId = versions.items[0]!.id

  return {
    db,
    handle: h,
    actor,
    target,
    caller: caller.caller,
    principal,
    scenario,
    scenarioVersionId,
  }
}

describe.each(DRIVERS)('%s 服务自动化调用交付与证据策略分级测试', (driver) => {
  it('SD01-SD03: 调用方配置并冻结 deliveryPolicy，且 publicRun 与 Webhook 交付声明的 runOutput，逐步 output 保持未发布', async () => {
    const f = await fixture(driver, {
      runOutput: true,
      finalScreenshot: true,
      failureScreenshot: true,
    })

    // 注册 webhook 监听 run.completed
    const sealedSecret = { id: api.newId(), ciphertext: Buffer.from('sealed-secret') }
    await api.saveServiceWebhook(
      f.db,
      f.caller.id,
      {
        url: 'https://webhook.example.com/callback',
        events: ['run.completed'],
        enabled: true,
        secret: 'test-secret',
      },
      f.actor,
      sealedSecret,
    )

    const run = await api.createServiceRun(
      f.db,
      f.principal,
      {
        scenarioId: f.scenario.id,
        scenarioVersionId: f.scenarioVersionId,
        idempotencyKey: 'idemp-deliv-1',
      },
      'req-deliv-1',
    )

    // 1. 快照冻结验证
    const runRow = await api.getRun(f.db, run.detail.id)
    expect(runRow.snapshot.serviceDelivery).toEqual({
      runOutput: true,
      finalScreenshot: true,
      failureScreenshot: true,
    })

    // 2. 模拟完成运行并沉淀业务结果
    const worker = await seedWorker(f.handle)
    const grant = await forceGrantForRun(f.handle, run.detail.id, worker.workerId)
    const { stepRuns, evidences } = schemaFor(f.handle.db)
    const [step] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, run.detail.id))
    const started = await api.startAttempt(f.db, {
      runId: run.detail.id,
      stepRunId: step!.id,
      inputPayload: { value: 'val' },
      grant,
    })

    await api.finishAttempt(f.db, {
      runId: run.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { count: 42, status: 'NORMAL' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })

    // 注入一条未经人工放行的内部步骤 output 证据
    await f.handle.db.insert(evidences).values({
      id: api.newId(),
      runId: run.detail.id,
      stepRunId: step!.id,
      attemptId: started!.attemptId,
      type: 'output',
      status: 'available',
      externalAccess: 0,
      createdAt: new Date(),
      payload: { internal_debug_info: 'secret-trace' },
    })

    const { runs } = schemaFor(f.handle.db)
    await f.handle.db
      .update(runs)
      .set({ context: { count: 42, status: 'NORMAL' }, finishedAt: new Date() })
      .where(eq(runs.id, run.detail.id))

    // 3. 结算 run output
    await api.settleRunOutput(f.db, run.detail.id)

    // 4. 调用 openAPI GET /open/v1/runs/:id (publicRun with results = true)
    const published = await api.getServiceRun(f.db, f.principal, run.detail.id)
    expect(published.runOutput).toBeDefined()
    expect(published.runOutput?.status).toBe('NORMAL')
    expect(published.runOutput?.metrics).toEqual({ item_count: 42 })
    expect(published.runOutput?.dataRow).toEqual({ status_col: 'NORMAL' })
    expect(published.runOutput?.summary).toBe('巡检完成，在售商品 42')

    // 验证逐步未发布的 output 依然为 null（不泄露）
    expect(published.stepRuns[0]?.attempts[0]?.output).toBeNull()

    // 5. 验证 Webhook 投递 payload 中的 runOutput 自动挂载，且 outputs 保持空
    const enqueueResult = await api.enqueueServiceWebhookDeliveries(f.db, { limit: 10 })
    expect(enqueueResult.inserted).toBeGreaterThan(0)

    const deliveries = await api.listServiceWebhookDeliveries(
      f.db,
      f.caller.id,
      { limit: 10 },
      f.actor,
    )
    const finishedDelivery = deliveries.items.find((d) => d.eventType === 'run.completed')
    expect(finishedDelivery).toBeDefined()
    expect(finishedDelivery?.payload.data.runOutput).toBeDefined()
    expect(finishedDelivery?.payload.data.runOutput?.metrics).toEqual({ item_count: 42 })
    expect(finishedDelivery?.payload.data.runOutput?.dataRow).toEqual({ status_col: 'NORMAL' })
    expect(finishedDelivery?.payload.data.runOutput?.summary).toBe('巡检完成，在售商品 42')
    // 逐步 output 未对外发布，故 outputs 数组为空
    expect(finishedDelivery?.payload.data.outputs).toEqual([])
  })

  it('SD04, SD08: 成功终态自动交付 final 截图，若标记为 sensitive 则阻断，支持 API 列出与下载及撤回', async () => {
    const f = await fixture(driver, {
      runOutput: true,
      finalScreenshot: true,
      failureScreenshot: true,
    })

    const run = await api.createServiceRun(
      f.db,
      f.principal,
      { scenarioId: f.scenario.id, scenarioVersionId: f.scenarioVersionId, idempotencyKey: 'idemp-shot-1' },
      'req-shot-1',
    )
    const worker = await seedWorker(f.handle)
    const grant = await forceGrantForRun(f.handle, run.detail.id, worker.workerId)
    const { stepRuns, evidences } = schemaFor(f.handle.db)
    const [step] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, run.detail.id))
    const started = await api.startAttempt(f.db, {
      runId: run.detail.id,
      stepRunId: step!.id,
      inputPayload: { value: 'val' },
      grant,
    })

    await api.finishAttempt(f.db, {
      runId: run.detail.id,
      attemptId: started!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { count: 10 },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })

    // 注入两张 final 截图：一张普通（可放行），一张敏感（需阻断）
    const normalId = api.newId()
    const sensitiveId = api.newId()
    const now = new Date()

    const objNormal = await createStoredObject(f.db, run.detail.id)
    const objSensitive = await createStoredObject(f.db, run.detail.id)

    await f.handle.db.insert(evidences).values([
      {
        id: normalId,
        runId: run.detail.id,
        type: 'screenshot',
        status: 'available',
        artifactKey: 'screenshot:run:final',
        objectId: objNormal.id,
        objectKey: objNormal.objectKey,
        externalAccess: 0,
        createdAt: now,
        contentType: 'image/png',
        payload: { role: 'final', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: false },
      },
      {
        id: sensitiveId,
        runId: run.detail.id,
        type: 'screenshot',
        status: 'available',
        artifactKey: 'screenshot:run:final:sensitive',
        objectId: objSensitive.id,
        objectKey: objSensitive.objectKey,
        externalAccess: 0,
        createdAt: now,
        contentType: 'image/png',
        payload: { role: 'final', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: true },
      },
    ])

    // 执行证据结算
    await api.settleRunEvidence(f.db, run.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })

    // 检查放行状态
    const [normalRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, normalId))
    const [sensitiveRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, sensitiveId))

    expect(normalRow?.externalAccess).toBe(1)
    expect(normalRow?.externalAccessSource).toBe('auto')

    expect(sensitiveRow?.externalAccess).toBe(0)
    expect(sensitiveRow?.externalAccessSource).toBeNull()

    // 验证调用方通过 OpenAPI 获取证据列表与下载
    const evidenceList = await api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 10 })
    expect(evidenceList.items.some((e) => e.id === normalId && e.externalAccessSource === 'auto')).toBe(true)
    expect(evidenceList.items.some((e) => e.id === sensitiveId)).toBe(false)

    // 单个下载 normalId 成功
    const downloaded = await api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 1 }, normalId)
    expect(downloaded.object?.id).toBe(normalId)

    // 单个下载 sensitiveId 返回 404
    await expect(api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 1 }, sensitiveId)).rejects.toThrow()

    // 验证审计日志：聚合为一条 evidence.auto_release
    const audits = await listOperationAuditEvents(f.handle.db, { limit: 100 })
    const autoAudit = audits.items.find((a) => a.action === 'evidence.auto_release')
    expect(autoAudit).toBeDefined()
    expect(autoAudit?.resourceId).toBe(run.detail.id)

    // 验证人工撤回
    const revoked = await api.releaseServiceEvidence(f.db, run.detail.id, normalId, false, f.actor)
    expect(revoked.externalAccess).toBe(false)
    expect(revoked.externalAccessSource).toBeNull()

    const [afterRevoke] = await f.handle.db.select().from(evidences).where(eq(evidences.id, normalId))
    expect(afterRevoke?.externalAccess).toBe(0)
    expect(afterRevoke?.externalAccessSource).toBeNull()

    // 撤回后 OpenAPI 再次下载返回 404
    await expect(api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 1 }, normalId)).rejects.toThrow()
  })

  it('SD05-SD06: 失败现场截图自动交付及敏感阻断策略（认证失败、敏感输入阻断、恢复后不放行）', async () => {
    const f = await fixture(driver, {
      runOutput: true,
      finalScreenshot: true,
      failureScreenshot: true,
    })

    // 用例 A: 普通业务错误 -> 自动放行
    const runA = await api.createServiceRun(
      f.db,
      f.principal,
      { scenarioId: f.scenario.id, scenarioVersionId: f.scenarioVersionId, idempotencyKey: 'idemp-fail-safe' },
      'req-fail-safe',
    )
    const worker = await seedWorker(f.handle)
    const grantA = await forceGrantForRun(f.handle, runA.detail.id, worker.workerId)
    const { stepRuns, evidences } = schemaFor(f.handle.db)
    const [stepA] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, runA.detail.id))
    const attemptA = await api.startAttempt(f.db, {
      runId: runA.detail.id,
      stepRunId: stepA!.id,
      inputPayload: { value: 'safe' },
      grant: grantA,
    })
    await api.finishAttempt(f.db, {
      runId: runA.detail.id,
      attemptId: attemptA!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'ELEMENT_NOT_FOUND', safeMessage: '未找到元素' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      grant: grantA,
    })

    const safeShotId = api.newId()
    const now = new Date()
    const objSafe = await createStoredObject(f.db, runA.detail.id)

    await f.handle.db.insert(evidences).values({
      id: safeShotId,
      runId: runA.detail.id,
      stepRunId: stepA!.id,
      attemptId: attemptA!.attemptId,
      type: 'screenshot',
      status: 'available',
      artifactKey: `screenshot:${attemptA!.attemptId}:on_error:0`,
      objectId: objSafe.id,
      objectKey: objSafe.objectKey,
      externalAccess: 0,
      createdAt: now,
      contentType: 'image/png',
      payload: { role: 'on_error', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: false },
    })

    await api.settleRunEvidence(f.db, runA.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    const [safeShotRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, safeShotId))
    expect(safeShotRow?.externalAccess).toBe(1)
    expect(safeShotRow?.externalAccessSource).toBe('auto')

    // 用例 B: 认证错误 (AUTH_GATE_CLOSED) -> 阻断
    const runB = await api.createServiceRun(
      f.db,
      f.principal,
      { scenarioId: f.scenario.id, scenarioVersionId: f.scenarioVersionId, idempotencyKey: 'idemp-fail-auth' },
      'req-fail-auth',
    )
    const grantB = await forceGrantForRun(f.handle, runB.detail.id, worker.workerId)
    const [stepB] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, runB.detail.id))
    const attemptB = await api.startAttempt(f.db, {
      runId: runB.detail.id,
      stepRunId: stepB!.id,
      inputPayload: { value: 'safe' },
      grant: grantB,
    })
    await api.finishAttempt(f.db, {
      runId: runB.detail.id,
      attemptId: attemptB!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'AUTH_GATE_CLOSED', safeMessage: '登录会话已失效' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      grant: grantB,
    })

    const authShotId = api.newId()
    const objAuth = await createStoredObject(f.db, runB.detail.id)

    await f.handle.db.insert(evidences).values({
      id: authShotId,
      runId: runB.detail.id,
      stepRunId: stepB!.id,
      attemptId: attemptB!.attemptId,
      type: 'screenshot',
      status: 'available',
      artifactKey: `screenshot:${attemptB!.attemptId}:on_error:0`,
      objectId: objAuth.id,
      objectKey: objAuth.objectKey,
      externalAccess: 0,
      createdAt: now,
      contentType: 'image/png',
      payload: { role: 'on_error', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: false },
    })

    await api.settleRunEvidence(f.db, runB.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    const [authShotRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, authShotId))
    expect(authShotRow?.externalAccess).toBe(0)
    expect(authShotRow?.externalAccessSource).toBeNull()

    // 用例 C: Attempt 输入包含脱敏凭据 [redacted] -> 阻断
    const runC = await api.createServiceRun(
      f.db,
      f.principal,
      { scenarioId: f.scenario.id, scenarioVersionId: f.scenarioVersionId, idempotencyKey: 'idemp-fail-secret' },
      'req-fail-secret',
    )
    const grantC = await forceGrantForRun(f.handle, runC.detail.id, worker.workerId)
    const [stepC] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, runC.detail.id))
    const attemptC = await api.startAttempt(f.db, {
      runId: runC.detail.id,
      stepRunId: stepC!.id,
      inputPayload: { password: 'secret' },
      secrets: ['secret'],
      grant: grantC,
    })
    await api.finishAttempt(f.db, {
      runId: runC.detail.id,
      attemptId: attemptC!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'INPUT_MISMATCH', safeMessage: '密码错误' },
      stepRunStatus: 'FAILED',
      runStatus: 'FAILED',
      grant: grantC,
    })

    const secretShotId = api.newId()
    const objSecret = await createStoredObject(f.db, runC.detail.id)

    await f.handle.db.insert(evidences).values({
      id: secretShotId,
      runId: runC.detail.id,
      stepRunId: stepC!.id,
      attemptId: attemptC!.attemptId,
      type: 'screenshot',
      status: 'available',
      artifactKey: `screenshot:${attemptC!.attemptId}:on_error:0`,
      objectId: objSecret.id,
      objectKey: objSecret.objectKey,
      externalAccess: 0,
      createdAt: now,
      contentType: 'image/png',
      payload: { role: 'on_error', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: false },
    })

    await api.settleRunEvidence(f.db, runC.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    const [secretShotRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, secretShotId))
    expect(secretShotRow?.externalAccess).toBe(0)
    expect(secretShotRow?.externalAccessSource).toBeNull()

    // 用例 D: 重试成功的历史失败 Attempt 截图不放行
    const runD = await api.createServiceRun(
      f.db,
      f.principal,
      { scenarioId: f.scenario.id, scenarioVersionId: f.scenarioVersionId, idempotencyKey: 'idemp-recovered' },
      'req-recovered',
    )
    const grantD = await forceGrantForRun(f.handle, runD.detail.id, worker.workerId)
    const [stepD] = await f.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, runD.detail.id))
    const attemptD1 = await api.startAttempt(f.db, {
      runId: runD.detail.id,
      stepRunId: stepD!.id,
      inputPayload: { value: 'retry-test' },
      grant: grantD,
    })
    await api.finishAttempt(f.db, {
      runId: runD.detail.id,
      attemptId: attemptD1!.attemptId,
      attemptStatus: 'FAILED',
      error: { code: 'TIMEOUT', safeMessage: '重试前超时' },
      stepRunStatus: 'PENDING',
      runStatus: 'RUNNING',
      grant: grantD,
    })
    const attemptD2 = await api.startAttempt(f.db, {
      runId: runD.detail.id,
      stepRunId: stepD!.id,
      inputPayload: { value: 'retry-test' },
      grant: grantD,
    })
    await api.finishAttempt(f.db, {
      runId: runD.detail.id,
      attemptId: attemptD2!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { ok: true },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: grantD,
    })

    const historicalShotId = api.newId()
    const objHist = await createStoredObject(f.db, runD.detail.id)

    await f.handle.db.insert(evidences).values({
      id: historicalShotId,
      runId: runD.detail.id,
      stepRunId: stepD!.id,
      attemptId: attemptD1!.attemptId,
      type: 'screenshot',
      status: 'available',
      artifactKey: `screenshot:${attemptD1!.attemptId}:on_error:0`,
      objectId: objHist.id,
      objectKey: objHist.objectKey,
      externalAccess: 0,
      createdAt: now,
      contentType: 'image/png',
      payload: { role: 'on_error', viewport: 'full_page', capturedAt: now.toISOString(), sensitive: false },
    })

    await api.settleRunEvidence(f.db, runD.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })
    const [historicalShotRow] = await f.handle.db.select().from(evidences).where(eq(evidences.id, historicalShotId))
    expect(historicalShotRow?.externalAccess).toBe(0)
    expect(historicalShotRow?.externalAccessSource).toBeNull()
  })

  it('SD07-SD08: 策略关闭与存量兼容，跨调用方隔离防护', async () => {
    // 调用方 A 开启策略
    const fA = await fixture(driver, {
      runOutput: true,
      finalScreenshot: true,
      failureScreenshot: true,
    })

    // 调用方 B 全部关闭策略 (存量/关闭策略调用方)
    const callerB = await api.saveServiceCaller(
      fA.db,
      null,
      serviceCallerBodySchema.parse({
        name: '关闭策略调用方',
        owner: 'team-disabled',
        status: 'active',
        requestsPerMinute: 60,
        maxOutstandingRuns: 5,
        runTimeoutSeconds: 600,
        deliveryPolicy: {
          runOutput: false,
          finalScreenshot: false,
          failureScreenshot: false,
        },
      }),
      fA.actor,
    )
    const credB = await api.issueServiceCredential(
      fA.db,
      callerB.caller.id,
      {
        name: '关闭策略凭据',
        scopes: ['run:execute', 'run:read', 'evidence:read'],
        grants: [{ targetId: fA.target.id, allowAnonymous: true, accountIds: [] }],
        expiresInDays: 90,
      },
      fA.actor,
    )
    const principalB = await api.authenticateService(fA.db, `Bearer ${credB.token}`)

    // 1. 调用方 B 发起 Run
    const runB = await api.createServiceRun(
      fA.db,
      principalB,
      { scenarioId: fA.scenario.id, scenarioVersionId: fA.scenarioVersionId, idempotencyKey: 'idemp-b-1' },
      'req-b-1',
    )
    const worker = await seedWorker(fA.handle)
    const grantB = await forceGrantForRun(fA.handle, runB.detail.id, worker.workerId)
    const { stepRuns, evidences, runs } = schemaFor(fA.handle.db)
    const [stepB] = await fA.handle.db.select().from(stepRuns).where(eq(stepRuns.runId, runB.detail.id))
    const attemptB = await api.startAttempt(fA.db, {
      runId: runB.detail.id,
      stepRunId: stepB!.id,
      inputPayload: { value: 'val' },
      grant: grantB,
    })
    await api.finishAttempt(fA.db, {
      runId: runB.detail.id,
      attemptId: attemptB!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { count: 99 },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant: grantB,
    })
    await fA.handle.db
      .update(runs)
      .set({ context: { count: 99, status: 'NORMAL' }, finishedAt: new Date() })
      .where(eq(runs.id, runB.detail.id))

    const shotIdB = api.newId()
    const objB = await createStoredObject(fA.db, runB.detail.id)

    await fA.handle.db.insert(evidences).values({
      id: shotIdB,
      runId: runB.detail.id,
      type: 'screenshot',
      status: 'available',
      artifactKey: 'screenshot:run:final',
      objectId: objB.id,
      objectKey: objB.objectKey,
      externalAccess: 0,
      createdAt: new Date(),
      contentType: 'image/png',
      payload: { role: 'final', viewport: 'full_page', capturedAt: new Date().toISOString(), sensitive: false },
    })

    await api.settleRunOutput(fA.db, runB.detail.id)
    await api.settleRunEvidence(fA.db, runB.detail.id, { pendingTtlSeconds: 3600, maxUploadAttempts: 3 })

    // 策略关闭时，runOutput 投影为 null
    const publishedB = await api.getServiceRun(fA.db, principalB, runB.detail.id)
    expect(publishedB.runOutput).toBeNull()

    // 策略关闭时，终态截图不自动放行
    const [shotRowB] = await fA.handle.db.select().from(evidences).where(eq(evidences.id, shotIdB))
    expect(shotRowB?.externalAccess).toBe(0)

    // 2. 隔离性验证：调用方 B 无法读取调用方 A 的 Run 或证据
    const runA = await api.createServiceRun(
      fA.db,
      fA.principal,
      { scenarioId: fA.scenario.id, scenarioVersionId: fA.scenarioVersionId, idempotencyKey: 'idemp-a-iso' },
      'req-a-iso',
    )
    await expect(api.getServiceRun(fA.db, principalB, runA.detail.id)).rejects.toThrow()
    await expect(api.serviceEvidence(fA.db, principalB, runA.detail.id, { limit: 10 })).rejects.toThrow()
  })
})
