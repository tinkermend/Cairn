import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { listAssetReliabilityItems } from '../reliability/metrics.js'
import { listIncidentSignals } from '../reliability/incidents.js'
import { RELIABILITY_ERROR_CODES } from '@cairn/shared'

describe.each(DRIVERS)('%s reliability assets and signals domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string
  let consoleAccountId: string
  let scenarioId: string
  let moduleId: string
  let incidentId: string
  let groupingKey: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()
    consoleAccountId = newId()

    await handle.db.insert(t.consoleAccounts).values({
      id: consoleAccountId,
      username: `admin-${consoleAccountId.slice(0, 8)}`,
      displayName: '管理员',
      passwordHash: 'hash',
      status: 'active',
    })

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '资产健康与信号测试目标',
      entryUrl: 'https://example.com',
      status: 'active',
      sessionPolicy: { maxLifetimeSeconds: 3600, idleTimeoutSeconds: 300, maxTotalSessions: 5, accountStrategy: 'exclusive' },
      resolutionPolicy: { timeoutMs: 5000, retryLimit: 2, fallbackPriority: ['map', 'ai'] },
    })

    // Create scenario
    scenarioId = newId()
    await handle.db.insert(t.scenarios).values({
      id: scenarioId,
      targetId,
      name: '订单搜索场景',
      createdByConsoleAccountId: consoleAccountId,
    })

    // Create action module
    moduleId = newId()
    await handle.db.insert(t.actionModules).values({
      id: moduleId,
      targetId,
      key: `module-${moduleId.slice(0, 8)}`,
      name: '登录验证模块',
      createdByConsoleAccountId: consoleAccountId,
      updatedByConsoleAccountId: consoleAccountId,
    })

    // Create incident affecting scenarioId
    incidentId = newId()
    groupingKey = `gk:${targetId}:${scenarioId}:step-1`
    const now = new Date()

    await handle.db.insert(t.reliabilityIncidents).values({
      id: incidentId,
      targetId,
      groupingKey,
      scopeDigest: `target:${targetId}`,
      severity: 'P2',
      status: 'ACTION_REQUIRED',
      memberCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      title: '订单搜索按钮定位漂移',
      summary: '订单搜索按钮在近5次运行中3次发生回退',
      evidenceScores: { supportingScore: 80, counterScore: 5, supportingFactors: ['回退激增'], counterFactors: [] },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })

    // Create signals for this incident
    for (let i = 0; i < 3; i++) {
      await handle.db.insert(t.reliabilitySignals).values({
        id: newId(),
        targetId,
        kind: 'resolution_fallback',
        severity: 'WARN',
        subjectRef: { kind: 'scenario_step', id: 'step-1', scenarioId },
        sourceRef: { kind: 'attempt', id: newId() },
        occurredAt: new Date(now.getTime() - i * 60000),
        scopeDigest: `target:${targetId}`,
        groupingKey,
        availability: 'available',
      })
    }
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('listAssetReliabilityItems lists scenarios and modules with health metrics', async () => {
    const res = await listAssetReliabilityItems(handle.db, { targetId })
    expect(res.total).toBeGreaterThanOrEqual(2)

    const scenarioItem = res.items.find((i) => i.assetId === scenarioId)
    expect(scenarioItem).toBeDefined()
    expect(scenarioItem?.assetName).toBe('订单搜索场景')
    expect(scenarioItem?.assetType).toBe('scenario')
    expect(scenarioItem?.activeIncidentsCount).toBe(1)
    expect(scenarioItem?.highestSeverity).toBe('P2')
    expect(scenarioItem?.status).toBe('degraded')

    const moduleItem = res.items.find((i) => i.assetId === moduleId)
    expect(moduleItem).toBeDefined()
    expect(moduleItem?.assetName).toBe('登录验证模块')
    expect(moduleItem?.assetType).toBe('action_module')
    expect(moduleItem?.activeIncidentsCount).toBe(0)
  })

  it('listAssetReliabilityItems filters by assetType and status', async () => {
    const scenarioOnly = await listAssetReliabilityItems(handle.db, { targetId, assetType: 'scenario' })
    expect(scenarioOnly.items.every((i) => i.assetType === 'scenario')).toBe(true)

    const moduleOnly = await listAssetReliabilityItems(handle.db, { targetId, assetType: 'action_module' })
    expect(moduleOnly.items.every((i) => i.assetType === 'action_module')).toBe(true)

    const degradedOnly = await listAssetReliabilityItems(handle.db, { targetId, status: 'degraded' })
    expect(degradedOnly.items.some((i) => i.assetId === scenarioId)).toBe(true)
    expect(degradedOnly.items.some((i) => i.assetId === moduleId)).toBe(false)
  })

  it('listIncidentSignals returns paginated signals for the incident', async () => {
    const res = await listIncidentSignals(handle.db, incidentId, { limit: 2 })
    expect(res.items.length).toBe(2)
    expect(res.total).toBe(3)
    expect(res.nextCursor).toBeDefined()
    expect(res.items[0].kind).toBe('resolution_fallback')
    expect(res.items[0].groupingKey).toBe(groupingKey)
  })

  it('listIncidentSignals throws 404 for unknown incident', async () => {
    await expect(listIncidentSignals(handle.db, newId())).rejects.toMatchObject({
      code: RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND,
    })
  })
})
