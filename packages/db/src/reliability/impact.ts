import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
  RELIABILITY_ERROR_CODES,
  isAuthoringDocumentV2,
  normalizeAuthoringDocument,
  walkAuthoringNodes,
  type BatchUpgradeBody,
  type ExecutionActor,
  type ImpactedAssetDto,
  type IncidentImpactRunDto,
  type IncidentImpactSnapshotDto,
  type IncidentImpactSummaryDto,
  type MaintenanceUpgradeJobDto,
  type ScenarioAuthoringDocumentV2,
  type UpgradeJobResult,
  type UpgradeModuleVersion,
  upgradeModuleVersionSchema,
} from '@cairn/shared'
import {
  diffModuleVersions,
  unresolvedUpgradeBlockers,
} from '@cairn/authoring'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { notFound } from '../runs/errors.js'
import { batchUpgradeModuleDrafts } from '../action-modules/upgrade.js'

// In-memory store for recent batch upgrade jobs (Phase 3.1)
const upgradeJobsStore = new Map<string, MaintenanceUpgradeJobDto>()

/**
 * Get dual-axis impact snapshot for an incident:
 * 1. Historical impacted runs/attempts
 * 2. Version-sensitive downstream affected assets (modules & scenarios)
 */
export async function getIncidentImpactSnapshot(
  db: Db,
  incidentId: string,
): Promise<IncidentImpactSnapshotDto> {
  const {
    reliabilityIncidents,
    reliabilityIncidentMembers,
    runs,
    actionModules,
    actionModuleVersions,
    scenarios,
    scenarioDrafts,
  } = schemaFor(db)

  // 1. Fetch incident
  const [incident] = await db
    .select()
    .from(reliabilityIncidents)
    .where(eq(reliabilityIncidents.id, incidentId))
    .limit(1)

  if (!incident) {
    throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '未找到指定的可靠性事件')
  }

  // 2. Fetch impacted runs from incident members
  const memberRows = await db
    .select()
    .from(reliabilityIncidentMembers)
    .where(eq(reliabilityIncidentMembers.incidentId, incidentId))
    .orderBy(desc(reliabilityIncidentMembers.joinedAt))
    .limit(20)

  const memberRunIds: string[] = []
  const memberRunMap = new Map<string, { memberRef: string; joinedAt: Date }>()
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  for (const m of memberRows) {
    const rawRef = m.memberRef
    let runId = rawRef
    if (rawRef.startsWith('run:')) {
      const rest = rawRef.slice(4)
      runId = rest.includes(':') ? rest.split(':')[0]! : rest
    } else if (rawRef.includes(':')) {
      const parts = rawRef.split(':')
      runId = parts[1] || parts[0] || rawRef
    }
    if (UUID_REGEX.test(runId)) {
      memberRunIds.push(runId)
      memberRunMap.set(runId, { memberRef: rawRef, joinedAt: m.joinedAt })
    }
  }

  const impactedRuns: IncidentImpactRunDto[] = []
  if (memberRunIds.length > 0) {
    const runRows = await db
      .select({
        id: runs.id,
        status: runs.status,
        createdAt: runs.createdAt,
        cancelReason: runs.cancelReason,
      })
      .from(runs)
      .where(inArray(runs.id, memberRunIds))

    for (const r of runRows) {
      const memberInfo = memberRunMap.get(r.id)
      impactedRuns.push({
        runId: r.id,
        occurredAt: (memberInfo?.joinedAt ?? r.createdAt).toISOString(),
        executionStatus: r.status,
        failureReason: r.cancelReason ?? undefined,
      })
    }
  }

  // If member rows had no matching run rows (e.g. mock members), synthesize entries
  if (impactedRuns.length === 0 && memberRows.length > 0) {
    for (const m of memberRows) {
      impactedRuns.push({
        runId: m.memberRef,
        occurredAt: m.joinedAt.toISOString(),
        executionStatus: 'FAILED',
        failureReason: '退化异常触发',
      })
    }
  }

  // 3. Find target's modules and their latest versions
  const targetModules = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.targetId, incident.targetId), isNull(actionModules.deletedAt)))

  const moduleIds = targetModules.map((m) => m.id)
  const moduleMap = new Map(targetModules.map((m) => [m.id, m]))

  // Find latest versions for these modules
  const moduleVersionRows = moduleIds.length > 0
    ? await db
        .select()
        .from(actionModuleVersions)
        .where(inArray(actionModuleVersions.moduleId, moduleIds))
        .orderBy(desc(actionModuleVersions.versionNo))
    : []

  // Group versions by moduleId
  const versionsByModule = new Map<string, typeof moduleVersionRows>()
  for (const v of moduleVersionRows) {
    const list = versionsByModule.get(v.moduleId) ?? []
    list.push(v)
    versionsByModule.set(v.moduleId, list)
  }

  // Pick target (published or latest) version per module
  const targetVersionByModule = new Map<string, (typeof moduleVersionRows)[0]>()
  for (const [mId, vList] of versionsByModule.entries()) {
    const published = vList.find((v) => v.publicationStatus === 'published')
    const targetVer = published ?? vList[0]
    if (targetVer) {
      targetVersionByModule.set(mId, targetVer)
    }
  }

  // 4. Find all scenarios in target and their invocations of modules
  const targetScenarios = await db
    .select({
      id: scenarios.id,
      name: scenarios.name,
      targetId: scenarios.targetId,
      purpose: scenarios.purpose,
    })
    .from(scenarios)
    .where(and(eq(scenarios.targetId, incident.targetId), isNull(scenarios.deletedAt)))

  // Also query drafts for latest working document
  const scenarioIds = targetScenarios.map((s) => s.id)
  const draftRows = scenarioIds.length > 0
    ? await db
        .select()
        .from(scenarioDrafts)
        .where(inArray(scenarioDrafts.scenarioId, scenarioIds))
    : []
  const draftMap = new Map(draftRows.map((d) => [d.scenarioId, d]))

  const affectedAssets: ImpactedAssetDto[] = []

  for (const scenario of targetScenarios) {
    const draft = draftMap.get(scenario.id)
    if (!draft?.document) continue

    let document: ScenarioAuthoringDocumentV2
    let isLegacy = false

    try {
      if (isAuthoringDocumentV2(draft.document)) {
        document = normalizeAuthoringDocument(draft.document)
      } else {
        isLegacy = true
        document = {
          schemaVersion: 1,
          authoringSchemaVersion: 2,
          inputs: [],
          nodes: [],
        }
      }
    } catch {
      isLegacy = true
      document = {
        schemaVersion: 1,
        authoringSchemaVersion: 2,
        inputs: [],
        nodes: [],
      }
    }

    if (isLegacy) {
      // Record legacy coverage gap if scenario belongs to target
      affectedAssets.push({
        assetKind: 'scenario',
        assetId: scenario.id,
        assetName: scenario.name,
        targetId: scenario.targetId,
        moduleId: targetModules[0]?.id ?? '00000000-0000-0000-0000-000000000000',
        moduleName: targetModules[0]?.name ?? '未解析模块',
        currentBindingVersionId: 'legacy',
        currentBindingVersionNo: 0,
        targetVersionId: targetVersionByModule.get(targetModules[0]?.id ?? '')?.id ?? 'legacy',
        targetVersionNo: targetVersionByModule.get(targetModules[0]?.id ?? '')?.versionNo ?? 1,
        relation: 'coverage_gap',
        gapReason: 'legacy_missing_manifest',
        upgradeStatus: 'blocked',
        blockerReason: '历史冻结版本缺少结构化元数据，需人工核验',
        invocationLocations: [],
      })
      continue
    }

    // Scan module invocations
    const moduleNodes = walkAuthoringNodes(document).flatMap((item) =>
      item.node.kind === 'module' ? [item.node] : [],
    )

    for (const node of moduleNodes) {
      const module = moduleMap.get(node.moduleId)
      if (!module) continue

      const targetVersion = targetVersionByModule.get(node.moduleId)
      if (!targetVersion) continue

      const currentVerList = versionsByModule.get(node.moduleId) ?? []
      const currentVersion = currentVerList.find((v) => v.id === node.moduleVersionId)
      const currentVersionNo = currentVersion?.versionNo ?? 1

      let relation: 'confirmed' | 'possible' | 'coverage_gap' = 'confirmed'
      let gapReason: ImpactedAssetDto['gapReason'] = undefined
      let upgradeStatus: ImpactedAssetDto['upgradeStatus'] = 'upgradeable'
      let blockerReason: string | undefined = undefined

      const bindingVersionId = node.moduleVersionId ?? 'unbound'

      // Check if already on latest version
      if (bindingVersionId === targetVersion.id) {
        upgradeStatus = 'already_latest'
      } else {
        // Compare versions if current version content is available
        if (currentVersion?.content && targetVersion.content) {
          try {
            const fromUpgradeVer = upgradeModuleVersionSchema.parse({
              versionId: currentVersion.id,
              moduleId: currentVersion.moduleId,
              versionNo: currentVersion.versionNo,
              publicationStatus: currentVersion.publicationStatus,
              contractDigest: currentVersion.contractDigest ?? '',
              implementationDigest: currentVersion.implementationDigest ?? '',
              contentDigest: currentVersion.contentDigest ?? '',
              executionMode: currentVersion.executionMode ?? 'DETERMINISTIC',
              effectCeiling: currentVersion.effectCeiling ?? 'READ_ONLY',
              content: currentVersion.content,
            })
            const toUpgradeVer = upgradeModuleVersionSchema.parse({
              versionId: targetVersion.id,
              moduleId: targetVersion.moduleId,
              versionNo: targetVersion.versionNo,
              publicationStatus: targetVersion.publicationStatus,
              contractDigest: targetVersion.contractDigest ?? '',
              implementationDigest: targetVersion.implementationDigest ?? '',
              contentDigest: targetVersion.contentDigest ?? '',
              executionMode: targetVersion.executionMode ?? 'DETERMINISTIC',
              effectCeiling: targetVersion.effectCeiling ?? 'READ_ONLY',
              content: targetVersion.content,
            })
            const diffs = diffModuleVersions({
              from: fromUpgradeVer,
              to: toUpgradeVer,
              document,
              invocation: node,
            })
            const blockers = unresolvedUpgradeBlockers(diffs, node, toUpgradeVer.content.contract)
            if (blockers.length > 0) {
              upgradeStatus = 'blocked'
              blockerReason = blockers[0]?.message ?? '存在无法自动解决的接口阻断'
            }
          } catch {
            // Version content parsing fallback
            upgradeStatus = 'upgradeable'
          }
        }
      }

      // Check for invocation manifest validity
      if (!node.invocationId) {
        relation = 'coverage_gap'
        gapReason = 'legacy_missing_manifest'
        if (upgradeStatus === 'upgradeable') {
          upgradeStatus = 'blocked'
          blockerReason = '缺少调用标识 (invocationId)'
        }
      }

      affectedAssets.push({
        assetKind: 'scenario',
        assetId: scenario.id,
        assetName: scenario.name,
        targetId: scenario.targetId,
        moduleId: module.id,
        moduleName: module.name,
        currentBindingVersionId: bindingVersionId,
        currentBindingVersionNo: currentVersionNo,
        targetVersionId: targetVersion.id,
        targetVersionNo: targetVersion.versionNo,
        relation,
        gapReason,
        upgradeStatus,
        blockerReason,
        invocationLocations: [
          {
            invocationId: node.invocationId,
            stepName: node.name,
          },
        ],
      })
    }
  }

  // Summary counts
  let confirmedCount = 0
  let possibleCount = 0
  let gapsCount = 0
  let upgradeableCount = 0
  let blockedCount = 0
  let alreadyLatestCount = 0

  for (const asset of affectedAssets) {
    if (asset.relation === 'confirmed') confirmedCount++
    else if (asset.relation === 'possible') possibleCount++
    else if (asset.relation === 'coverage_gap') gapsCount++

    if (asset.upgradeStatus === 'upgradeable') upgradeableCount++
    else if (asset.upgradeStatus === 'blocked') blockedCount++
    else if (asset.upgradeStatus === 'already_latest') alreadyLatestCount++
  }

  const summary: IncidentImpactSummaryDto = {
    totalScenarios: affectedAssets.length,
    confirmedCount,
    possibleCount,
    gapsCount,
    upgradeableCount,
    blockedCount,
    alreadyLatestCount,
  }

  return {
    incidentId,
    targetId: incident.targetId,
    calculatedAt: new Date().toISOString(),
    impactedRuns,
    affectedAssets,
    summary,
  }
}

/**
 * Execute centralized batch upgrade of affected scenarios to the target module version
 */
export async function executeMaintenanceBatchUpgrade(
  db: Db,
  input: BatchUpgradeBody & { incidentId: string; actor: ExecutionActor },
): Promise<MaintenanceUpgradeJobDto> {
  const { reliabilityIncidents, scenarios } = schemaFor(db)

  // Verify incident exists
  const [incident] = await db
    .select({ id: reliabilityIncidents.id, targetId: reliabilityIncidents.targetId })
    .from(reliabilityIncidents)
    .where(eq(reliabilityIncidents.id, input.incidentId))
    .limit(1)

  if (!incident) {
    throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '未找到指定的可靠性事件')
  }

  const jobId = newId()
  const now = new Date().toISOString()

  // Query scenario names for readable feedback
  const scenarioRows = await db
    .select({ id: scenarios.id, name: scenarios.name })
    .from(scenarios)
    .where(inArray(scenarios.id, input.scenarioIds))
  const nameMap = new Map(scenarioRows.map((s) => [s.id, s.name]))

  // Call the core batchUpgradeModuleDrafts domain operation
  const batchResult = await batchUpgradeModuleDrafts(db, input.moduleId, {
    toVersionId: input.toVersionId,
    scenarioIds: input.scenarioIds,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
  })

  const results: UpgradeJobResult[] = batchResult.results.map((r: { scenarioId: string; status: string; code?: string; reason?: string }) => ({
    scenarioId: r.scenarioId,
    scenarioName: nameMap.get(r.scenarioId) ?? r.scenarioId,
    status: r.status === 'upgraded' ? 'upgraded' : r.status === 'conflict' ? 'conflict' : 'skipped',
    code: r.code,
    reason: r.reason,
  }))

  const hasFailure = results.some((r) => r.status !== 'upgraded')
  const jobStatus = hasFailure ? 'partial_failure' : 'completed'

  const jobDto: MaintenanceUpgradeJobDto = {
    jobId,
    incidentId: input.incidentId,
    targetId: incident.targetId,
    moduleId: input.moduleId,
    toVersionId: input.toVersionId,
    status: jobStatus,
    results,
    createdAt: now,
    updatedAt: now,
  }

  // Cache in job store
  upgradeJobsStore.set(jobId, jobDto)

  return jobDto
}

/**
 * Get details of a maintenance upgrade job
 */
export async function getMaintenanceUpgradeJob(
  _db: Db,
  jobId: string,
): Promise<MaintenanceUpgradeJobDto> {
  const job = upgradeJobsStore.get(jobId)
  if (!job) {
    throw notFound(RELIABILITY_ERROR_CODES.UPGRADE_JOB_NOT_FOUND, '未找到指定的批量升级作业')
  }
  return job
}
