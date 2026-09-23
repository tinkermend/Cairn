import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { BUSINESS_SOURCE_CURSOR_EXPIRED } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import {
  approveBusinessSourceCandidate,
  claimBusinessSourceBuildJob,
  cleanupBusinessSourceSnapshots,
  commitBusinessSourceBatch,
  createBusinessSourceCandidate,
  finishBusinessSourceBuild,
  getBusinessSource,
  getBusinessSourceCandidate,
  listBusinessRecords,
  previewBusinessSource,
  revokeBusinessSource,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 目标业务数据源绑定、校验与查询闭环', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `biz_src_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'biz-src-test-user',
      email: `biz-src-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function freshTarget(prefix = 'tgt'): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `${prefix}-${id}`,
      name: '测试目标系统',
      entryUrl: 'https://test.example',
    })
    return id
  }

  async function freshDataset(targetId: string, rows: Array<Record<string, unknown>>): Promise<string> {
    const { datasets, datasetRows } = schemaFor(handle.db)
    const datasetId = newId()
    const now = new Date()

    await handle.db.insert(datasets).values({
      id: datasetId,
      name: '厂家数据导入.xlsx',
      targetId,
      sourceType: 'excel',
      sourceFilename: 'manufacturers.xlsx',
      rowCount: rows.length,
      columnsMeta: [
        { key: 'code', name: '厂家编号', type: 'string' },
        { key: 'name', name: '厂家名称', type: 'string' },
        { key: 'status', name: '状态', type: 'string' },
      ],
      createdByAccountId: actorId,
      createdAt: now,
      updatedAt: now,
    })

    if (rows.length > 0) {
      await handle.db.insert(datasetRows).values(
        rows.map((row, idx) => ({
          id: newId(),
          datasetId,
          rowIndex: idx,
          rowData: row,
          validStatus: 'valid' as const,
          createdAt: now,
        })),
      )
    }

    return datasetId
  }

  it('预览有限行并检验字段映射与敏感列排查', async () => {
    const targetA = await freshTarget('prev-a')
    const targetB = await freshTarget('prev-b')

    const datasetIdA = await freshDataset(targetA, [
      { code: 'M-001', name: 'Alpha Tech', status: 'active', notes: '供应商' },
      { code: 'M-002', name: 'Beta Industrial', status: 'active', notes: 'OEM' },
      { code: '', name: 'Empty Code Corp', status: 'pending' },
    ])

    // 1. 正常预览
    const preview = await previewBusinessSource(handle.db, targetA, {
      datasetId: datasetIdA,
      entityType: 'manufacturer',
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        statusColumn: 'status',
        fieldWhitelist: ['code', 'name', 'status'],
        sensitiveFields: ['password', 'secret'],
      },
    })

    expect(preview.previewRows).toHaveLength(3)
    expect(preview.previewRows[0].isValid).toBe(true)
    expect(preview.previewRows[0].recordKey).toBe('M-001')
    expect(preview.previewRows[2].isValid).toBe(false)
    expect(preview.previewRows[2].rejectReason).toContain('为空')
    expect(preview.validationDigest.sampleValidCount).toBe(2)
    expect(preview.validationDigest.sampleRejectedCount).toBe(1)

    // 2. 拒绝跨 Target 配对
    await expect(
      previewBusinessSource(handle.db, targetB, {
        datasetId: datasetIdA,
        entityType: 'manufacturer',
        mappingConfig: {
          keyColumn: 'code',
          displayNameColumn: 'name',
          fieldWhitelist: ['code', 'name'],
        },
      }),
    ).rejects.toThrow(/不属于当前目标系统/)

    // 3. 拦截敏感列加入白名单
    await expect(
      previewBusinessSource(handle.db, targetA, {
        datasetId: datasetIdA,
        entityType: 'manufacturer',
        mappingConfig: {
          keyColumn: 'code',
          displayNameColumn: 'name',
          fieldWhitelist: ['code', 'name', 'user_password'],
        },
      }),
    ).rejects.toThrow(/敏感阻断列/)
  })

  it('创建候选快照并在 Worker 校验通过后原子 CAS 审批发布与游标分页', async () => {
    const targetId = await freshTarget('cand-cas')
    const datasetId = await freshDataset(targetId, [
      { code: 'FAC-1', name: '第一电子厂', tier: 'T1' },
      { code: 'FAC-2', name: '第二重工', tier: 'T2' },
      { code: 'FAC-3', name: '第三机电', tier: 'T1' },
    ])

    const mappingConfig = {
      keyColumn: 'code',
      displayNameColumn: 'name',
      fieldWhitelist: ['code', 'name', 'tier'],
    }

    // 1. 创建 building 候选
    const created = await createBusinessSourceCandidate(
      handle.db,
      targetId,
      {
        datasetId,
        entityType: 'manufacturer',
        mappingConfig,
        declaredSourceAsOf: new Date().toISOString(),
        declarationBasis: '采购系统导出确认件',
        completenessBasis: '快照完整扫描',
      },
      actorId,
    )

    expect(created.candidateId).toBeDefined()
    expect(created.bindingRevision).toBe(1)

    // 未批准前查询返回 unknown
    const unapprovedList = await listBusinessRecords(handle.db, targetId, { entityType: 'manufacturer' })
    expect(unapprovedList.items).toHaveLength(0)
    expect(unapprovedList.coverage.status).toBe('unknown')

    // 2. 尝试审批 building 候选应被拒绝
    await expect(
      approveBusinessSourceCandidate(
        handle.db,
        targetId,
        created.candidateId,
        { expectedRevision: 1, approvalBasis: '初审' },
        actorId,
      ),
    ).rejects.toThrow(/仅 "ready" 状态的候选可获批准/)

    // 3. Worker 认领并处理作业
    const claimed = await claimBusinessSourceBuildJob(handle.db, 'worker-node-1', 30_000)
    expect(claimed).not.null
    expect(claimed!.id).toBe(created.candidateId)

    // 写入投影记录
    await commitBusinessSourceBatch(handle.db, created.candidateId, [
      {
        targetId,
        entityType: 'manufacturer',
        recordKey: 'FAC-1',
        displayName: '第一电子厂',
        originalDatasetId: datasetId,
        datasetRowId: newId(),
        datasetRowIndex: 0,
        payload: { code: 'FAC-1', name: '第一电子厂', tier: 'T1' },
      },
      {
        targetId,
        entityType: 'manufacturer',
        recordKey: 'FAC-2',
        displayName: '第二重工',
        originalDatasetId: datasetId,
        datasetRowId: newId(),
        datasetRowIndex: 1,
        payload: { code: 'FAC-2', name: '第二重工', tier: 'T2' },
      },
      {
        targetId,
        entityType: 'manufacturer',
        recordKey: 'FAC-3',
        displayName: '第三机电',
        originalDatasetId: datasetId,
        datasetRowId: newId(),
        datasetRowIndex: 2,
        payload: { code: 'FAC-3', name: '第三机电', tier: 'T1' },
      },
    ])

    // 完成构建并推入 ready
    await finishBusinessSourceBuild(handle.db, created.candidateId, {
      status: 'ready',
      summary: {
        totalRows: 3,
        validCount: 3,
        rejectedCount: 0,
        issues: [],
      },
    })

    const readyCandidate = await getBusinessSourceCandidate(handle.db, targetId, created.candidateId)
    expect(readyCandidate?.buildStatus).toBe('ready')

    // 4. CAS 修订不匹配时拒绝审批
    await expect(
      approveBusinessSourceCandidate(
        handle.db,
        targetId,
        created.candidateId,
        { expectedRevision: 999, approvalBasis: '过期版本' },
        actorId,
      ),
    ).rejects.toThrow(/数据源修订版本不一致/)

    // 5. 成功批准切换当前指针
    const approvalResult = await approveBusinessSourceCandidate(
      handle.db,
      targetId,
      created.candidateId,
      { expectedRevision: 1, approvalBasis: '业务负责人核准上线' },
      actorId,
    )
    expect(approvalResult.bindingRevision).toBe(2)
    expect(approvalResult.currentSnapshotId).toBe(created.candidateId)

    const activeSource = await getBusinessSource(handle.db, targetId, 'manufacturer')
    expect(activeSource?.status).toBe('active')
    expect(activeSource?.currentSnapshotId).toBe(created.candidateId)

    // 6. 分页查询与搜索
    const page1 = await listBusinessRecords(handle.db, targetId, {
      entityType: 'manufacturer',
      limit: 2,
    })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0].displayName).toBe('第一电子厂')
    expect(page1.nextCursor).toBeDefined()
    expect(page1.snapshotId).toBe(created.candidateId)

    // 读取第二页
    const page2 = await listBusinessRecords(handle.db, targetId, {
      entityType: 'manufacturer',
      cursor: page1.nextCursor,
      limit: 2,
    })
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0].displayName).toBe('第三机电')
    expect(page2.nextCursor).toBeUndefined()

    // 搜索过滤
    const searchRes = await listBusinessRecords(handle.db, targetId, {
      entityType: 'manufacturer',
      search: '第二',
    })
    expect(searchRes.items).toHaveLength(1)
    expect(searchRes.items[0].recordKey).toBe('FAC-2')

    // 7. 替换快照使旧游标失效测试
    const datasetIdV2 = await freshDataset(targetId, [
      { code: 'FAC-NEW-1', name: '新厂 1' },
    ])
    const candidateV2 = await createBusinessSourceCandidate(
      handle.db,
      targetId,
      {
        datasetId: datasetIdV2,
        entityType: 'manufacturer',
        mappingConfig,
      },
      actorId,
    )

    await finishBusinessSourceBuild(handle.db, candidateV2.candidateId, {
      status: 'ready',
      summary: { totalRows: 1, validCount: 1, rejectedCount: 0, issues: [] },
    })

    await approveBusinessSourceCandidate(
      handle.db,
      targetId,
      candidateV2.candidateId,
      { expectedRevision: 2, approvalBasis: 'V2版本上线' },
      actorId,
    )

    // 携带旧快照的游标请求，必须被 409 BUSINESS_SOURCE_CURSOR_EXPIRED 拦截
    try {
      await listBusinessRecords(handle.db, targetId, {
        entityType: 'manufacturer',
        cursor: page1.nextCursor,
      })
      expect.unreachable('应抛出游标过期异常')
    } catch (err: any) {
      expect(err.code).toBe(BUSINESS_SOURCE_CURSOR_EXPIRED)
    }

    // 8. 撤销业务源
    const revokeRes = await revokeBusinessSource(
      handle.db,
      targetId,
      'manufacturer',
      { expectedRevision: 3, revocationReason: '数据源下线' },
      actorId,
    )
    expect(revokeRes.bindingRevision).toBe(4)

    const revokedSource = await getBusinessSource(handle.db, targetId, 'manufacturer')
    expect(revokedSource?.status).toBe('revoked')
    expect(revokedSource?.currentSnapshotId).toBeNull()

    const listAfterRevoke = await listBusinessRecords(handle.db, targetId, { entityType: 'manufacturer' })
    expect(listAfterRevoke.items).toHaveLength(0)
    expect(listAfterRevoke.coverage.status).toBe('unknown')
  })

  it('rejected 候选清理脏数据，且 softDeleteDataset 级联清理无主快照', async () => {
    const targetId = await freshTarget('cleanup-tgt')
    const datasetId = await freshDataset(targetId, [
      { code: 'TMP-1', name: '临时' },
    ])

    const created = await createBusinessSourceCandidate(
      handle.db,
      targetId,
      {
        datasetId,
        entityType: 'manufacturer',
        mappingConfig: { keyColumn: 'code', displayNameColumn: 'name', fieldWhitelist: ['code', 'name'] },
      },
      actorId,
    )

    // 写入临时记录
    await commitBusinessSourceBatch(handle.db, created.candidateId, [
      {
        targetId,
        entityType: 'manufacturer',
        recordKey: 'TMP-1',
        displayName: '临时',
        originalDatasetId: datasetId,
        datasetRowId: newId(),
        datasetRowIndex: 0,
        payload: { code: 'TMP-1', name: '临时' },
      },
    ])

    // 判定为 rejected
    await finishBusinessSourceBuild(handle.db, created.candidateId, {
      status: 'rejected',
      summary: {
        totalRows: 1,
        validCount: 0,
        rejectedCount: 1,
        issues: [{ rowIndex: 0, reason: '包含敏感内容' }],
      },
    })

    const { targetBusinessRecords } = schemaFor(handle.db)
    const records = await handle.db
      .select()
      .from(targetBusinessRecords)
      .where(eq(targetBusinessRecords.snapshotId, created.candidateId))
    expect(records).toHaveLength(0)

    // 软删除 Dataset 后测试清理
    const { datasets } = schemaFor(handle.db)
    await handle.db
      .update(datasets)
      .set({ deletedAt: new Date() })
      .where(eq(datasets.id, datasetId))

    const cleanupRes = await cleanupBusinessSourceSnapshots(handle.db)
    expect(cleanupRes.cleaned).toBeGreaterThanOrEqual(1)
  })
})
