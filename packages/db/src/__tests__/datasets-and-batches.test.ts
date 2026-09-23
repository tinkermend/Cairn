import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  createDataset,
  getDataset,
  listDatasets,
  getDatasetRows,
  softDeleteDataset,
  autoMapDataset,
  preflightDataset,
  getDatasetRowsForPreflight,
} from '../datasets/datasets.js'
import {
  createBatch,
  getBatch,
  getBatchItems,
  listBatches,
  advanceBatch,
  dispatchBatch,
  sweepStrandedBatches,
  onRunSettledForBatch,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  retryFailedBatch,
  exportBatchResults,
} from '../batches/batches.js'
import { writeRunWithSnapshot } from '../runs/runs.js'
import { batchDetailSchema, datasetDetailSchema, normalizeAuthoringDocument, type ScenarioInputDecl } from '@cairn/shared'

describe.each(DRIVERS)('%s dataset and batch automation domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string
  let scenarioId: string
  let scenarioVersionId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()
    scenarioId = newId()
    scenarioVersionId = newId()
    accountId = newId()

    await handle.db.insert(t.consoleAccounts).values({
      id: accountId,
      displayName: '测试工程师',
      email: `${accountId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, accountId)

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '自动化测试目标',
      entryUrl: 'https://erp.example.com',
    })

    const scenarioInputs: ScenarioInputDecl[] = [
      {
        key: 'sku',
        label: '商品编码',
        type: 'string',
        required: true,
      },
      {
        key: 'quantity',
        label: '采购数量',
        type: 'number',
        required: true,
      },
      {
        key: 'traceId',
        label: '追踪号',
        type: 'string',
        required: true,
        defaultGenerator: {
          kind: 'random_string',
          prefix: 'TRC-',
          suffix: '',
          length: 8,
          charset: 'alphanumeric',
          unique: false,
        },
      },
    ]

    await handle.db.insert(t.scenarios).values({
      id: scenarioId,
      targetId,
      name: '采购下单批处理场景',
      createdByConsoleAccountId: accountId,
      publishedVersionId: scenarioVersionId,
    })

    const testSteps = [
      {
        id: newId(),
        name: '输入SKU',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { from: 'sku' },
      },
      {
        id: newId(),
        name: '输入数量',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { from: 'quantity' },
      },
      {
        id: newId(),
        name: '输入追踪号',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { from: 'traceId' },
      },
    ]

    await handle.db.insert(t.scenarioVersions).values({
      id: scenarioVersionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'dummy-digest',
      definition: {
        steps: testSteps,
      } as any,
      authoringDocument: normalizeAuthoringDocument({
        inputs: scenarioInputs,
        steps: testSteps as any,
      }),
      createdByConsoleAccountId: accountId,
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('DC-03: verifies pre-run context materialization freezes defaultGenerator', async () => {
    // Calling writeRunWithSnapshot without providing traceId should evaluate defaultGenerator
    const { runId } = await writeRunWithSnapshot(handle.db, {
      scenarioId,
      scenarioVersionId,
      input: {
        sku: 'SKU-999',
        quantity: 10,
      },
      actor: {
        kind: 'console',
        id: accountId,
      },
    })

    const t = schemaFor(handle.db)
    const [run] = await handle.db.select().from(t.runs).where(eq(t.runs.id, runId))
    expect(run).toBeDefined()
    expect(run!.context).toBeDefined()
    const ctx = run!.context as Record<string, any>
    expect(ctx.sku).toBe('SKU-999')
    expect(ctx.quantity).toBe(10)
    expect(ctx.traceId).toMatch(/^TRC-[A-Za-z0-9]{8}$/)
  })

  it('DC-06: verifies auto-mapping and preflight dataset validation', async () => {
    const columns = [
      { name: '商品编码', key: 'col_sku', type: 'string' as const, sampleValues: ['00892'] },
      { name: '采购数量', key: 'col_qty', type: 'number' as const, sampleValues: ['5'] },
    ]

    const scenarioInputs: ScenarioInputDecl[] = [
      { key: 'sku', label: '商品编码', type: 'string', required: true },
      { key: 'quantity', label: '采购数量', type: 'number', required: true },
      {
        key: 'note',
        label: '备注',
        type: 'string',
        required: false,
        defaultGenerator: { kind: 'fixed', value: '自动备注' },
      },
    ]

    // 1. Auto map
    const mapped = autoMapDataset(columns, scenarioInputs)
    expect(mapped.binding['sku']).toEqual({ source: 'column', columnName: '商品编码' })
    expect(mapped.binding['quantity']).toEqual({ source: 'column', columnName: '采购数量' })
    expect(mapped.binding['note']).toEqual({
      source: 'generator',
      spec: { kind: 'fixed', value: '自动备注' },
    })

    // 2. Preflight validation
    const testRows = [
      { 商品编码: '00892', 采购数量: 10 }, // valid
      { 商品编码: '', 采购数量: 20 }, // invalid: sku empty
      { 商品编码: '00893', 采购数量: 'not-a-number' }, // invalid: quantity not a number
      { 商品编码: '00894', 采购数量: 15 }, // valid
    ]

    const preflight = preflightDataset(testRows, mapped.binding, scenarioInputs)
    expect(preflight.totalRows).toBe(4)
    expect(preflight.validCount).toBe(2)
    expect(preflight.errorCount).toBe(2)
    expect(preflight.issues.length).toBe(2)
    expect(preflight.issues[0]?.rowIndex).toBe(1)
    expect(preflight.issues[0]?.fieldKey).toBe('sku')
    expect(preflight.issues[1]?.rowIndex).toBe(2)
    expect(preflight.issues[1]?.fieldKey).toBe('quantity')

    // AI-03 C4.1: Verify selected rows with non-contiguous indexes retain their exact absolute rowIndex
    const nonContiguousRows = [
      { rowIndex: 205, rowData: { 商品编码: '', 采购数量: 20 } },
    ]
    const preflight2 = preflightDataset(nonContiguousRows, mapped.binding, scenarioInputs)
    expect(preflight2.totalRows).toBe(1)
    expect(preflight2.errorCount).toBe(1)
    expect(preflight2.issues[0]?.rowIndex).toBe(205)
  })

  it('DC-07 & DC-11 & DC-12: batch creation, sliding window dispatch, and circuit breaker', async () => {
    // 1. Create dataset
    const dataset = await createDataset(
      handle.db,
      {
        name: '采购测试数据',
        targetId,
        sourceType: 'excel',
        sourceFilename: 'purchases.xlsx',
        columns: [
          { name: '商品编码', key: 'sku', type: 'string', sampleValues: ['SKU-1'] },
          { name: '采购数量', key: 'quantity', type: 'number', sampleValues: ['1'] },
        ],
        rows: [
          { 商品编码: 'SKU-001', 采购数量: 10 },
          { 商品编码: 'SKU-002', 采购数量: 20 },
          { 商品编码: 'SKU-003', 采购数量: 30 },
          { 商品编码: 'SKU-004', 采购数量: 40 },
          { 商品编码: 'SKU-005', 采购数量: 50 },
        ],
      },
      accountId,
    )

    expect(dataset.id).toBeDefined()
    expect(dataset.rowCount).toBe(5)

    // 2. Create batch with concurrency 2 and circuit breaker threshold 2
    const batch = await createBatch(
      handle.db,
      {
        name: '采购批量运行-01',
        scenarioId,
        scenarioVersionId,
        datasetId: dataset.id,
        binding: {
          sku: { source: 'column', columnName: '商品编码' },
          quantity: { source: 'column', columnName: '采购数量' },
        },
        failurePolicy: 'stop_on_threshold',
        failureThreshold: 2,
      },
      accountId,
    )

    expect(batch.status).toBe('QUEUED')
    expect(batch.totalItems).toBe(5)

    // 3. First advance with concurrencyLimit = 2 -> dispatches first 2 items (DC-07)
    const adv1 = await advanceBatch(handle.db, batch.id, 2)
    expect(adv1.dispatchedRunIds.length).toBe(2)
    expect(adv1.completed).toBe(false)
    expect(adv1.paused).toBe(false)

    // Verify batch status is RUNNING
    const bRunning = await getBatch(handle.db, batch.id)
    expect(bRunning!.status).toBe('RUNNING')

    // Subsequent advance before items finish should dispatch 0 because slots are full
    const advFull = await advanceBatch(handle.db, batch.id, 2)
    expect(advFull.dispatchedRunIds.length).toBe(0)

    // 4. Item 0 finishes with TARGET system error
    await onRunSettledForBatch(handle.db, adv1.dispatchedRunIds[0]!, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: '502 Bad Gateway: 目标系统崩溃',
    })

    // Advance opens 1 slot, dispatches item 2
    const adv2 = await advanceBatch(handle.db, batch.id, 2)
    expect(adv2.dispatchedRunIds.length).toBe(1)

    // 5. Item 1 also finishes with TARGET error -> consecutive TARGET failures = 2 -> circuit breaker triggers! (DC-11, DC-12)
    await onRunSettledForBatch(handle.db, adv1.dispatchedRunIds[1]!, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: '502 Bad Gateway: 目标系统崩溃',
    })

    const bPaused = await getBatch(handle.db, batch.id)
    expect(bPaused!.status).toBe('PAUSED')
    expect(bPaused!.pausedReason).toContain('CIRCUIT_BREAKER_TRIGGERED')

    // Advance on paused batch returns paused: true without dispatching
    const advPaused = await advanceBatch(handle.db, batch.id, 2)
    expect(advPaused.paused).toBe(true)
    expect(advPaused.dispatchedRunIds.length).toBe(0)

    // Resume batch
    await resumeBatch(handle.db, batch.id, accountId)
    const bResumed = await getBatch(handle.db, batch.id)
    expect(bResumed!.status).toBe('RUNNING')

    // Finish item 2 with success
    await onRunSettledForBatch(handle.db, adv2.dispatchedRunIds[0]!, {
      status: 'passed',
    })

    // Advance remaining items
    const adv3 = await advanceBatch(handle.db, batch.id, 5)
    expect(adv3.dispatchedRunIds.length).toBe(2)

    for (const runId of adv3.dispatchedRunIds) {
      await onRunSettledForBatch(handle.db, runId, { status: 'passed' })
    }

    // Batch completes
    await advanceBatch(handle.db, batch.id, 5)
    const bCompleted = await getBatch(handle.db, batch.id)
    expect(bCompleted!.status).toBe('COMPLETED')
    expect(bCompleted!.successItems).toBe(3)
    expect(bCompleted!.failedItems).toBe(2)

    // 6. DC-13: Broad Result Excel Export
    const exported = await exportBatchResults(handle.db, batch.id)
    expect(exported.filename).toContain('采购批量运行-01_执行结果.xlsx')
    expect(exported.rowCount).toBe(5)
    expect(exported.base64.length).toBeGreaterThan(100)

    // 7. DC-14: Retry Failed Batch
    const retryBatch = await retryFailedBatch(handle.db, batch.id, accountId)
    expect(retryBatch.name).toContain('[重试] 采购批量运行-01')
    expect(retryBatch.totalItems).toBe(2) // Only the 2 failed items
    expect(retryBatch.status).toBe('QUEUED')
  })

  it('数据集归属目标：跨目标读写删与建批被拒绝，同目标可换场景复用', async () => {
    const t = schemaFor(handle.db)
    const otherTargetId = newId()
    const otherScenarioId = newId()
    const otherVersionId = newId()
    const sameTargetScenarioId = newId()
    const sameTargetVersionId = newId()
    const outsiderId = newId()
    const roleId = newId()

    await handle.db.insert(t.targets).values({
      id: otherTargetId,
      code: `other-${otherTargetId.slice(0, 8)}`,
      name: '另一个目标',
      entryUrl: 'https://other.example.com',
    })
    await handle.db.insert(t.scenarios).values({
      id: otherScenarioId,
      targetId: otherTargetId,
      name: '其他目标场景',
      createdByConsoleAccountId: accountId,
      publishedVersionId: otherVersionId,
    })
    await handle.db.insert(t.scenarios).values({
      id: sameTargetScenarioId,
      targetId,
      name: '同目标另一场景',
      createdByConsoleAccountId: accountId,
      publishedVersionId: sameTargetVersionId,
    })
    const step = {
      id: newId(),
      name: '回显',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { from: 'sku' },
    }
    await handle.db.insert(t.scenarioVersions).values([
      {
        id: otherVersionId,
        scenarioId: otherScenarioId,
        versionNo: 1,
        kind: 'published' as const,
        sourceDigest: 'other-version',
        definition: { steps: [step] } as any,
        createdByConsoleAccountId: accountId,
      },
      {
        id: sameTargetVersionId,
        scenarioId: sameTargetScenarioId,
        versionNo: 1,
        kind: 'published' as const,
        sourceDigest: 'same-target-version',
        definition: { steps: [step] } as any,
        createdByConsoleAccountId: accountId,
      },
    ])

    await handle.db.insert(t.consoleAccounts).values({
      id: outsiderId,
      displayName: '局部操作员',
      email: `${outsiderId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(t.consoleRoles).values({
      id: roleId,
      key: `dataset-scope-${roleId.slice(0, 8)}`,
      name: '局部数据集',
    })
    await handle.db.insert(t.consoleRolePermissions).values(
      ['target:read', 'dataset:read', 'dataset:write', 'dataset:delete', 'batch:read', 'batch:write'].map(
        (permission) => ({ consoleRoleId: roleId, permission }),
      ),
    )
    await handle.db.insert(t.consoleAccountRoles).values({
      consoleAccountId: outsiderId,
      consoleRoleId: roleId,
      targetScopeMode: 'selected',
      targetScopeIds: [targetId],
    })

    const foreign = await createDataset(
      handle.db,
      {
        name: '其他目标数据',
        targetId: otherTargetId,
        sourceType: 'csv',
        sourceFilename: 'other.csv',
        columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: ['A'] }],
        rows: [{ 商品编码: 'A-1' }],
      },
      accountId,
    )
    const own = await createDataset(
      handle.db,
      {
        name: '本目标数据',
        targetId,
        sourceType: 'csv',
        sourceFilename: 'own.csv',
        columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: ['B'] }],
        rows: [{ 商品编码: 'B-1' }],
      },
      outsiderId,
    )

    await expect(
      createDataset(
        handle.db,
        {
          name: '越权数据',
          targetId: otherTargetId,
          sourceType: 'csv',
          sourceFilename: 'x.csv',
          columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: [] }],
          rows: [{ 商品编码: 'X' }],
        },
        outsiderId,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })

    await expect(
      createDataset(
        handle.db,
        {
          name: '无目标',
          targetId: undefined as unknown as string,
          sourceType: 'csv',
          sourceFilename: 'none.csv',
          columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: [] }],
          rows: [{ 商品编码: 'N' }],
        },
        outsiderId,
      ),
    ).rejects.toMatchObject({ code: 'DATASET_TARGET_REQUIRED' })

    const visible = await listDatasets(handle.db, {}, outsiderId)
    expect(visible.items.map((item) => item.id)).toContain(own.id)
    expect(visible.items.map((item) => item.id)).not.toContain(foreign.id)
    await expect(getDataset(handle.db, foreign.id, outsiderId)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    await expect(getDatasetRows(handle.db, foreign.id, { limit: 10 }, outsiderId)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    await expect(softDeleteDataset(handle.db, foreign.id, outsiderId)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    expect(await getDataset(handle.db, foreign.id)).toMatchObject({ id: foreign.id })

    const binding = { sku: { source: 'column' as const, columnName: '商品编码' } }
    await expect(
      createBatch(
        handle.db,
        {
          name: '跨目标批次',
          scenarioId,
          scenarioVersionId,
          datasetId: foreign.id,
          binding,
        },
        outsiderId,
      ),
    ).rejects.toMatchObject({ code: 'DATASET_NOT_FOUND' })
    await expect(
      createBatch(
        handle.db,
        {
          name: '错版本批次',
          scenarioId,
          scenarioVersionId: sameTargetVersionId,
          datasetId: own.id,
          binding,
        },
        outsiderId,
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_VERSION_NOT_FOUND' })

    const reused = await createBatch(
      handle.db,
      {
        name: '同目标换场景',
        scenarioId: sameTargetScenarioId,
        scenarioVersionId: sameTargetVersionId,
        datasetId: own.id,
        binding,
      },
      outsiderId,
    )
    expect(reused.datasetId).toBe(own.id)

    const foreignBatch = await createBatch(
      handle.db,
      {
        name: '其他目标批次',
        scenarioId: otherScenarioId,
        scenarioVersionId: otherVersionId,
        datasetId: foreign.id,
        binding,
      },
      accountId,
    )
    await expect(getBatch(handle.db, foreignBatch.id, outsiderId)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
    const batches = await listBatches(handle.db, {}, outsiderId)
    expect(batches.items.map((item) => item.id)).toContain(reused.id)
    expect(batches.items.map((item) => item.id)).not.toContain(foreignBatch.id)
  })

  it('开不了跑的批次不会留下 QUEUED，卡住的排队能被扫起来', async () => {
    const t = schemaFor(handle.db)
    const dataset = await createDataset(
      handle.db,
      {
        name: '派发恢复数据',
        targetId,
        sourceType: 'csv',
        sourceFilename: 'dispatch.csv',
        columns: [
          { name: '商品编码', key: 'sku', type: 'string', sampleValues: ['SKU-1'] },
          { name: '采购数量', key: 'quantity', type: 'number', sampleValues: ['1'] },
        ],
        rows: [{ 商品编码: 'SKU-D1', 采购数量: 1 }],
      },
      accountId,
    )
    const binding = {
      sku: { source: 'column' as const, columnName: '商品编码' },
      quantity: { source: 'column' as const, columnName: '采购数量' },
    }
    const body = {
      scenarioId,
      scenarioVersionId,
      datasetId: dataset.id,
      binding,
    }

    await expect(
      createBatch(handle.db, { ...body, name: '缺绑定', binding: {} }, accountId),
    ).rejects.toMatchObject({ code: 'SCENARIO_UNRESOLVED_REF' })

    const trialId = newId()
    await handle.db.insert(t.scenarioVersions).values({
      id: trialId,
      scenarioId,
      versionNo: null,
      kind: 'trial',
      sourceDigest: `trial-${trialId}`,
      definition: { steps: [] } as any,
      createdByConsoleAccountId: accountId,
    })
    await expect(
      createBatch(handle.db, { ...body, name: '试跑版本', scenarioVersionId: trialId }, accountId),
    ).rejects.toMatchObject({ code: 'SCENARIO_VERSION_NOT_PUBLISHED' })

    const names = await handle.db
      .select({ name: t.batches.name })
      .from(t.batches)
      .where(inArray(t.batches.name, ['缺绑定', '试跑版本']))
    expect(names).toEqual([])

    await handle.db.update(t.targets).set({ status: 'disabled' }).where(eq(t.targets.id, targetId))
    try {
      await expect(
        createBatch(handle.db, { ...body, name: '目标停用' }, accountId),
      ).rejects.toMatchObject({ code: 'TARGET_DISABLED' })
    } finally {
      await handle.db.update(t.targets).set({ status: 'active' }).where(eq(t.targets.id, targetId))
    }

    const queued = await createBatch(handle.db, { ...body, name: '等待扫描' }, accountId)
    expect(queued.status).toBe('QUEUED')
    const swept = await sweepStrandedBatches(handle.db, 20)
    expect(swept.dispatched).toBeGreaterThan(0)
    expect((await getBatch(handle.db, queued.id))?.status).toBe('RUNNING')

    const held = await createBatch(handle.db, { ...body, name: '暂停后恢复' }, accountId)
    await pauseBatch(handle.db, held.id, '先停一下', accountId)
    const resumed = await resumeBatch(handle.db, held.id, accountId)
    expect(resumed.status).toBe('QUEUED')
    const started = await dispatchBatch(handle.db, held.id, 1)
    expect(started.ok).toBe(true)
    expect((await getBatch(handle.db, held.id))?.status).toBe('RUNNING')

    const blocked = await createBatch(handle.db, { ...body, name: '派发时停用' }, accountId)
    await handle.db.update(t.targets).set({ status: 'disabled' }).where(eq(t.targets.id, targetId))
    try {
      const outcome = await dispatchBatch(handle.db, blocked.id, 1)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.deterministic).toBe(true)
      const failed = await getBatch(handle.db, blocked.id)
      expect(failed?.status).toBe('FAILED')
      expect(failed?.pausedReason).toContain('目标系统已停用')
      const [item] = await handle.db
        .select({ status: t.batchItems.itemStatus, runId: t.batchItems.runId })
        .from(t.batchItems)
        .where(eq(t.batchItems.batchId, blocked.id))
      expect(item?.status).toBe('PENDING')
      expect(item?.runId ?? null).toBeNull()
    } finally {
      await handle.db.update(t.targets).set({ status: 'active' }).where(eq(t.targets.id, targetId))
    }
    const again = await sweepStrandedBatches(handle.db, 20)
    expect(again.failed).toBe(0)
    expect((await getBatch(handle.db, blocked.id))?.status).toBe('FAILED')
  })

  async function createRunnableBatch(
    name: string,
    rowCount: number,
    failurePolicy: 'continue' | 'stop_on_first' | 'stop_on_threshold' = 'stop_on_threshold',
  ) {
    const dataset = await createDataset(
      handle.db,
      {
        name: `${name}-数据`,
        targetId,
        sourceType: 'excel',
        sourceFilename: `${name}.xlsx`,
        columns: [
          { name: '商品编码', key: 'sku', type: 'string', sampleValues: ['SKU-1'] },
          { name: '采购数量', key: 'quantity', type: 'number', sampleValues: ['1'] },
        ],
        rows: Array.from({ length: rowCount }, (_, index) => ({
          商品编码: `${name}-${index}`,
          采购数量: index + 1,
        })),
      },
      accountId,
    )
    return createBatch(
      handle.db,
      {
        name,
        scenarioId,
        scenarioVersionId,
        datasetId: dataset.id,
        binding: {
          sku: { source: 'column', columnName: '商品编码' },
          quantity: { source: 'column', columnName: '采购数量' },
        },
        failurePolicy,
        failureThreshold: 1,
      },
      accountId,
    )
  }

  it('取消批次会通知在途 Run，未开始项改为取消，在途项保持运行', async () => {
    const batch = await createRunnableBatch('取消在途', 3, 'stop_on_first')
    const advanced = await advanceBatch(handle.db, batch.id, 1)
    expect(advanced.dispatchedRunIds).toHaveLength(1)
    const runId = advanced.dispatchedRunIds[0]!

    const cancelled = await cancelBatch(handle.db, batch.id, '停止在途', accountId)
    expect(cancelled.status).toBe('CANCELLED')

    const t = schemaFor(handle.db)
    const items = await handle.db.select().from(t.batchItems).where(eq(t.batchItems.batchId, batch.id))
    const running = items.filter((item) => item.itemStatus === 'RUNNING')
    const pending = items.filter((item) => item.itemStatus === 'PENDING')
    expect(running).toHaveLength(1)
    expect(running[0]?.runId).toBe(runId)
    expect(pending).toHaveLength(0)
    expect(items.filter((item) => item.itemStatus === 'CANCELLED')).toHaveLength(2)

    const [run] = await handle.db
      .select({ cancelRequestedAt: t.runs.cancelRequestedAt })
      .from(t.runs)
      .where(eq(t.runs.id, runId))
    expect(run?.cancelRequestedAt).toBeTruthy()
  })

  it('同一 Run 再次结算不重复计数', async () => {
    const batch = await createRunnableBatch('重复结算', 2, 'continue')
    const advanced = await advanceBatch(handle.db, batch.id, 1)
    const runId = advanced.dispatchedRunIds[0]!

    await onRunSettledForBatch(handle.db, runId, { status: 'passed' })
    const once = await getBatch(handle.db, batch.id)
    expect(once?.successItems).toBe(1)
    expect(once?.status).toBe('RUNNING')

    const again = await onRunSettledForBatch(handle.db, runId, { status: 'passed' })
    expect(again?.batchStatus).toBe('RUNNING')
    const twice = await getBatch(handle.db, batch.id)
    expect(twice?.successItems).toBe(1)
    expect(twice?.failedItems).toBe(0)
    expect(twice?.reviewItems).toBe(0)
    expect(twice?.status).toBe('RUNNING')
  })

  it('取消后的目标失败不改计数，也不把批次打回暂停', async () => {
    const batch = await createRunnableBatch('取消后失败', 2, 'stop_on_first')
    const advanced = await advanceBatch(handle.db, batch.id, 1)
    const runId = advanced.dispatchedRunIds[0]!
    await cancelBatch(handle.db, batch.id, '停止后再失败', accountId)

    const settled = await onRunSettledForBatch(handle.db, runId, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: '502 Bad Gateway',
    })
    expect(settled?.batchStatus).toBe('CANCELLED')
    const after = await getBatch(handle.db, batch.id)
    expect(after?.status).toBe('CANCELLED')
    expect(after?.failedItems).toBe(0)
    expect(after?.successItems).toBe(0)
    expect(after?.pausedReason).not.toContain('CIRCUIT_BREAKER_TRIGGERED')

    const t = schemaFor(handle.db)
    const [item] = await handle.db.select().from(t.batchItems).where(eq(t.batchItems.runId, runId))
    expect(item?.itemStatus).toBe('FAILED')
    expect(item?.failureDomain).toBe('TARGET')

    await onRunSettledForBatch(handle.db, runId, {
      status: 'failed',
      failureDomain: 'TARGET',
      errorMessage: '502 Bad Gateway',
    })
    const replayed = await getBatch(handle.db, batch.id)
    expect(replayed?.status).toBe('CANCELLED')
    expect(replayed?.failedItems).toBe(0)
  })

  it('已完成或已取消的批次不能暂停或恢复', async () => {
    const cancelled = await createRunnableBatch('终态取消', 1)
    await cancelBatch(handle.db, cancelled.id, '直接取消', accountId)
    await expect(pauseBatch(handle.db, cancelled.id, '不该暂停', accountId)).rejects.toMatchObject({
      code: 'BATCH_STATUS_CONFLICT',
    })
    await expect(resumeBatch(handle.db, cancelled.id, accountId)).rejects.toMatchObject({
      code: 'BATCH_STATUS_CONFLICT',
    })
    expect((await getBatch(handle.db, cancelled.id))?.status).toBe('CANCELLED')

    const completed = await createRunnableBatch('终态完成', 1, 'continue')
    const advanced = await advanceBatch(handle.db, completed.id, 1)
    await onRunSettledForBatch(handle.db, advanced.dispatchedRunIds[0]!, { status: 'passed' })
    expect((await getBatch(handle.db, completed.id))?.status).toBe('COMPLETED')
    await expect(pauseBatch(handle.db, completed.id, '不该暂停', accountId)).rejects.toMatchObject({
      code: 'BATCH_STATUS_CONFLICT',
    })
    await expect(resumeBatch(handle.db, completed.id, accountId)).rejects.toMatchObject({
      code: 'BATCH_STATUS_CONFLICT',
    })
    await expect(cancelBatch(handle.db, completed.id, '不该取消', accountId)).rejects.toMatchObject({
      code: 'BATCH_STATUS_CONFLICT',
    })
    expect((await getBatch(handle.db, completed.id))?.status).toBe('COMPLETED')
  })

  it('数据集和批次列表按游标翻页，行与明细同样不重复', async () => {
    const t = schemaFor(handle.db)
    const pageTargetId = newId()
    await handle.db.insert(t.targets).values({
      id: pageTargetId,
      code: `page-${pageTargetId.slice(0, 8)}`,
      name: '分页目标',
      entryUrl: 'https://page.example.com',
    })

    const datasetIds: string[] = []
    for (const [index, name] of ['甲', '乙', '丙'].entries()) {
      const dataset = await createDataset(
        handle.db,
        {
          name: `分页数据集${name}`,
          targetId: pageTargetId,
          sourceType: 'csv',
          sourceFilename: `${name}.csv`,
          columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: [] }],
          rows: [{ 商品编码: `${name}-1` }, { 商品编码: `${name}-2` }, { 商品编码: `${name}-3` }],
        },
        accountId,
      )
      datasetIds.push(dataset.id)
      await handle.db
        .update(t.datasets)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 3 - index)) })
        .where(eq(t.datasets.id, dataset.id))
    }

    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 3; page += 1) {
      const listed = await listDatasets(handle.db, { targetId: pageTargetId, limit: 1, cursor }, accountId)
      expect(listed.items).toHaveLength(1)
      expect(seen.has(listed.items[0]!.id)).toBe(false)
      seen.add(listed.items[0]!.id)
      cursor = listed.nextCursor
      if (page < 2) expect(cursor).toBeTruthy()
      else expect(cursor).toBeUndefined()
    }
    expect([...seen]).toEqual(datasetIds)

    const rows = await getDatasetRows(handle.db, datasetIds[0]!, { limit: 1 })
    expect(rows.items.map((row) => row.rowIndex)).toEqual([0])
    expect(rows.total).toBe(3)
    const rowsNext = await getDatasetRows(handle.db, datasetIds[0]!, { limit: 1, cursor: rows.nextCursor })
    expect(rowsNext.items.map((row) => row.rowIndex)).toEqual([1])
    expect(rowsNext.items[0]!.id).not.toBe(rows.items[0]!.id)
    await expect(getDatasetRows(handle.db, datasetIds[0]!, { cursor: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    })

    const batchDataset = await createDataset(
      handle.db,
      {
        name: '批次分页数据',
        targetId,
        sourceType: 'csv',
        sourceFilename: 'batch-page.csv',
        columns: [
          { name: '商品编码', key: 'sku', type: 'string', sampleValues: [] },
          { name: '采购数量', key: 'quantity', type: 'number', sampleValues: [] },
        ],
        rows: [
          { 商品编码: 'B-1', 采购数量: 1 },
          { 商品编码: 'B-2', 采购数量: 2 },
          { 商品编码: 'B-3', 采购数量: 3 },
        ],
      },
      accountId,
    )
    const batchIds: string[] = []
    for (const [index, name] of ['一', '二', '三'].entries()) {
      const batch = await createBatch(
        handle.db,
        {
          name: `分页批次${name}`,
          scenarioId,
          scenarioVersionId,
          datasetId: batchDataset.id,
          binding: {
            sku: { source: 'column', columnName: '商品编码' },
            quantity: { source: 'column', columnName: '采购数量' },
          },
        },
        accountId,
      )
      batchIds.push(batch.id)
      await handle.db
        .update(t.batches)
        .set({ createdAt: new Date(Date.UTC(2026, 1, 3 - index)) })
        .where(eq(t.batches.id, batch.id))
    }

    const seenBatches = new Set<string>()
    let batchCursor: string | undefined
    for (let page = 0; page < 3; page += 1) {
      const listed = await listBatches(
        handle.db,
        { datasetId: batchDataset.id, limit: 1, cursor: batchCursor },
        accountId,
      )
      expect(listed.items).toHaveLength(1)
      expect(seenBatches.has(listed.items[0]!.id)).toBe(false)
      seenBatches.add(listed.items[0]!.id)
      batchCursor = listed.nextCursor
    }
    expect([...seenBatches]).toEqual(batchIds)

    const items = await getBatchItems(handle.db, batchIds[0]!, { limit: 1 })
    expect(items.items.map((item) => item.datasetRowIndex)).toEqual([0])
    expect(items.total).toBe(3)
    const itemsNext = await getBatchItems(handle.db, batchIds[0]!, { limit: 1, cursor: items.nextCursor })
    expect(itemsNext.items.map((item) => item.datasetRowIndex)).toEqual([1])
    await expect(listDatasets(handle.db, { cursor: 'not-a-cursor' }, accountId)).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    })
  })

  it('创建人被置空后详情仍可解析，派发拒绝伪造的 system 身份', async () => {
    const t = schemaFor(handle.db)
    const dataset = await createDataset(
      handle.db,
      {
        name: '失主数据集',
        targetId,
        sourceType: 'csv',
        sourceFilename: 'orphan.csv',
        columns: [{ name: '商品编码', key: 'sku', type: 'string', sampleValues: [] }],
        rows: [{ 商品编码: 'ORPHAN' }],
      },
      accountId,
    )
    await handle.db.update(t.datasets).set({ createdByAccountId: null }).where(eq(t.datasets.id, dataset.id))
    const detail = await getDataset(handle.db, dataset.id)
    expect(datasetDetailSchema.parse(detail).createdByAccountId).toBeNull()

    const removed = await softDeleteDataset(handle.db, dataset.id, accountId)
    expect(removed).toEqual({ deleted: true })
    expect(await getDataset(handle.db, dataset.id)).toBeNull()

    const batch = await createRunnableBatch('失主批次', 1)
    await handle.db.update(t.batches).set({ createdByAccountId: null }).where(eq(t.batches.id, batch.id))
    const batchDetail = await getBatch(handle.db, batch.id)
    expect(batchDetailSchema.parse(batchDetail).createdByAccountId).toBeNull()
    await expect(advanceBatch(handle.db, batch.id, 1)).rejects.toMatchObject({
      code: 'BATCH_CREATOR_MISSING',
    })
    expect((await getBatch(handle.db, batch.id))?.status).toBe('QUEUED')
  })
})
