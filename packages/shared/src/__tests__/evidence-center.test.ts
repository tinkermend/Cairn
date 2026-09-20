import { describe, expect, it } from 'vitest'
import { OBJECT_MISSING_REASONS } from '../object-store.js'
import {
  CLEANUP_FAILURE_MIN_ATTEMPTS,
  EVIDENCE_DISPLAY_STATUS_LABELS,
  evidenceSearchQuerySchema,
  isCaptureUploadMissingReason,
  isCleanupFailed,
  liftsEvidenceTimeWindow,
  normalizeEvidenceSearchQuery,
  projectEvidenceDisplay,
  sortKeyForEvidenceView,
  tallyKnownBytes,
  evidenceErrorSummary,
} from '../evidence-center.js'

const asOf = '2026-09-19T12:00:00.000Z'

describe('isCleanupFailed / tallyKnownBytes', () => {
  it('失败判据是尝试次数或错误时间，已 purged 不算失败', () => {
    expect(
      isCleanupFailed({ status: 'available', purgeAttempts: 5, lastPurgeErrorAt: null }),
    ).toBe(true)
    expect(
      isCleanupFailed({
        status: 'pending',
        purgeAttempts: 1,
        lastPurgeErrorAt: '2026-09-19T00:00:00.000Z',
      }),
    ).toBe(true)
    expect(
      isCleanupFailed({ status: 'available', purgeAttempts: 4, lastPurgeErrorAt: null }),
    ).toBe(false)
    expect(
      isCleanupFailed({ status: 'purged', purgeAttempts: 9, lastPurgeErrorAt: '2026-09-19T00:00:00.000Z' }),
    ).toBe(false)
    expect(CLEANUP_FAILURE_MIN_ATTEMPTS).toBe(5)
  })

  it('未知字节单独计数，不按 0 汇总', () => {
    expect(tallyKnownBytes([10, null, undefined, 5])).toEqual({ knownBytes: 15, unknownCount: 2 })
    expect(tallyKnownBytes([null, null])).toEqual({ knownBytes: 0, unknownCount: 2 })
  })
})

describe('projectEvidenceDisplay', () => {
  it('pending 为收集中', () => {
    const result = projectEvidenceDisplay({ evidenceStatus: 'pending', asOf })
    expect(result.displayStatus).toBe('collecting')
    expect(result.filterBuckets).toContain('collecting')
    expect(EVIDENCE_DISPLAY_STATUS_LABELS[result.displayStatus]).toBe('收集中')
  })

  it('无对象的 available 为可查看结构化', () => {
    const result = projectEvidenceDisplay({ evidenceStatus: 'available', asOf })
    expect(result.displayStatus).toBe('available_structured')
    expect(result.filterBuckets).toContain('available')
  })

  it('采集失败不因对象状态改写', () => {
    const result = projectEvidenceDisplay({
      evidenceStatus: 'missing',
      missingReason: OBJECT_MISSING_REASONS.captureFailed,
      objectStatus: 'purged',
      purgeReason: 'expired',
      asOf,
    })
    expect(result.displayStatus).toBe('capture_upload_anomaly')
    expect(result.filterBuckets).toEqual(['capture_upload_anomaly'])
    expect(result.reasonCode).toBe('capture_failed')
  })

  it('object_purged 联查 purgeReason 区分到期、运行删除和上传收尾', () => {
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'missing',
        missingReason: 'object_purged',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'purged',
        purgeReason: 'expired',
        asOf,
      }).displayStatus,
    ).toBe('policy_purged')
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'missing',
        missingReason: 'object_purged',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'purged',
        purgeReason: 'run_deleted',
        asOf,
      }).displayStatus,
    ).toBe('run_deleted')
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'missing',
        missingReason: 'object_purged',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'purged',
        purgeReason: 'upload_incomplete',
        asOf,
      }).filterBuckets,
    ).toContain('capture_upload_anomaly')
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'missing',
        missingReason: 'object_purged',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'purged',
        asOf,
      }).displayStatus,
    ).toBe('purged_unknown')
  })

  it('有指针但联不到账本为关联未知', () => {
    const result = projectEvidenceDisplay({
      evidenceStatus: 'available',
      objectId: '11111111-1111-4111-8111-111111111111',
      asOf,
    })
    expect(result.displayStatus).toBe('unlinked')
    expect(result.filterBuckets).toEqual(['unlinked'])
  })

  it('即将到期与已对外发布进入对应筛选桶', () => {
    const result = projectEvidenceDisplay({
      evidenceStatus: 'available',
      objectId: '11111111-1111-4111-8111-111111111111',
      objectStatus: 'available',
      retainUntil: '2026-09-22T12:00:00.000Z',
      externalAccess: true,
      asOf,
    })
    expect(result.displayStatus).toBe('available')
    expect(result.filterBuckets).toEqual(expect.arrayContaining(['available', 'expiring_soon', 'released']))
  })

  it('B2 状态 deleting / force 可投影且不混入到期清理', () => {
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'available',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'deleting',
        asOf,
      }).displayStatus,
    ).toBe('deleting')
    expect(
      projectEvidenceDisplay({
        evidenceStatus: 'missing',
        missingReason: 'object_purged',
        objectId: '11111111-1111-4111-8111-111111111111',
        objectStatus: 'purged',
        purgeReason: 'force',
        asOf,
      }).displayStatus,
    ).toBe('force_purged')
  })
})

describe('evidenceSearchQuerySchema', () => {
  it('拒绝自由文本等未定义参数', () => {
    expect(() => evidenceSearchQuerySchema.parse({ q: '登录失败' })).toThrow()
    expect(() => evidenceSearchQuerySchema.parse({ keyword: 'err' })).toThrow()
    expect(() => evidenceSearchQuerySchema.parse({ search: 'trace' })).toThrow()
  })

  it('接受结构化多选与完整 ID', () => {
    const parsed = evidenceSearchQuerySchema.parse({
      types: 'screenshot,video',
      runId: '11111111-1111-4111-8111-111111111111',
      availability: ['available', 'purged'],
    })
    expect(parsed.types).toEqual(['screenshot', 'video'])
    expect(parsed.runId).toBe('11111111-1111-4111-8111-111111111111')
    expect(liftsEvidenceTimeWindow(parsed)).toBe(true)
  })

  it('默认 7 天窗；指定 runId 解除时间限制；预置视图决定排序', () => {
    const now = new Date('2026-09-19T12:00:00.000Z')
    const def = normalizeEvidenceSearchQuery(evidenceSearchQuerySchema.parse({}), now)
    expect(def.timePreset).toBe('7d')
    expect(def.createdFrom?.toISOString()).toBe('2026-09-12T12:00:00.000Z')
    expect(def.sort).toBe('createdAt_desc')

    const byId = normalizeEvidenceSearchQuery(
      evidenceSearchQuerySchema.parse({ runId: '11111111-1111-4111-8111-111111111111' }),
      now,
    )
    expect(byId.timeWindowLifted).toBe(true)
    expect(byId.createdFrom).toBeUndefined()
    expect(sortKeyForEvidenceView('expiring_soon')).toBe('retainUntil_asc')
    expect(sortKeyForEvidenceView('purge_failed')).toBe('lastPurgeErrorAt_desc')

    const bySuite = normalizeEvidenceSearchQuery(
      evidenceSearchQuerySchema.parse({ suiteId: '11111111-1111-4111-8111-111111111111' }),
      now,
    )
    expect(bySuite.timeWindowLifted).toBe(true)
    expect(bySuite.createdFrom).toBeUndefined()
    expect(() => evidenceSearchQuerySchema.parse({ memberId: 'm1' })).toThrow(/suiteRunId/)
  })
})

describe('helpers', () => {
  it('错误摘要只取安全字段', () => {
    expect(evidenceErrorSummary({ safeMessage: '账号被锁', secret: 'x' })).toBe('账号被锁')
    expect(isCaptureUploadMissingReason('upload_incomplete')).toBe(true)
    expect(isCaptureUploadMissingReason('object_purged')).toBe(false)
  })
})
