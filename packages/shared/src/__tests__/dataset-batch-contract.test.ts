import { describe, expect, it } from 'vitest'
import {
  batchDetailSchema,
  datasetDetailSchema,
  deleteDatasetBodySchema,
  deleteDatasetResponseSchema,
} from '../index.js'

const datasetId = '11111111-1111-4111-8111-111111111111'

describe('数据集与批次契约', () => {
  it('删除只接受确认标识，成功响应是 deleted: true', () => {
    expect(deleteDatasetBodySchema.parse({ confirmation: datasetId })).toEqual({
      confirmation: datasetId,
    })
    expect(() => deleteDatasetBodySchema.parse({ confirmation: datasetId, expectedCounts: {} })).toThrow()
    expect(() => deleteDatasetBodySchema.parse({})).toThrow()
    expect(deleteDatasetResponseSchema.parse({ deleted: true })).toEqual({ deleted: true })
    expect(() => deleteDatasetResponseSchema.parse({ deleted: false })).toThrow()
  })

  it('创建人可以是空，不能是 system', () => {
    const dataset = {
      id: datasetId,
      name: '名单',
      targetId: '22222222-2222-4222-8222-222222222222',
      sourceType: 'csv' as const,
      sourceFilename: 'a.csv',
      rowCount: 1,
      columns: [{ name: '名', key: 'name', type: 'string' as const, sampleValues: [] as string[] }],
      createdByAccountId: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    }
    expect(datasetDetailSchema.parse(dataset).createdByAccountId).toBeNull()
    expect(() => datasetDetailSchema.parse({ ...dataset, createdByAccountId: 'system' })).toThrow()

    const batch = {
      id: '33333333-3333-4333-8333-333333333333',
      name: '批次',
      scenarioId: '44444444-4444-4444-8444-444444444444',
      scenarioVersionId: '55555555-5555-4555-8555-555555555555',
      datasetId,
      status: 'QUEUED' as const,
      failurePolicy: 'stop_on_threshold' as const,
      failureThreshold: 5,
      pacingConfig: { minDelayMs: 1500, maxDelayMs: 3500 },
      totalItems: 1,
      successItems: 0,
      failedItems: 0,
      reviewItems: 0,
      createdByAccountId: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    }
    expect(batchDetailSchema.parse(batch).createdByAccountId).toBeNull()
    expect(() => batchDetailSchema.parse({ ...batch, createdByAccountId: 'system' })).toThrow()
  })
})
