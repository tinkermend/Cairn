import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { grantScopedPermissions } from '../testing.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { getIncidentImpactSnapshot, executeMaintenanceBatchUpgrade, getMaintenanceUpgradeJob } from '../reliability/impact.js'
import { RELIABILITY_ERROR_CODES, type ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { moduleContentDigest } from '@cairn/authoring'

describe.each(DRIVERS)('%s reliability impact and batch upgrade domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string
  let consoleAccountId: string
  let scenario1Id: string
  let scenario2Id: string
  let scenarioLegacyId: string
  let moduleId: string
  let version1Id: string
  let version2Id: string
  let incidentId: string

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
    await grantScopedPermissions(handle.db, consoleAccountId, ['target:read', 'reliability:read', 'reliability:triage'])

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '影响分析与集中升级测试目标',
      entryUrl: 'https://example.com',
      status: 'active',
      sessionPolicy: { maxLifetimeSeconds: 3600, idleTimeoutSeconds: 300, maxTotalSessions: 5, accountStrategy: 'exclusive' },
      resolutionPolicy: { preference: 'prefer_deterministic', ceiling: 'prefer_ai' },
    })

    // Create action module
    moduleId = newId()
    await handle.db.insert(t.actionModules).values({
      id: moduleId,
      targetId,
      key: 'user.login',
      name: '用户登录模块',
      createdByConsoleAccountId: consoleAccountId,
      updatedByConsoleAccountId: consoleAccountId,
    })

    // Create Module Version 1
    version1Id = newId()
    const content1 = {
      contract: {
        inputs: [{ key: 'username', label: '用户名', valueType: 'string' as const, required: false }],
        outputs: [{ key: 'token', label: '令牌', shape: { kind: 'scalar' as const, type: 'string' as const } }],
        effectCeiling: 'READ_ONLY' as const,
        preconditions: [],
        postconditions: [],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps' as const,
          steps: [
            {
              id: newId(),
              name: '回显步骤',
              type: 'echo',
              effectType: 'READ_ONLY' as const,
              outputKey: 'token',
              input: { from: 'username' },
            },
          ],
          outputMapping: { token: 'token' },
        },
      ],
    }
    await handle.db.insert(t.actionModuleVersions).values({
      id: version1Id,
      moduleId,
      versionNo: 1,
      publicationStatus: 'published',
      contractDigest: 'c-v1',
      implementationDigest: 'i-v1',
      contentDigest: moduleContentDigest(content1),
      executionMode: 'DETERMINISTIC',
      effectCeiling: 'READ_ONLY',
      content: content1,
      createdByConsoleAccountId: consoleAccountId,
    })

    // Create Module Version 2 (Published latest)
    version2Id = newId()
    const content2 = {
      contract: {
        inputs: [{ key: 'username', label: '用户名', valueType: 'string' as const, required: false }],
        outputs: [{ key: 'token', label: '令牌', shape: { kind: 'scalar' as const, type: 'string' as const } }],
        effectCeiling: 'READ_ONLY' as const,
        preconditions: [],
        postconditions: [],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps' as const,
          steps: [
            {
              id: newId(),
              name: '回显步骤v2',
              type: 'echo',
              effectType: 'READ_ONLY' as const,
              outputKey: 'token',
              input: { from: 'username' },
            },
          ],
          outputMapping: { token: 'token' },
        },
      ],
    }
    await handle.db.insert(t.actionModuleVersions).values({
      id: version2Id,
      moduleId,
      versionNo: 2,
      publicationStatus: 'published',
      contractDigest: 'c-v2',
      implementationDigest: 'i-v2',
      contentDigest: moduleContentDigest(content2),
      executionMode: 'DETERMINISTIC',
      effectCeiling: 'READ_ONLY',
      content: content2,
      createdByConsoleAccountId: consoleAccountId,
    })

    // Create Scenario 1 using Version 1
    scenario1Id = newId()
    const doc1: ScenarioAuthoringDocumentV2 = {
      schemaVersion: 1,
      authoringSchemaVersion: 2,
      inputs: [{ key: 'username', label: '用户名' }],
      nodes: [
        {
          kind: 'module',
          invocationId: newId(),
          name: '登录验证步骤',
          moduleId,
          moduleVersionId: version1Id,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        },
      ],
    }
    await handle.db.insert(t.scenarios).values({
      id: scenario1Id,
      targetId,
      name: '场景A-订单结账',
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioVersions).values({
      id: newId(),
      scenarioId: scenario1Id,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'digest-1',
      definition: {
        schemaVersion: 1,
        inputs: [],
        steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      },
      authoringDocument: doc1,
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioDrafts).values({
      scenarioId: scenario1Id,
      revision: 1,
      document: doc1,
      updatedByConsoleAccountId: consoleAccountId,
    })

    // Create Scenario 2 already on Version 2
    scenario2Id = newId()
    const doc2: ScenarioAuthoringDocumentV2 = {
      schemaVersion: 1,
      authoringSchemaVersion: 2,
      inputs: [{ key: 'username', label: '用户名' }],
      nodes: [
        {
          kind: 'module',
          invocationId: newId(),
          name: '登录验证步骤',
          moduleId,
          moduleVersionId: version2Id,
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        },
      ],
    }
    await handle.db.insert(t.scenarios).values({
      id: scenario2Id,
      targetId,
      name: '场景B-用户个人中心',
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioVersions).values({
      id: newId(),
      scenarioId: scenario2Id,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'digest-2',
      definition: {
        schemaVersion: 1,
        inputs: [],
        steps: [{ id: newId(), name: '占位', type: 'delay', effectType: 'READ_ONLY', input: { durationMs: 10 } }],
      },
      authoringDocument: doc2,
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioDrafts).values({
      scenarioId: scenario2Id,
      revision: 1,
      document: doc2,
      updatedByConsoleAccountId: consoleAccountId,
    })

    // Create Legacy Scenario with invalid document
    scenarioLegacyId = newId()
    await handle.db.insert(t.scenarios).values({
      id: scenarioLegacyId,
      targetId,
      name: '场景C-历史老版本流程',
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarioDrafts).values({
      scenarioId: scenarioLegacyId,
      revision: 1,
      document: { invalid: 'legacy_structure' } as any,
      updatedByConsoleAccountId: consoleAccountId,
    })

    // Create an Incident
    incidentId = newId()
    await handle.db.insert(t.reliabilityIncidents).values({
      id: incidentId,
      targetId,
      groupingKey: `gk-${incidentId.slice(0, 8)}`,
      scopeDigest: 'scope-impact-test',
      severity: 'P2',
      status: 'DETECTED',
      memberCount: 2,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      title: '登录模块定位漂移告警',
      summary: '检测到登录按钮定位策略降级',
      evidenceScores: { supportScore: 40, counterScore: 10, totalScore: 30 },
      revision: 1,
    })

    // Insert incident members (runs)
    await handle.db.insert(t.reliabilityIncidentMembers).values([
      {
        id: newId(),
        incidentId,
        memberRef: `run:${newId()}`,
        memberType: 'run',
        joinedAt: new Date(),
      },
      {
        id: newId(),
        incidentId,
        memberRef: `run:${newId()}`,
        memberType: 'run',
        joinedAt: new Date(),
      },
    ])
  })

  afterAll(async () => {
    await handle.close()
  })

  it('RIC01: retrieves impact snapshot with confirmed affected scenarios and upgrade status', async () => {
    const snapshot = await getIncidentImpactSnapshot(handle.db, incidentId)

    expect(snapshot.incidentId).toBe(incidentId)
    expect(snapshot.targetId).toBe(targetId)
    expect(snapshot.impactedRuns.length).toBe(2)

    // Check affectedAssets
    const asset1 = snapshot.affectedAssets.find((a) => a.assetId === scenario1Id)
    expect(asset1).toBeDefined()
    expect(asset1?.currentBindingVersionId).toBe(version1Id)
    expect(asset1?.targetVersionId).toBe(version2Id)
    expect(asset1?.relation).toBe('confirmed')
    expect(asset1?.upgradeStatus).toBe('upgradeable')

    const asset2 = snapshot.affectedAssets.find((a) => a.assetId === scenario2Id)
    expect(asset2).toBeDefined()
    expect(asset2?.currentBindingVersionId).toBe(version2Id)
    expect(asset2?.targetVersionId).toBe(version2Id)
    expect(asset2?.relation).toBe('confirmed')
    expect(asset2?.upgradeStatus).toBe('already_latest')

    // Summary counts
    expect(snapshot.summary.totalScenarios).toBe(3)
    expect(snapshot.summary.upgradeableCount).toBe(1)
    expect(snapshot.summary.alreadyLatestCount).toBe(1)
    expect(snapshot.summary.gapsCount).toBe(1)
  })

  it('does not synthesize duplicate foreign-target run references into impact results', async () => {
    const t = schemaFor(handle.db)
    const foreignTargetId = newId()
    const foreignScenarioId = newId()
    const foreignVersionId = newId()
    const foreignRunId = newId()
    const scopedIncidentId = newId()
    await handle.db.insert(t.targets).values({ id: foreignTargetId, code: `foreign-run-${foreignTargetId.slice(0, 8)}`, name: '范围外运行目标', entryUrl: 'https://foreign.example.com' })
    await handle.db.insert(t.scenarios).values({ id: foreignScenarioId, targetId: foreignTargetId, name: '范围外运行场景', createdByConsoleAccountId: consoleAccountId })
    await handle.db.insert(t.scenarioVersions).values({
      id: foreignVersionId,
      scenarioId: foreignScenarioId,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'foreign-run-test',
      definition: { schemaVersion: 1, inputs: [], steps: [] },
      createdByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.runs).values({
      id: foreignRunId,
      targetId: foreignTargetId,
      scenarioId: foreignScenarioId,
      scenarioVersionId: foreignVersionId,
      createdByConsoleAccountId: consoleAccountId,
      status: 'FAILED',
      snapshot: {} as any,
      snapshotDigest: 'foreign-run-test',
      context: {},
    })
    await handle.db.insert(t.reliabilityIncidents).values({
      id: scopedIncidentId,
      targetId,
      groupingKey: `foreign-run-${scopedIncidentId}`,
      scopeDigest: 'foreign-run-test',
      severity: 'P2',
      status: 'DETECTED',
      memberCount: 3,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      title: '外目标成员引用',
      summary: '成员引用不应暴露外目标运行',
      evidenceScores: { supportScore: 40, counterScore: 10, totalScore: 30 },
      revision: 1,
    })
    await handle.db.insert(t.reliabilityIncidentMembers).values(['attempt-1', 'attempt-2', 'attempt-3'].map((suffix) => ({
      id: newId(),
      incidentId: scopedIncidentId,
      memberRef: `run:${suffix === 'attempt-3' ? foreignRunId.toUpperCase() : foreignRunId}:${suffix}`,
      memberType: 'run',
      joinedAt: new Date(),
    })))
    const impact = await getIncidentImpactSnapshot(handle.db, scopedIncidentId, consoleAccountId)
    expect(impact.impactedRuns).toEqual([])
  })

  it('RIC02: handles legacy scenario missing manifest by categorizing into coverage_gap', async () => {
    const snapshot = await getIncidentImpactSnapshot(handle.db, incidentId)

    const legacyAsset = snapshot.affectedAssets.find((a) => a.assetId === scenarioLegacyId)
    expect(legacyAsset).toBeDefined()
    expect(legacyAsset?.relation).toBe('coverage_gap')
    expect(legacyAsset?.gapReason).toBe('legacy_missing_manifest')
    expect(legacyAsset?.upgradeStatus).toBe('blocked')
    expect(legacyAsset?.blockerReason).toContain('缺少结构化元数据')
  })

  it('RIC04: executes batch upgrade for upgradeable scenarios and records itemized receipts', async () => {
    const actor = {
      id: consoleAccountId,
      type: 'console' as const,
      displayName: '管理员',
    }

    const job = await executeMaintenanceBatchUpgrade(handle.db, {
      incidentId,
      moduleId,
      toVersionId: version2Id,
      scenarioIds: [scenario1Id],
      idempotencyKey: `idem-${newId()}`,
      actor,
      actorId: consoleAccountId,
    })

    expect(job.incidentId).toBe(incidentId)
    expect(job.status).toBe('completed')
    expect(job.results.length).toBe(1)
    expect(job.results[0].scenarioId).toBe(scenario1Id)
    expect(job.results[0].status).toBe('upgraded')

    // Verify retrieval by jobId
    const fetchedJob = await getMaintenanceUpgradeJob(handle.db, job.jobId, consoleAccountId)
    expect(fetchedJob.jobId).toBe(job.jobId)
    expect(fetchedJob.status).toBe('completed')
    await expect(getMaintenanceUpgradeJob(handle.db, job.jobId, newId())).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })

    // Now scenario1 should be upgraded to version2
    const snapshotAfter = await getIncidentImpactSnapshot(handle.db, incidentId)
    const asset1After = snapshotAfter.affectedAssets.find((a) => a.assetId === scenario1Id)
    expect(asset1After?.upgradeStatus).toBe('already_latest')
  })

  it('throws not found error for non-existent incident or job', async () => {
    await expect(getIncidentImpactSnapshot(handle.db, newId())).rejects.toThrow(
      '未找到指定的可靠性事件',
    )
    await expect(getMaintenanceUpgradeJob(handle.db, newId())).rejects.toThrow(
      '未找到指定的批量升级作业',
    )
  })

  it('rejects batch upgrades that mix incident, module, and scenario targets', async () => {
    const t = schemaFor(handle.db)
    const foreignTargetId = newId()
    const foreignModuleId = newId()
    const foreignScenarioId = newId()
    await handle.db.insert(t.targets).values({
      id: foreignTargetId,
      code: `foreign-${foreignTargetId.slice(0, 8)}`,
      name: '范围外目标',
      entryUrl: 'https://foreign.example.com',
    })
    await handle.db.insert(t.actionModules).values({
      id: foreignModuleId,
      targetId: foreignTargetId,
      key: `foreign-${foreignModuleId.slice(0, 8)}`,
      name: '范围外模块',
      createdByConsoleAccountId: consoleAccountId,
      updatedByConsoleAccountId: consoleAccountId,
    })
    await handle.db.insert(t.scenarios).values({
      id: foreignScenarioId,
      targetId: foreignTargetId,
      name: '范围外场景',
      createdByConsoleAccountId: consoleAccountId,
    })

    const actor = { id: consoleAccountId, kind: 'console' as const }
    await expect(executeMaintenanceBatchUpgrade(handle.db, {
      incidentId,
      moduleId: foreignModuleId,
      toVersionId: version2Id,
      scenarioIds: [scenario1Id],
      idempotencyKey: `foreign-module-${newId()}`,
      actor,
      actorId: consoleAccountId,
    })).rejects.toMatchObject({ code: RELIABILITY_ERROR_CODES.INCIDENT_TARGET_MISMATCH })
    await expect(executeMaintenanceBatchUpgrade(handle.db, {
      incidentId,
      moduleId,
      toVersionId: version2Id,
      scenarioIds: [foreignScenarioId],
      idempotencyKey: `foreign-scenario-${newId()}`,
      actor,
      actorId: consoleAccountId,
    })).rejects.toMatchObject({ code: RELIABILITY_ERROR_CODES.INCIDENT_TARGET_MISMATCH })
    await expect(executeMaintenanceBatchUpgrade(handle.db, {
      incidentId,
      moduleId,
      toVersionId: version2Id,
      scenarioIds: [scenario1Id],
      idempotencyKey: `unauthorized-${newId()}`,
      actor,
      actorId: newId(),
    })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })
})
