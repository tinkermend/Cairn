import { beforeEach, describe, expect, it, vi } from 'vitest'

const listMapProjectionWork = vi.fn()
const ensureMapProjection = vi.fn()
const getMapProjection = vi.fn()
const loadMapProjectionWorkingSet = vi.fn()
const readMapFacts = vi.fn()
const commitMapProjectionBatch = vi.fn()
const recordMapProjectionFailure = vi.fn()
const projectionWorkingSetHints = vi.fn(() => ({
  pageAllocationKeys: ['page:v1:top:orders:top'],
  objectAllocationKeys: ['object:v1:n001-btn'],
  observationIds: [],
}))

vi.mock('@cairn/db', () => ({
  listMapProjectionWork,
  ensureMapProjection,
  getMapProjection,
  loadMapProjectionWorkingSet,
  readMapFacts,
  commitMapProjectionBatch,
  recordMapProjectionFailure,
  DomainError: class DomainError extends Error {
    code: string
    constructor(kind: string, code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

vi.mock('@cairn/map', () => ({
  projectionWorkingSetHints,
  planProjectionBatch: vi.fn(() => ({
    protocol: 'map-assets@1',
    algorithmVersion: 'map-identity@1',
    pages: [],
    objects: [],
    assignments: [],
    implementations: [],
    descriptors: [],
    assets: [],
    conflicts: [],
    nextCursor: 1,
  })),
}))

describe('MapProjectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tick 组合 map 规划与 db 提交，不另写算法', async () => {
    const { advanceMapProjections } = await import('./projection.service.js')
    const { planProjectionBatch } = await import('@cairn/map')
    listMapProjectionWork.mockResolvedValue([
      {
        targetId: '11111111-1111-4111-8111-111111111111',
        projectionId: '22222222-2222-4222-8222-222222222222',
        status: 'active',
        cursor: 0,
        revision: 0,
        committedSeq: 2,
      },
    ])
    getMapProjection.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      targetId: '11111111-1111-4111-8111-111111111111',
      cursor: 0,
      revision: 0,
    })
    loadMapProjectionWorkingSet.mockResolvedValue({
      targetId: '11111111-1111-4111-8111-111111111111',
      projectionId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      status: 'active',
      cursor: 0,
      revision: 0,
      identityRevision: 0,
      pages: [],
      objects: [],
      implementations: [],
      descriptors: [],
      assignments: [],
      assets: [],
      aliases: [],
    })
    readMapFacts.mockResolvedValue({ facts: [], committedSeq: 2, throughSeq: 2, nextSeq: 0 })
    commitMapProjectionBatch.mockResolvedValue({ cursor: 1, revision: 1, status: 'active' })
    const result = await advanceMapProjections({} as never, { limit: 1 })
    expect(result.advanced).toBe(1)
    expect(projectionWorkingSetHints).toHaveBeenCalled()
    expect(loadMapProjectionWorkingSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectionId: '22222222-2222-4222-8222-222222222222',
        pageAllocationKeys: ['page:v1:top:orders:top'],
      }),
    )
    expect(planProjectionBatch).toHaveBeenCalled()
    expect(commitMapProjectionBatch).toHaveBeenCalled()
    expect(recordMapProjectionFailure).not.toHaveBeenCalled()
  })
})
