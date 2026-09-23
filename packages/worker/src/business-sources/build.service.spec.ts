import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BusinessSourceBuildService } from './build.service.js'

const {
  claimBusinessSourceBuildJob,
  commitBusinessSourceBatch,
  finishBusinessSourceBuild,
  getDatasetRows,
} = vi.hoisted(() => ({
  claimBusinessSourceBuildJob: vi.fn(),
  commitBusinessSourceBatch: vi.fn(),
  finishBusinessSourceBuild: vi.fn(),
  getDatasetRows: vi.fn(),
}))

vi.mock('@cairn/db', () => ({
  claimBusinessSourceBuildJob,
  commitBusinessSourceBatch,
  finishBusinessSourceBuild,
  getDatasetRows,
}))

describe('BusinessSourceBuildService', () => {
  let service: BusinessSourceBuildService
  const mockHandle = {} as any
  const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as any

  beforeEach(() => {
    vi.resetAllMocks()
    mockBus.publish = vi.fn().mockResolvedValue(undefined)
    service = new BusinessSourceBuildService(mockHandle, mockBus)
  })

  it('成功校验多行数据，批量写入投影并更新为 ready', async () => {
    const candidate = {
      id: 'cand-1',
      targetId: 'tgt-1',
      entityType: 'manufacturer',
      datasetId: 'ds-1',
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        statusColumn: 'status',
        fieldWhitelist: ['code', 'name', 'status'],
        sensitiveFields: ['password'],
      },
    }

    claimBusinessSourceBuildJob.mockResolvedValueOnce(candidate).mockResolvedValueOnce(null)
    getDatasetRows.mockResolvedValueOnce({
      items: [
        {
          id: 'row-1',
          rowIndex: 0,
          rowData: { code: 'MFG-1', name: 'Alpha Tech', status: 'active', other: 'secret_info' },
        },
        {
          id: 'row-2',
          rowIndex: 1,
          rowData: { code: 'MFG-2', name: 'Beta Ltd', status: 'pending', other: 'misc' },
        },
      ],
      nextCursor: undefined,
    })

    const result = await service.tick(2)
    expect(result.processed).toBe(1)

    // Verify projection records committed
    expect(commitBusinessSourceBatch).toHaveBeenCalledTimes(1)
    const committedRecords = commitBusinessSourceBatch.mock.calls[0][2]
    expect(committedRecords).toHaveLength(2)
    expect(committedRecords[0].recordKey).toBe('MFG-1')
    expect(committedRecords[0].displayName).toBe('Alpha Tech')
    expect(committedRecords[0].payload).toEqual({ code: 'MFG-1', name: 'Alpha Tech', status: 'active' })
    expect(committedRecords[0].payload.other).toBeUndefined() // filtered out!

    // Verify finished with ready
    expect(finishBusinessSourceBuild).toHaveBeenCalledWith(
      mockHandle,
      'cand-1',
      expect.objectContaining({
        status: 'ready',
        summary: expect.objectContaining({
          totalRows: 2,
          validCount: 2,
          rejectedCount: 0,
        }),
      }),
    )
    expect(mockBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'target_business_source',
        candidateId: 'cand-1',
        status: 'ready',
      }),
    )
  })

  it('遇到重复业务主键时立即拒绝并标记 rejected', async () => {
    const candidate = {
      id: 'cand-dup',
      targetId: 'tgt-1',
      entityType: 'manufacturer',
      datasetId: 'ds-1',
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        fieldWhitelist: ['code', 'name'],
      },
    }

    claimBusinessSourceBuildJob.mockResolvedValueOnce(candidate).mockResolvedValueOnce(null)
    getDatasetRows.mockResolvedValueOnce({
      items: [
        { id: 'row-1', rowIndex: 0, rowData: { code: 'SAME-KEY', name: 'Alpha' } },
        { id: 'row-2', rowIndex: 1, rowData: { code: 'SAME-KEY', name: 'Beta' } },
      ],
      nextCursor: undefined,
    })

    await service.tick(1)

    expect(finishBusinessSourceBuild).toHaveBeenCalledWith(
      mockHandle,
      'cand-dup',
      expect.objectContaining({
        status: 'rejected',
        summary: expect.objectContaining({
          totalRows: 2,
          validCount: 1,
          rejectedCount: 1,
          issues: expect.arrayContaining([
            expect.objectContaining({
              reason: expect.stringContaining('出现重复'),
            }),
          ]),
        }),
      }),
    )
  })

  it('白名单中出现敏感字段时直接标记 rejected 且不扫描行', async () => {
    const candidate = {
      id: 'cand-sensitive',
      targetId: 'tgt-1',
      entityType: 'manufacturer',
      datasetId: 'ds-1',
      mappingConfig: {
        keyColumn: 'code',
        displayNameColumn: 'name',
        fieldWhitelist: ['code', 'name', 'account_password'],
      },
    }

    claimBusinessSourceBuildJob.mockResolvedValueOnce(candidate).mockResolvedValueOnce(null)

    await service.tick(1)

    expect(getDatasetRows).not.toHaveBeenCalled()
    expect(finishBusinessSourceBuild).toHaveBeenCalledWith(
      mockHandle,
      'cand-sensitive',
      expect.objectContaining({
        status: 'rejected',
        summary: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              reason: expect.stringContaining('敏感阻断'),
            }),
          ]),
        }),
      }),
    )
  })
})
