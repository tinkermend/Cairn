import { describe, expect, it, vi } from 'vitest'
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
    body: { question: '列出厂家记录' },
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
    expect(result.message).toContain('检索到 1 条「manufacturer」业务记录')
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
    expect(result.message).toContain('暂未配置或启用「manufacturer」业务数据快照来源')
  })
})
