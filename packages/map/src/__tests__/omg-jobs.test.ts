import { describe, expect, it } from 'vitest'
import { compileMapJobSlice, isUnsafeMapActionName, selectMapJobAssets } from '../jobs.js'
import { FACTORY_MAP_JOB_POLICY, type MapSafeEntry } from '@cairn/shared'

const targetId = '00000000-0000-4000-8000-000000000010'
const objectA = '00000000-0000-4000-8000-000000000011'
const objectB = '00000000-0000-4000-8000-000000000012'
const descriptor = { framePath: [], candidates: [{ by: 'role' as const, value: 'heading', name: '订单' }] }

const entry: MapSafeEntry = {
  entryId: '00000000-0000-4000-8000-000000000013',
  version: 1,
  name: '订单入口',
  url: 'https://shop.example/orders',
  arrivalName: '订单标题',
  arrivalTarget: descriptor,
  safetyBasis: {
    kind: 'confirmed_path',
    summary: '只读复查已确认路径',
    confirmedBy: '00000000-0000-4000-8000-000000000014',
    confirmedAt: '2026-09-16T00:00:00.000Z',
  },
  jobKinds: ['map_probe', 'map_refresh'],
}

describe('OM-G 选点与编译', () => {
  it('OMG03 提交/删除名称不编译', () => {
    expect(isUnsafeMapActionName('提交订单')).toBe(true)
    const compiled = compileMapJobSlice({
      jobKind: 'map_refresh',
      entry: { ...entry, name: '提交订单' },
      included: [],
    })
    expect(compiled.ok).toBe(false)
  })

  it('OMG07 配额截断并解释未纳入', () => {
    const items = selectMapJobAssets(
      'map_probe',
      { ...FACTORY_MAP_JOB_POLICY, maxProbePages: 1, maxProbeObjects: 1 },
      [
        { assetRef: { targetId, objectId: objectA }, name: '订单号', importance: 2, failed: true, stale: false, descriptor },
        { assetRef: { targetId, objectId: objectB }, name: '金额', importance: 1, failed: false, stale: true, descriptor },
      ],
      [],
    )
    expect(items.filter((item) => item.included)).toHaveLength(1)
    expect(items[0]?.reason).toContain('失败')
  })

  it('探针只编译进入步骤', () => {
    const compiled = compileMapJobSlice({
      jobKind: 'map_probe',
      entry,
      included: [{ assetRef: { targetId, objectId: objectA }, name: '订单号', importance: 1, failed: false, stale: false, descriptor }],
    })
    expect(compiled).toMatchObject({ ok: true })
    if (compiled.ok) {
      expect(compiled.steps).toHaveLength(2)
      expect(compiled.steps.every((step) => step.effectType === 'READ_ONLY')).toBe(true)
    }
  })
})
