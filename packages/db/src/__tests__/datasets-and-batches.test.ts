import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
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
} from '../datasets/datasets.js'
import {
  createBatch,
  getBatch,
  listBatches,
  advanceBatch,
  onRunSettledForBatch,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  retryFailedBatch,
  exportBatchResults,
} from '../batches/batches.js'
import { writeRunWithSnapshot } from '../runs/runs.js'
import { normalizeAuthoringDocument, type ScenarioInputDecl } from '@cairn/shared'

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
})
