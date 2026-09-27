import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  getMapJobPolicy,
  getTargetAccessPolicy,
  updateTargetAccessPolicy,
  requestRunCancel,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function probeSteps(): Step[] {
  return [
    {
      id: newId(),
      name: '打开入口',
      type: 'navigate',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { url: 'https://shop.example/orders' },
    },
    {
      id: newId(),
      name: '到达标题',
      type: 'assert',
      effectType: 'READ_ONLY',
      policy: { timeoutMs: 8_000, retryLimit: 0 },
      input: { target: { framePath: [], candidates: [{ by: 'role', value: 'heading', name: '订单' }] }, expect: { kind: 'visible' } },
    },
  ]
}

describe.each(DRIVERS)('%s 地图作业账本', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_omg_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-omg',
      email: `map-omg-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget(loginUrl?: string) {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `omg-${targetId}`,
      name: '作业夹具',
      entryUrl: 'https://shop.example/home',
      loginUrl: loginUrl ?? 'https://idp.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '作业账号',
      username: `ops-${accountId}`,
      status: 'active',
      usage: 'both',
      mapUsageGuard: 'Y',
    })
    return { targetId, accountId }
  }

  it('工厂政策默认关闭，新正式 Run 冻结授权且含认证域', async () => {
    const { targetId } = await freshTarget()
    const policy = await getMapJobPolicy(handle.db, targetId)
    expect(policy.policy.manualJobsEnabled).toBe(false)
    expect(policy.revision).toBe(0)
    const access = await getTargetAccessPolicy(handle.db, targetId)
    expect(access.seeded).toBe(true)
    expect(access.resourceLoadsUnrestricted).toBe(true)
    expect(access.policy?.postReadMode).toBeUndefined()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `正式-${newId().slice(0, 8)}`,
      actor: { kind: 'console', id: actorId },
      steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { kind: 'console', id: actorId },
    })
    expect(created.detail.snapshot.accessPolicy?.policy.rules.map((rule) => rule.purpose).sort()).toEqual([
      'authentication',
      'business_surface',
    ])
    expect(created.detail.snapshot.allowedOrigins).toEqual(expect.arrayContaining(['https://shop.example', 'https://idp.example']))
    expect(created.detail.snapshot.mapJob).toBeUndefined()
    expect(created.detail.snapshot.evidencePolicy?.screenshot).toBe('always')
    expect(created.detail.snapshot.evidencePolicy?.video).toBe('always')
  })

  it('平衡模式随目标访问策略修订冻结，恢复显式模式不改旧作业快照', async () => {
    const { targetId } = await freshTarget()
    const rules = [{ origin: 'https://shop.example', purpose: 'business_surface' as const, effect: 'allow' as const }]
    const balanced = await updateTargetAccessPolicy(handle.db, targetId, {
      expectedRevision: 0, idempotencyKey: `balanced:${targetId}`, reason: '允许受控推断查询',
      rules, postReadMode: 'balanced',
    }, actor())
    expect(balanced.policy?.postReadMode).toBe('balanced')
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId, name: `平衡-${newId().slice(0, 8)}`, actor: actor(), steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: actor() })
    expect(created.detail.snapshot.accessPolicy?.policy.postReadMode).toBe('balanced')
    const explicit = await updateTargetAccessPolicy(handle.db, targetId, {
      expectedRevision: balanced.revision, idempotencyKey: `explicit:${targetId}`, reason: '恢复显式模式',
      rules, postReadMode: 'explicit',
    }, actor())
    expect(explicit.policy?.postReadMode).toBeUndefined()
    expect(created.detail.snapshot.accessPolicy?.policy.postReadMode).toBe('balanced')
  })

  it('冻结 pathPrefix，路径级 deny 不掏空 allowedOrigins', async () => {
    const { targetId } = await freshTarget()
    await updateTargetAccessPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: 0,
        idempotencyKey: `path:${targetId}`.slice(0, 128),
        reason: '收窄业务路径',
        rules: [
          { origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow', pathPrefix: '/' },
          { origin: 'https://shop.example', purpose: 'business_surface', effect: 'deny', pathPrefix: '/admin' },
          { origin: 'https://idp.example', purpose: 'authentication', effect: 'allow' },
        ],
      },
      actor(),
    )
    const access = await getTargetAccessPolicy(handle.db, targetId)
    expect(access.policy?.rules.some((rule) => rule.pathPrefix === '/admin')).toBe(true)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `路径-${newId().slice(0, 8)}`,
      actor: { kind: 'console', id: actorId },
      steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { kind: 'console', id: actorId },
    })
    expect(created.detail.snapshot.accessPolicy?.policy.rules.some((rule) => rule.pathPrefix === '/admin')).toBe(true)
    expect(created.detail.snapshot.allowedOrigins).toEqual(
      expect.arrayContaining(['https://shop.example', 'https://idp.example']),
    )
    await requestRunCancel(handle.db, created.detail.id, actor())
  })

  it('非页面数据规则随访问策略修订冻结，且不授予请求访问', async () => {
    const { targetId } = await freshTarget()
    const rule = { method: 'POST' as const, resourceType: 'xhr' as const,
      origin: 'https://metrics.example', pathPattern: '/collect',
      evidence: '已核对前端调用，仅上报访问统计，不参与页面内容' }
    const updated = await updateTargetAccessPolicy(handle.db, targetId, {
      expectedRevision: 0, idempotencyKey: `noncontent:${targetId}`, reason: '记录已核实的非页面请求',
      rules: [
        { origin: 'https://shop.example', purpose: 'business_surface', effect: 'allow' },
        { origin: 'https://idp.example', purpose: 'authentication', effect: 'allow' },
      ],
      verifiedNonContentRequests: [rule],
    }, actor())
    expect(updated.policy?.verifiedNonContentRequests).toEqual([rule])
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId, name: `非页面-${newId().slice(0, 8)}`, actor: actor(), steps: probeSteps(),
    })
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: actor() })
    expect(created.detail.snapshot.accessPolicy?.policy.verifiedNonContentRequests).toEqual([rule])
    expect(created.detail.snapshot.allowedOrigins).not.toContain('https://metrics.example')
    await requestRunCancel(handle.db, created.detail.id, actor())
  })
})
