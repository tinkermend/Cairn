import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  dismissIncident,
  getIncidentDetail,
  listIncidents,
  mergeIncidents,
  resolveIncident,
  silenceIncident,
  splitIncidents,
  updateIncidentStatus,
} from '../reliability/incidents.js'
import { authorizeTargetRequest } from '../console/target-authorization.js'
import { RELIABILITY_ERROR_CODES } from '@cairn/shared'

describe.each(DRIVERS)('%s reliability incident triage domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '事件分类分诊目标',
      entryUrl: 'https://example.com',
      status: 'active',
      sessionPolicy: { maxLifetimeSeconds: 3600, idleTimeoutSeconds: 300, maxTotalSessions: 5, accountStrategy: 'exclusive' },
      resolutionPolicy: { timeoutMs: 5000, retryLimit: 2, fallbackPriority: ['map', 'ai'] },
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function createTestIncident(title: string, memberRefs: string[]) {
    const t = schemaFor(handle.db)
    const now = new Date()
    const id = newId()

    await handle.db.insert(t.reliabilityIncidents).values({
      id,
      targetId,
      groupingKey: `gk-${id}`,
      scopeDigest: `target:${targetId}`,
      severity: 'P3',
      status: 'DETECTED',
      memberCount: memberRefs.length,
      firstSeenAt: now,
      lastSeenAt: now,
      title,
      summary: `Summary of ${title}`,
      evidenceScores: { supportingScore: 50, counterScore: 10, supportingFactors: ['回退'], counterFactors: [] },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })

    for (const ref of memberRefs) {
      await handle.db.insert(t.reliabilityIncidentMembers).values({
        incidentId: id,
        memberRef: ref,
        memberType: 'attempt',
        joinedAt: now,
      })
    }

    return id
  }

  it('lists incidents and gets incident detail with members', async () => {
    const incId = await createTestIncident('测试事件 A', ['ref-1', 'ref-2'])

    const { items } = await listIncidents(handle.db, { targetId, status: 'DETECTED' })
    expect(items.some((i) => i.id === incId)).toBe(true)

    const detail = await getIncidentDetail(handle.db, incId)
    expect(detail.incident.id).toBe(incId)
    expect(detail.incident.memberCount).toBe(2)
    expect(detail.members.length).toBe(2)
    expect(detail.members.map((m) => m.memberRef).sort()).toEqual(['ref-1', 'ref-2'])
  })

  it('merges source incident into target incident with member reparenting', async () => {
    const sourceId = await createTestIncident('源事件 B', ['ref-3', 'ref-4'])
    const targetIncId = await createTestIncident('目标事件 C', ['ref-5'])

    const merged = await mergeIncidents(handle.db, {
      sourceIncidentIds: [sourceId],
      targetIncidentId: targetIncId,
      reason: '同属同类元素变更',
    })

    expect(merged.id).toBe(targetIncId)
    expect(merged.memberCount).toBe(3) // 1 + 2
    expect(merged.lineage?.mergedFrom).toContain(sourceId)

    // Source incident is marked RESOLVED with parent link
    const sourceDetail = await getIncidentDetail(handle.db, sourceId)
    expect(sourceDetail.incident.status).toBe('RESOLVED')
    expect(sourceDetail.incident.lineage?.parentIncidentId).toBe(targetIncId)

    // Members now belong to target
    const targetDetail = await getIncidentDetail(handle.db, targetIncId)
    expect(targetDetail.members.length).toBe(3)
  })

  it('splits incident members into a newly created incident', async () => {
    const origId = await createTestIncident('待拆分事件 D', ['m-1', 'm-2', 'm-3'])

    const { sourceIncident, newIncident } = await splitIncidents(handle.db, {
      incidentId: origId,
      memberRefs: ['m-2', 'm-3'],
      newTitle: '拆分出来的子事件',
      reason: '独立故障源',
    })

    expect(sourceIncident.id).toBe(origId)
    expect(sourceIncident.memberCount).toBe(1)
    expect(newIncident.title).toBe('拆分出来的子事件')
    expect(newIncident.memberCount).toBe(2)
    expect(newIncident.lineage?.splitFrom).toBe(origId)

    const newDetail = await getIncidentDetail(handle.db, newIncident.id)
    expect(newDetail.members.map((m) => m.memberRef).sort()).toEqual(['m-2', 'm-3'])
  })

  it('listIncidents filters by multiple statuses', async () => {
    const openId = await createTestIncident('未关闭事件 S1', ['ref-s1'])
    const closedId = await createTestIncident('已忽略事件 S2', ['ref-s2'])
    await dismissIncident(handle.db, { incidentId: closedId, reason: '测试' })

    const { items } = await listIncidents(handle.db, {
      targetId,
      statuses: ['DETECTED', 'DIAGNOSING', 'ACTION_REQUIRED', 'VERIFYING', 'OBSERVING'],
      limit: 100,
    })
    const ids = items.map((i) => i.id)
    expect(ids).toContain(openId)
    expect(ids).not.toContain(closedId)
  })

  it('dismisses an incident with reason and increments revision', async () => {
    const incId = await createTestIncident('待忽略事件 E', ['ref-6'])

    const dismissed = await dismissIncident(handle.db, {
      incidentId: incId,
      reason: '已确认是测试预期变动',
    })

    expect(dismissed.status).toBe('DISMISSED')
    expect(dismissed.dismissedReason).toBe('已确认是测试预期变动')
    expect(dismissed.revision).toBe(2)
  })

  it('silences an incident for a given duration', async () => {
    const incId = await createTestIncident('待静音事件 F', ['ref-7'])

    const silenced = await silenceIncident(handle.db, {
      incidentId: incId,
      durationHours: 24,
      reason: '等待新版本上线修复',
    })

    expect(silenced.silencedUntil).toBeDefined()
    const until = new Date(silenced.silencedUntil!)
    expect(until.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000)
    expect(silenced.revision).toBe(2)
  })

  it('resolves an incident with explicit audit reason', async () => {
    const incId = await createTestIncident('待归档事件 G', ['ref-8'])

    const resolved = await resolveIncident(handle.db, {
      incidentId: incId,
      reason: '已采纳修复补丁并完成 30 次稳定观察',
    })

    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.dismissedReason).toBe('已采纳修复补丁并完成 30 次稳定观察')
    expect(resolved.actionRequiredReason).toBeUndefined()
    expect(resolved.revision).toBe(2)
  })

  it('updates incident status to OBSERVING with reason', async () => {
    const incId = await createTestIncident('待观察事件 H', ['ref-9'])

    const observing = await updateIncidentStatus(handle.db, {
      incidentId: incId,
      status: 'OBSERVING',
      actionRequiredReason: null,
    })

    expect(observing.status).toBe('OBSERVING')
    expect(observing.revision).toBe(2)
  })

  it('detects revision conflict during merge or split', async () => {
    const sourceId = await createTestIncident('冲突源', ['c-1'])
    const targetIncId = await createTestIncident('冲突目标', ['c-2'])

    await expect(
      mergeIncidents(handle.db, {
        sourceIncidentIds: [sourceId],
        targetIncidentId: targetIncId,
        expectedRevision: 999, // wrong revision
      }),
    ).rejects.toThrow('事件版本冲突，请刷新后重试')
  })

  it('rejects cross-target incident merging with INCIDENT_TARGET_MISMATCH', async () => {
    const t = schemaFor(handle.db)
    const targetBId = newId()
    await handle.db.insert(t.targets).values({
      id: targetBId,
      code: `target-b-${newId().replace(/-/g, '').slice(0, 12)}`,
      name: '目标B',
      entryUrl: 'https://example.com/b',
      status: 'active',
      sessionPolicy: { maxLifetimeSeconds: 3600, idleTimeoutSeconds: 300, maxTotalSessions: 5, accountStrategy: 'exclusive' },
      resolutionPolicy: { timeoutMs: 5000, retryLimit: 2, fallbackPriority: ['map', 'ai'] },
    })

    const now = new Date()
    const incidentBId = newId()
    await handle.db.insert(t.reliabilityIncidents).values({
      id: incidentBId,
      targetId: targetBId,
      groupingKey: `gk-${incidentBId}`,
      scopeDigest: `target:${targetBId}`,
      severity: 'P3',
      status: 'DETECTED',
      memberCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      title: '目标B事件',
      summary: 'Summary of 目标B事件',
      evidenceScores: { supportingScore: 50, counterScore: 10, supportingFactors: ['回退'], counterFactors: [] },
      revision: 1,
    })

    const sourceId = await createTestIncident('源事件', ['m-1'])

    await expect(
      mergeIncidents(handle.db, {
        sourceIncidentIds: [sourceId],
        targetIncidentId: incidentBId,
      }),
    ).rejects.toMatchObject({
      code: RELIABILITY_ERROR_CODES.INCIDENT_TARGET_MISMATCH,
    })
  })

  it('authorizeTargetRequest validates targetId via incidentId and enforces target permission', async () => {
    const testIncidentId = await createTestIncident('受保护事件', ['s-1'])

    // With an unauthorized actorId
    const unauthorizedActorId = newId()
    await expect(
      authorizeTargetRequest(handle.db, unauthorizedActorId, {
        incidentId: testIncidentId,
        permissions: ['reliability:read'],
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('listIncidents filters out incidents from targets outside caller scope', async () => {
    // When actorId has no role grants, listIncidents returns 0 items
    const unauthorizedActorId = newId()
    const { items, total } = await listIncidents(handle.db, {}, unauthorizedActorId)
    expect(items).toHaveLength(0)
    expect(total).toBe(0)

    // Unscoped caller (e.g. system background job) gets items
    const unscoped = await listIncidents(handle.db, {})
    expect(unscoped.total).toBeGreaterThan(0)
  })

  it('rejects cross-target incident triage when actorId is supplied', async () => {
    const t = schemaFor(handle.db)
    const actorId = newId()
    const roleId = newId()
    const foreignTargetId = newId()
    const foreignIncidentId = newId()
    const localIncidentId = await createTestIncident('本地处置事件', ['local-ref'])
    const now = new Date()

    await handle.db.insert(t.consoleAccounts).values({
      id: actorId,
      username: `triager-${actorId.slice(0, 8)}`,
      displayName: '受限分诊员',
      passwordHash: 'hash',
      status: 'active',
    })
    await handle.db.insert(t.consoleRoles).values({ id: roleId, key: `triager-${roleId}`, name: '受限分诊' })
    await handle.db.insert(t.consoleRolePermissions).values([
      { consoleRoleId: roleId, permission: 'target:read' },
      { consoleRoleId: roleId, permission: 'reliability:triage' },
    ])
    await handle.db.insert(t.consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: roleId,
      targetScopeMode: 'selected',
      targetScopeIds: [targetId],
    })
    await handle.db.insert(t.targets).values({
      id: foreignTargetId,
      code: `foreign-${foreignTargetId.slice(0, 8)}`,
      name: '范围外目标',
      entryUrl: 'https://foreign.example.com',
    })
    await handle.db.insert(t.reliabilityIncidents).values({
      id: foreignIncidentId,
      targetId: foreignTargetId,
      groupingKey: `gk-${foreignIncidentId}`,
      scopeDigest: `target:${foreignTargetId}`,
      severity: 'P3',
      status: 'DETECTED',
      memberCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      title: '范围外事件',
      summary: '不可处置',
      evidenceScores: { supportingScore: 50, counterScore: 10, supportingFactors: [], counterFactors: [] },
      revision: 1,
    })

    const denied = [
      () => mergeIncidents(handle.db, { sourceIncidentIds: [foreignIncidentId], targetIncidentId: localIncidentId, actorId }),
      () => mergeIncidents(handle.db, { sourceIncidentIds: [localIncidentId], targetIncidentId: foreignIncidentId, actorId }),
      () => splitIncidents(handle.db, { incidentId: foreignIncidentId, memberRefs: [], actorId }),
      () => dismissIncident(handle.db, { incidentId: foreignIncidentId, reason: '不允许', actorId }),
      () => silenceIncident(handle.db, { incidentId: foreignIncidentId, durationHours: 1, actorId }),
      () => resolveIncident(handle.db, { incidentId: foreignIncidentId, reason: '不允许', actorId }),
      () => updateIncidentStatus(handle.db, { incidentId: foreignIncidentId, status: 'OBSERVING', actorId }),
    ]
    for (const operation of denied) {
      await expect(operation()).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    }
    expect((await getIncidentDetail(handle.db, foreignIncidentId)).incident.revision).toBe(1)
    expect((await dismissIncident(handle.db, { incidentId: localIncidentId, reason: '允许', actorId })).status).toBe('DISMISSED')
  })
})
