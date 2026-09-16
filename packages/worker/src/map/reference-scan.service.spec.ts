import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@cairn/db'
import { advanceMapReferenceScans } from './reference-scan.service'
const mocks = vi.hoisted(() => ({ work: vi.fn(), source: vi.fn(), advance: vi.fn() }))
vi.mock('@cairn/db', () => ({ listMapReferenceScanWork: mocks.work, loadTargetScanSource: mocks.source, advanceMapReferenceScan: mocks.advance }))
describe('引用扫描 Worker', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([1, 2])('V%s 从持久化水位继续下一批，附带原水位防止多 Worker 重复推进', async (version) => {
    const requestedAt = new Date('2026-09-16T00:00:00Z')
    mocks.work.mockResolvedValue([{ targetId: 'target', lastScenarioId: 'previous', requestedAt }])
    const step = { id: '11111111-1111-4111-8111-111111111111', name: '查询订单', type: 'echo', effectType: 'READ_ONLY', outputKey: 'value', input: { value: '订单' } }
    const document = version === 1
      ? { schemaVersion: 1, inputs: [], steps: [step] }
      : { authoringSchemaVersion: 2, inputs: [], nodes: [{ kind: 'step', step }] }
    mocks.source.mockResolvedValue({ assets: [], scenarios: Array.from({ length: 9 }, (_, i) => ({ scenarioId: `s${i}`, document })) })
    mocks.advance.mockResolvedValue({ scanned: 8, complete: false })
    await advanceMapReferenceScans({} as DbHandle)
    expect(mocks.source).toHaveBeenCalledWith(expect.anything(), 'target', { afterScenarioId: 'previous', limit: 9 })
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetId: 'target', expectedLastScenarioId: 'previous', requestedAt, complete: false }))
    expect(mocks.advance.mock.calls[0]![1].batch).toHaveLength(8)
  })
})
