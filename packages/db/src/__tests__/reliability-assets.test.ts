import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { getReliabilityOverview, listAssetReliabilityItems } from '../reliability/metrics.js'
import { getIncidentDetail, listIncidentSignals } from '../reliability/incidents.js'
import { getIncidentImpactSnapshot } from '../reliability/impact.js'
import { requestReliabilityEvaluation } from '../reliability/evaluations.js'
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

  it('filters every asset source to target:read and reliability:read scope', async () => {
    const t = schemaFor(handle.db)
    const otherTargetId = newId()
    const otherScenarioId = newId()
    const otherModuleId = newId()
    const otherIncidentId = newId()
    const now = new Date()

    await handle.db.insert(t.targets).values({
      id: otherTargetId,
      code: `other-${otherTargetId.slice(0, 8)}`,
      name: '不可见目标',
      entryUrl: 'https://other.example.com',
    })
    await handle.db.insert(t.scenarios).values({
      id: otherScenarioId,
      targetId: otherTargetId,
      name: '不可见场景',
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.actionModules).values({
      id: otherModuleId,
      targetId: otherTargetId,
      key: `other-${otherModuleId.slice(0, 8)}`,
      name: '不可见模块',
      createdByConsoleAccountId: consoleAccountId,
      updatedByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.reliabilityIncidents).values({
      id: otherIncidentId,
      targetId: otherTargetId,
      groupingKey: `gk:${otherTargetId}:${otherScenarioId}`,
      scopeDigest: `target:${otherTargetId}`,
      severity: 'P1',
      status: 'ACTION_REQUIRED',
      memberCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      title: '不可见事件',
      summary: '其他目标的事件',
      evidenceScores: { supportingScore: 80, counterScore: 5, supportingFactors: [], counterFactors: [] },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })

    async function actorWithScopes(targetRead: 'all' | 'selected', reliabilityRead: 'all' | 'selected') {
      const actorId = newId()
      await handle.db.insert(t.consoleAccounts).values({
        id: actorId,
        username: `viewer-${actorId.slice(0, 8)}`,
        displayName: '受限查看者',
        passwordHash: 'hash',
        status: 'active',
      })
      for (const [permission, mode] of [
        ['target:read', targetRead],
        ['reliability:read', reliabilityRead],
      ] as const) {
        const roleId = newId()
        await handle.db.insert(t.consoleRoles).values({ id: roleId, key: `reliability-${roleId}`, name: permission })
        await handle.db.insert(t.consoleRolePermissions).values({ consoleRoleId: roleId, permission })
        await handle.db.insert(t.consoleAccountRoles).values({
          consoleAccountId: actorId,
          consoleRoleId: roleId,
          targetScopeMode: mode,
          targetScopeIds: mode === 'selected' ? [targetId] : [],
        })
      }
      return actorId
    }

    const configurableActorId = await actorWithScopes('all', 'selected')
    const readOnlyActorId = await actorWithScopes('selected', 'all')
    const configureRoleId = newId()
    await handle.db.insert(t.consoleRoles).values({ id: configureRoleId, key: `reliability-${configureRoleId}`, name: '评估配置' })
    await handle.db.insert(t.consoleRolePermissions).values({ consoleRoleId: configureRoleId, permission: 'reliability:configure' })
    await handle.db.insert(t.consoleAccountRoles).values({
      consoleAccountId: configurableActorId,
      consoleRoleId: configureRoleId,
      targetScopeMode: 'selected',
      targetScopeIds: [targetId],
    })

    for (const actorId of [configurableActorId, readOnlyActorId]) {
      const scoped = await listAssetReliabilityItems(handle.db, { limit: 100 }, actorId)
      expect(scoped.items.map((item) => item.assetId)).toContain(scenarioId)
      expect(scoped.items.map((item) => item.assetId)).toContain(moduleId)
      expect(scoped.items.map((item) => item.assetId)).not.toContain(otherScenarioId)
      expect(scoped.items.map((item) => item.assetId)).not.toContain(otherModuleId)
      expect(scoped.total).toBe(2)

      const foreignOnly = await listAssetReliabilityItems(handle.db, { targetId: otherTargetId }, actorId)
      expect(foreignOnly).toEqual({ items: [], nextCursor: null, total: 0 })
      expect((await listAssetReliabilityItems(handle.db, { targetId }, actorId)).total).toBe(2)

      await expect(getReliabilityOverview(handle.db, otherTargetId, actorId)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
      await expect(getIncidentDetail(handle.db, otherIncidentId, actorId)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
      await expect(listIncidentSignals(handle.db, otherIncidentId, undefined, actorId)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
      await expect(getIncidentImpactSnapshot(handle.db, otherIncidentId, actorId)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })

      expect((await getReliabilityOverview(handle.db, targetId, actorId)).targetId).toBe(targetId)
      expect((await getIncidentDetail(handle.db, incidentId, actorId)).incident.id).toBe(incidentId)
      expect((await listIncidentSignals(handle.db, incidentId, undefined, actorId)).total).toBe(3)
      expect((await getIncidentImpactSnapshot(handle.db, incidentId, actorId)).incidentId).toBe(incidentId)
    }

    await expect(requestReliabilityEvaluation(handle.db, otherTargetId, configurableActorId))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(requestReliabilityEvaluation(handle.db, targetId, readOnlyActorId))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect((await requestReliabilityEvaluation(handle.db, targetId, configurableActorId)).requested).toBe(true)

    const unrestricted = await listAssetReliabilityItems(handle.db, { limit: 100 })
    expect(unrestricted.items.map((item) => item.assetId)).toContain(otherScenarioId)
    expect(unrestricted.items.map((item) => item.assetId)).toContain(otherModuleId)
  })
})
