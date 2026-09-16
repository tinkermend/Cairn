import { describe, expect, it, vi, beforeEach } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import type { DbHandle } from '@cairn/db'
import type { RequestAccount } from '../common/request-account'
import { MapService } from './map.service'

const facts = vi.hoisted(() => ({ get: vi.fn(), impacts: vi.fn() }))
vi.mock('@cairn/db', async importOriginal => ({ ...await importOriginal<typeof import('@cairn/db')>(), getMapFact: facts.get, loadMapImpactSource: facts.impacts }))
const targetId = '11111111-1111-4111-8111-111111111111'
const factId = '22222222-2222-4222-8222-222222222222'
const observation = (sourceType = 'formal_run') => ({
  type: 'observation', ingestSeq: 1, contentAvailability: 'available', sourceAvailability: 'live',
  observation: { sourceType, sourceRef: { sourceType }, evidenceRefs: [{ kind: 'object', objectKey: 'internal/private/path', objectId: factId, availability: 'available' }] },
})
const verification = () => ({
  type: 'verification', ingestSeq: 2, contentAvailability: 'available', sourceAvailability: 'unknown',
  verification: { observationIds: [factId], verificationSource: { kind: 'rule', runId: factId }, evidenceRefs: [] },
})
const account = (permissions: RequestAccount['permissions']): RequestAccount => ({ id: factId, displayName: 'reader', email: null, status: 'active', roles: [], permissions })
const service = new MapService({} as DbHandle)

beforeEach(() => vi.resetAllMocks())
describe('地图事实来源授权', () => {
  it('正式运行观察对缺少 run:read 的用户返回 404', async () => {
    facts.get.mockResolvedValue(observation())
    await expect(service.getFact(targetId, 'observation', factId, account(['map:read']))).rejects.toMatchObject({ status: 404 })
  })
  it('录制观察对缺少 workflow:read 的用户返回 404', async () => {
    facts.get.mockResolvedValue(observation('recorder'))
    await expect(service.getFact(targetId, 'observation', factId, account(['map:read', 'run:read']))).rejects.toMatchObject({ status: 404 })
  })
  it('评价事实也校验 evaluator 的运行权限', async () => {
    facts.get.mockResolvedValueOnce(verification()).mockResolvedValueOnce(observation())
    await expect(service.getFact(targetId, 'verification', factId, account(['map:read']))).rejects.toMatchObject({ status: 404 })
  })
  it('评价事实的录制观察引用不能越过 workflow 权限', async () => {
    facts.get.mockResolvedValueOnce(verification()).mockResolvedValueOnce(observation('recorder'))
    await expect(service.getFact(targetId, 'verification', factId, account(['map:read', 'run:read']))).rejects.toMatchObject({ status: 404 })
  })
  it('授权响应不返回 ObjectStore 原始路径，过期事实不返回正文', async () => {
    facts.get.mockResolvedValue(observation())
    const result = await service.getFact(targetId, 'observation', factId, account([...PERMISSIONS]))
    expect(JSON.stringify(result)).not.toContain('internal/private/path')
    expect(JSON.stringify(result)).toContain(factId)
    facts.get.mockResolvedValue({ ...observation(), contentAvailability: 'expired' })
    expect((await service.getFact(targetId, 'observation', factId, account([...PERMISSIONS])))?.payload).toBeUndefined()
  })
})

describe('地图影响分页', () => {
  it('相同场景的不同绑定可以翻页，换筛选不能复用游标', async () => {
    facts.impacts.mockResolvedValue({ restricted: false, changedAssetKeys: ['object:changed'], bindings: [
      { bindingId: targetId, scenarioId: targetId, stepId: targetId, assetRefKey: 'object:changed' },
      { bindingId: factId, scenarioId: targetId, stepId: factId, assetRefKey: 'object:changed' },
    ], candidates: [], visibleScenarioIds: [targetId], scannedScenarioIds: [targetId], scenarioNames: { [targetId]: '场景' } })
    const reader = account([...PERMISSIONS])
    const first = await service.listImpacts(targetId, { assetRefKey: 'object:changed', limit: 1 }, reader)
    expect(first?.nextCursor).toBeTruthy()
    const second = await service.listImpacts(targetId, { assetRefKey: 'object:changed', limit: 1, cursor: first!.nextCursor }, reader)
    expect(first!.items[0]!.bindingId).not.toBe(second!.items[0]!.bindingId)
    expect(second!.nextCursor).toBeUndefined()
    await expect(service.listImpacts(targetId, { assetRefKey: 'object:other', limit: 1, cursor: first!.nextCursor }, reader)).rejects.toMatchObject({ status: 409 })
  })
  it('隐藏来源不返回扫描数量、场景 ID 或名称', async () => {
    facts.impacts.mockResolvedValue({ restricted: true })
    expect(await service.listImpacts(targetId, { limit: 20 }, account(['map:read']))).toEqual({ items: [], restricted: true, notes: ['结果受权限限制'] })
  })
})
