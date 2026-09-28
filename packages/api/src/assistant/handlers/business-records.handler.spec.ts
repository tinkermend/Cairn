import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleTargetBusinessRecordsList } from './business-records.handler.js'
import { DomainError } from '@cairn/db'

vi.mock('@cairn/db', () => ({
  assertTargetPermission: vi.fn().mockResolvedValue(undefined),
  listBusinessRecords: vi.fn(),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) {
      super(message)
    }
  },
}))

vi.mock('./common.js', () => ({
  requireVisibleTarget: vi.fn().mockResolvedValue(undefined),
}))

import { listBusinessRecords } from '@cairn/db'

function mockContext(overrides: any = {}): any {
  return {
    db: {} as any,
    actor: {
      id: 'user-001',
      displayName: 'Test Operator',
      email: 'op@example.com',
      status: 'active',
      roles: [],
      permissions: ['ai:assist', 'target:read', 'dataset:read'],
    },
    slots: {
      targetId: 'tgt-1',
      entityType: 'manufacturer',
    },
    question: '列出厂家记录',
    body: { question: '列出厂家记录', pageContext: { page: 'target', targetId: 'tgt-1' } },
    session: null,
    platformConfig: {} as any,
    targets: {
      getTarget: vi.fn().mockResolvedValue({ id: 'tgt-1', name: 'ERP系统' }),
    } as any,
    models: {} as any,
    onProgress: vi.fn(),
    ...overrides,
  }
}

describe('Target Business Records Assistant Handler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('成功返回业务记录候选并映射为 AssistantDiscoveryResult', async () => {
    vi.mocked(listBusinessRecords).mockResolvedValueOnce({
      items: [
        {
          id: 'rec-1',
          snapshotId: 'snap-1',
          targetId: 'tgt-1',
          entityType: 'manufacturer',
          recordKey: 'MFG-001',
          displayName: '富士康科技',
          recordStatus: 'active',
          originalDatasetId: 'ds-1',
          datasetRowId: 'row-1',
          datasetRowIndex: 0,
          payload: { code: 'MFG-001', name: '富士康科技' },
          createdAt: '2026-09-23T10:00:00.000Z',
        },
      ],
      nextCursor: 'cursor_123',
      snapshotId: 'snap-1',
      bindingRevision: 2,
      coverage: {
        status: 'complete',
        completenessBasis: '快照全量扫描校验',
        observedAt: '2026-09-23T09:00:00.000Z',
        importedAt: '2026-09-23T10:00:00.000Z',
      },
    })

    const ctx = mockContext()
    const result = await handleTargetBusinessRecordsList(ctx)

    expect(result.kind).toBe('discovery')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toEqual({
      id: 'rec-1',
      name: '富士康科技',
      targetId: 'tgt-1',
      targetName: 'ERP系统',
      kind: 'manufacturer',
      status: 'active',
      updatedAt: '2026-09-23T10:00:00.000Z',
    })
    expect(result.coverage.totalVisible).toBe(1)
    expect(result.coverage.hasMore).toBe(true)
    expect(result.coverage.nextCursor).toBe('cursor_123')
    expect(result.coverage.observedAt).toBe('2026-09-23T09:00:00.000Z')
    expect(result.message).toContain('检索到 1 条「厂家／制造商」业务记录')
  })

  it('未配置业务数据来源时返回友好提示且无候选', async () => {
    vi.mocked(listBusinessRecords).mockRejectedValueOnce(
      new (DomainError as any)('not_found', 'BUSINESS_SOURCE_NOT_FOUND', '未找到数据源'),
    )

    const ctx = mockContext()
    const result = await handleTargetBusinessRecordsList(ctx)

    expect(result.kind).toBe('discovery')
    expect(result.candidates).toHaveLength(0)
    expect(result.coverage.totalVisible).toBe(0)
    expect(result.coverage.hasMore).toBe(false)
    expect(result.message).toContain('尚无已批准且生效的「厂家／制造商」业务数据快照来源')
  })

  it('用户明确问供应商时不接受 Supervisor 的厂家槽位，也不编造无来源名单', async () => {
    vi.mocked(listBusinessRecords).mockResolvedValueOnce({
      items: [],
      snapshotId: '',
      bindingRevision: 0,
      coverage: {
        status: 'unknown',
        completenessBasis: '当前目标系统尚未配置或批准该业务实体的生效数据源快照',
        observedAt: null,
        importedAt: '',
      },
    })

    const ctx = mockContext({ question: '这个目标里有哪些供应商？' })
    const result = await handleTargetBusinessRecordsList(ctx)

    expect(listBusinessRecords).toHaveBeenCalledWith(
      ctx.db,
      'tgt-1',
      expect.objectContaining({ entityType: 'supplier' }),
      ctx.actor.id,
    )
    expect(result.scope.entityType).toBe('supplier')
    expect(result.candidates).toEqual([])
    expect(result.message).toContain('尚无已批准且生效的「供应商」业务数据快照来源')
    expect(result.message).not.toContain('厂家')
    expect(result.message).not.toContain('manufacturer')
  })

  it('“这个系统”以当前页面目标为准，不沿用模型给出的另一目标', async () => {
    vi.mocked(listBusinessRecords).mockRejectedValueOnce(
      new (DomainError as any)('not_found', 'BUSINESS_SOURCE_NOT_FOUND', '未找到数据源'),
    )
    const question = '这个系统有哪些供应商？'
    const ctx = mockContext({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-2' } },
      slots: { targetId: 'tgt-1', entityType: 'supplier', cursor: 'old-cursor', filter: 'old-filter' },
      targets: { getTarget: vi.fn().mockResolvedValue({ id: 'tgt-2', name: '当前系统' }) },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(listBusinessRecords).toHaveBeenCalledWith(ctx.db, 'tgt-2', expect.objectContaining({
      entityType: 'supplier', search: undefined, cursor: undefined,
    }), ctx.actor.id)
    expect(result.scope.targetId).toBe('tgt-2')
    expect(ctx.slots.targetId).toBe('tgt-2')
  })

  it('未绑定目标时不把旧槽位当作“这个系统”', async () => {
    const question = '这个系统有哪些供应商？'
    const ctx = mockContext({
      question,
      body: { question, pageContext: { page: 'scenario' } },
      slots: { targetId: 'tgt-1', entityType: 'supplier' },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(result.candidates).toEqual([])
    expect(result.scope.targetId).toBeUndefined()
    expect(result.message).toContain('请先打开目标详情页')
    expect(listBusinessRecords).not.toHaveBeenCalled()
  })

  it('用户在 B 页面明确点名 A 时，按可见目标名称查询 A', async () => {
    vi.mocked(listBusinessRecords).mockRejectedValueOnce(
      new (DomainError as any)('not_found', 'BUSINESS_SOURCE_NOT_FOUND', '未找到数据源'),
    )
    const question = '列出系统甲的供应商'
    const listTargets = vi.fn().mockResolvedValue({ items: [{ id: 'tgt-1', name: '系统甲' }], nextCursor: null })
    const ctx = mockContext({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-2' } },
      slots: { targetId: 'tgt-2', entityType: 'supplier', cursor: 'old-cursor' },
      targets: { listTargets, getTarget: vi.fn().mockResolvedValue({ id: 'tgt-1', name: '系统甲' }) },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(listTargets).toHaveBeenCalledWith(expect.objectContaining({ search: '系统甲' }), ctx.actor)
    expect(listBusinessRecords).toHaveBeenCalledWith(ctx.db, 'tgt-1', expect.objectContaining({
      entityType: 'supplier', cursor: undefined,
    }), ctx.actor.id)
    expect(result.scope.targetId).toBe('tgt-1')
  })

  it('明确点名的目标不可见时，不退回当前页面目标', async () => {
    const question = '列出系统甲的供应商'
    const ctx = mockContext({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-2' } },
      slots: { targetId: 'tgt-2', entityType: 'supplier' },
      targets: { listTargets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(result.candidates).toEqual([])
    expect(result.scope.targetId).toBeUndefined()
    expect(result.message).toContain('当前权限范围内没有匹配的目标')
    expect(listBusinessRecords).not.toHaveBeenCalled()
  })

  it('全局时间问法不把“现在都”误当目标名称', async () => {
    vi.mocked(listBusinessRecords).mockRejectedValueOnce(
      new (DomainError as any)('not_found', 'BUSINESS_SOURCE_NOT_FOUND', '未找到数据源'),
    )
    const question = '现在都有哪些厂家？'
    const listTargets = vi.fn()
    const ctx = mockContext({
      question,
      body: { question, pageContext: { page: 'target', targetId: 'tgt-1' } },
      targets: { listTargets, getTarget: vi.fn().mockResolvedValue({ id: 'tgt-1', name: 'ERP系统' }) },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(listTargets).not.toHaveBeenCalled()
    expect(result.message).toContain('目标配置 - 数据集')
  })

  it('有供应商快照但未记录采集时点时，区分采集时间与导入时间', async () => {
    vi.mocked(listBusinessRecords).mockResolvedValueOnce({
      items: [{
        id: 'supplier-1', snapshotId: 'snapshot-1', targetId: 'tgt-1',
        entityType: 'supplier', recordKey: 'SUP-001', displayName: '华东物料供应',
        recordStatus: 'active', originalDatasetId: 'dataset-1', datasetRowId: 'row-1',
        datasetRowIndex: 0, payload: { name: '华东物料供应' },
        createdAt: '2026-09-23T10:00:00.000Z',
      }],
      snapshotId: 'snapshot-1', bindingRevision: 2,
      coverage: {
        status: 'complete', completenessBasis: '快照全量扫描校验',
        sourceName: '供应商主数据.xlsx', observedAt: null,
        importedAt: '2026-09-23T09:00:00.000Z',
      },
    })
    const result = await handleTargetBusinessRecordsList(mockContext({
      question: '这个目标里有哪些供应商？',
    }))
    expect(result.candidates.map((item) => item.name)).toEqual(['华东物料供应'])
    expect(result.message).toContain('来源数据集「供应商主数据.xlsx」')
    expect(result.message).toContain('源数据采集时间未记录')
    expect(result.message).toContain('数据集导入时间：2026-09-23T09:00:00.000Z')
    expect(result.message).not.toContain('源数据采集时间：2026-09-23T09:00:00.000Z')
  })

  it('没有明确实体时不默认查询厂家记录', async () => {
    const ctx = mockContext({
      question: '查一下这个目标的业务记录',
      slots: { targetId: 'tgt-1' },
    })
    const result = await handleTargetBusinessRecordsList(ctx)
    expect(result.candidates).toEqual([])
    expect(result.message).toContain('请明确要查')
    expect(listBusinessRecords).not.toHaveBeenCalled()
  })
})
