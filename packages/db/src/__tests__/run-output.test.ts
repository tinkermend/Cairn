import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  type Step,
  type ScenarioOutputDecl,
  type RunSnapshot,
  type RunOutput,
  FACTORY_PLATFORM_CONFIG,
} from '@cairn/shared'
import { computeSnapshotDigest } from '../runs/digest.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  loadRunDetail,
  listRuns,
  settleRunOutput,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { assembleRunSnapshot } from '../runs/assemble-snapshot.js'
import { captureSource } from '../reports/reports.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_output`

const step1: Step = {
  id: '00000000-0000-4000-8000-000000000081',
  name: '提取数据',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'report',
  input: {
    value: {
      total: 100,
      id: 1,
      title: 'Item 1',
    },
  },
}

const countStep: Step = {
  id: '00000000-0000-4000-8000-000000000082',
  name: '输出项目数',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'item_count',
  input: { value: 100 },
}

const outputsDecl: ScenarioOutputDecl = {
  summaryTemplate: '巡检完成，在售商品 ${item_count} 件',
  metrics: [
    {
      key: 'item_count',
      name: '项目数',
      fromContextKey: 'report',
      fromField: 'total',
      unit: '个',
    },
  ],
  dataRowFields: [
    {
      columnKey: 'report_id',
      columnHeader: 'ID',
      fromContextKey: 'report',
      fromField: 'id',
    },
    {
      columnKey: 'report_title',
      columnHeader: '标题',
      fromContextKey: 'report',
      fromField: 'title',
    },
  ],
}

describe('assembleRunSnapshot outputs 保真与摘要', () => {
  const baseInput = {
    runId: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
    targetId: '00000000-0000-4000-8000-000000000002',
    scenarioId: '00000000-0000-4000-8000-000000000003',
    scenarioVersionId: '00000000-0000-4000-8000-000000000004',
    steps: [step1],
    input: {},
    target: {
      entryUrl: 'https://example.com/app',
      loginUrl: 'https://example.com/login',
      authMethod: 'password' as const,
      captchaMode: 'none' as const,
      loginFields: null,
      sessionPolicy: null,
    },
    platformDocument: FACTORY_PLATFORM_CONFIG,
    platformRevision: 1,
    authVerification: {
      profileRevision: null,
      profileDigest: null,
      loginFieldsDigest: 'a'.repeat(64),
      expectedIdentity: null,
      capability: 'LEGACY' as const,
      freshnessSeconds: 300,
      verifyTimeoutMs: 10_000,
      loginTimeoutMs: 30_000,
      verifyRetryBackoffSeconds: [1],
      platformConfigRevision: 1,
    },
    allowedOrigins: ['https://example.com'],
    accessPolicy: {
      revision: 1,
      digest: 'b'.repeat(64),
      policy: {
        schemaVersion: 1 as any,
        policyVersion: 1,
        rules: [{ origin: 'https://example.com', purpose: 'business_surface' as const, effect: 'allow' as const }],
      },
    },
    mapConsumption: { mode: 'off' as const },
  }

  it('未声明 outputs 时，快照中 outputs 为 undefined，不造成摘要漂移', () => {
    const s1 = assembleRunSnapshot(baseInput)
    expect(s1.outputs).toBeUndefined()
    expect(computeSnapshotDigest(s1)).toBe(s1.digest)
  })

  it('声明 outputs 时，快照冻结 outputs 声明且摘要可复现', () => {
    const s1 = assembleRunSnapshot({ ...baseInput, outputs: outputsDecl })
    const s2 = assembleRunSnapshot({ ...baseInput, outputs: outputsDecl })
    expect(s1.outputs).toEqual(outputsDecl)
    expect(s1.digest).toBe(s2.digest)
  })
})

describe.each(DRIVERS)('%s 业务输出 settleRunOutput 与 API 读取集成', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'output-tester',
      email: `output-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `output-${SCHEMA.slice(-6)}`,
      name: '输出测试目标',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('带 outputs 的场景创建 Run，快照冻结 outputs，结算后持久化 output 并记录事件', async () => {
    const { runs, runEvents } = schemaFor(handle.db)

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '业务输出场景',
      steps: [step1, countStep],
      outputs: outputsDecl,
      actor: { id: actorId },
    })

    const runRes = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(runRes.created).toBe(true)
    const runId = runRes.detail.id

    // 快照中包含 outputs
    expect((runRes.detail.snapshot as RunSnapshot).outputs).toEqual(outputsDecl)

    // 运行中未结束时，settleRunOutput 返回 null
    const notFinished = await settleRunOutput(handle, runId)
    expect(notFinished).toBeNull()

    // 模拟运行完成，更新上下文与状态
    const fakeContext = {
      report: {
        total: 100,
        id: 1,
        title: 'Item 1',
      },
    }
    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        context: fakeContext,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId))

    // 结算输出
    const settled = await settleRunOutput(handle.db, runId)
    expect(settled).not.toBeNull()
    expect(settled?.status).toBe('NORMAL')
    expect(settled?.metrics).toEqual({ item_count: 100 })
    expect(settled?.dataRow).toEqual({ report_id: 1, report_title: 'Item 1' })
    expect(settled?.summary).toBe('巡检完成，在售商品 100 件')

    // 幂等性：二次结算直接返回已有结果
    const second = await settleRunOutput(handle.db, runId)
    expect(second).toEqual(settled)

    // 验证事件写回
    const events = await handle.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
    const settledEvent = events.find((e) => e.type === 'run.output_settled')
    expect(settledEvent).toBeDefined()
    expect((settledEvent?.payload as any)?.status).toBe('NORMAL')

    // 验证 listRuns 携带 outputSummary
    const list = await listRuns(handle.db, { targetId })
    const item = list.items.find((r) => r.id === runId)
    expect(item).toBeDefined()
    expect(item?.outputSummary).toBe(settled?.summary)

    // 验证 loadRunDetail 携带完整 output
    const detail = await loadRunDetail(handle.db, runId)
    expect(detail.output).toEqual(settled)
  })

  it('历史运行（runs.output 为 null）：loadRunDetail 动态回退组装且不回写物理行', async () => {
    const { runs } = schemaFor(handle.db)

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '历史运行场景',
      steps: [step1],
      actor: { id: actorId },
    })

    const runRes = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const runId = runRes.detail.id

    await handle.db
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        finishedAt: new Date(),
        output: null,
      })
      .where(eq(runs.id, runId))

    // 检查库中依然为 null
    const [beforeRow] = await handle.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
    expect(beforeRow.output).toBeNull()

    // 读取 detail 时动态组装输出
    const detail = await loadRunDetail(handle.db, runId)
    expect(detail.output).not.toBeNull()
    expect(detail.output?.status).toBe('NORMAL')

    // 验证 listRuns 也能动态推导出保底 outputSummary
    const list = await listRuns(handle.db, { targetId })
    const item = list.items.find((r) => r.id === runId)
    expect(item).toBeDefined()
    expect(item?.outputSummary).toBe('流程执行完成，所有检查项均符合预期。')

    // 物理库仍然为 null，不被隐式变动
    const [afterRow] = await handle.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
    expect(afterRow.output).toBeNull()
  })

  it('历史失败运行的列表和详情不显示成功结论，保留部分数据且不改写原始输出', async () => {
    const { runs } = schemaFor(handle.db)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '历史失败输出场景',
      steps: [step1, countStep],
      outputs: outputsDecl,
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const storedOutput: RunOutput = {
      summary: 'ModelAPI 密钥已创建，状态正常',
      status: 'NORMAL',
      metrics: { item_count: 1 },
      findings: [],
      dataRow: { report_id: 7 },
      assembledAt: new Date().toISOString(),
    }
    await handle.db.update(runs).set({
      status: 'FAILED',
      outcomeStatus: 'NOT_EVALUATED',
      evidenceStatus: 'PENDING',
      output: storedOutput,
      finishedAt: new Date(),
    }).where(eq(runs.id, run.detail.id))

    const list = await listRuns(handle.db, { targetId })
    expect(list.items.find((item) => item.id === run.detail.id)).toMatchObject({
      status: 'FAILED',
      outcomeStatus: 'NOT_EVALUATED',
      evidenceStatus: 'PENDING',
      outputSummary: '执行过程中断。',
    })

    const detail = await loadRunDetail(handle.db, run.detail.id)
    expect(detail?.output).toEqual({ ...storedOutput, status: 'UNDETERMINED', summary: '执行过程中断。' })
    expect(detail?.outcomeStatus).toBe('NOT_EVALUATED')
    expect(detail?.evidenceStatus).toBe('PENDING')

    const reportSource = await captureSource(handle.db, { kind: 'RUN', runId: run.detail.id })
    expect((reportSource.payload.output as RunOutput).summary).toBe('执行过程中断。')
    expect((reportSource.payload.output as RunOutput).status).toBe('UNDETERMINED')
    expect((reportSource.payload.output as RunOutput).dataRow).toEqual({ report_id: 7 })

    const [afterRead] = await handle.db.select({ output: runs.output }).from(runs).where(eq(runs.id, run.detail.id))
    expect(afterRead.output).toEqual(storedOutput)
  })
})
