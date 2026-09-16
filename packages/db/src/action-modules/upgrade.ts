import {
  ACTIVE_RUN_STATUSES,
  applyModuleReplace,
  applyModuleUpgrade,
  buildExtractedModuleContent,
  buildReplaceInvocation,
  compareReplaceSteps,
  diffModuleVersions,
  disableAffectedScenariosBodySchema,
  disableAffectedScenariosResponseSchema,
  isSelectablePublication,
  latestSelectableVersion,
  moduleBatchUpgradeBodySchema,
  moduleBatchUpgradeResponseSchema,
  moduleDeletePreviewResponseSchema,
  moduleExtractBodySchema,
  modulePublicationBodySchema,
  moduleReferenceItemSchema,
  moduleReferenceListQuerySchema,
  moduleReferenceListResponseSchema,
  moduleReplaceBodySchema,
  moduleReplacePreviewResponseSchema,
  moduleUpgradeBodySchema,
  moduleUpgradePreviewBodySchema,
  moduleUpgradePreviewResponseSchema,
  normalizeAuthoringDocument,
  proposeModuleFromSteps,
  sourceDescription,
  unconfirmedUpgradeWarnings,
  unresolvedUpgradeBlockers,
  upgradeModuleVersionSchema,
  type ActionModuleDetail,
  type ActionModuleVersionDto,
  type DeleteResourceResult,
  type ExecutionActor,
  type ModuleBatchUpgradeResponse,
  type ModuleDeletePreviewResponse,
  type ModulePublicationBody,
  type ModuleReferenceItem,
  type ModuleReferenceListQuery,
  type ModuleReferenceListResponse,
  type ModuleReferenceUse,
  type ModuleInputBinding,
  type ModuleReplacePreviewResponse,
  type ModuleUpgradePreviewResponse,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
  type UpgradeModuleVersion,
} from '@cairn/shared'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { snapshotDeletedBy, toDeleteResult } from '../lifecycle.js'
import { newId } from '../id.js'
import { atomic, locked, schemaFor } from '../native.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import {
  deleteScenario,
  expandWithLoader,
  getScenario,
  saveScenarioDraft,
  updateScenarioMeta,
} from '../runs/scenarios.js'
import { sha256Hex } from './digest.js'
import {
  createActionModule,
  getActionModule,
  getActionModuleVersion,
  listActionModuleVersions,
  saveActionModuleDraft,
} from './modules.js'
import type { ActionModuleCommand } from '../schema/action-modules.js'

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toUpgradeVersion(version: ActionModuleVersionDto): UpgradeModuleVersion {
  return upgradeModuleVersionSchema.parse({
    versionId: version.id,
    moduleId: version.moduleId,
    versionNo: version.versionNo,
    publicationStatus: version.publicationStatus,
    contractDigest: version.contractDigest,
    implementationDigest: version.implementationDigest,
    contentDigest: version.contentDigest,
    executionMode: version.executionMode,
    effectCeiling: version.effectCeiling,
    content: version.content,
  })
}

async function requireModule(db: Db, moduleId: string): Promise<ActionModuleDetail> {
  return getActionModule(db, moduleId)
}

async function loadDraftDocument(db: Db, scenarioId: string): Promise<{
  scenario: ScenarioDetailDto
  document: ScenarioAuthoringDocumentV2
  revision: number
}> {
  const scenario = await getScenario(db, scenarioId)
  if (!scenario.draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  return {
    scenario,
    document: normalizeAuthoringDocument(scenario.draft.document),
    revision: scenario.draft.revision,
  }
}

async function findCommandReceipt<T>(
  db: Db,
  actorId: string,
  key: string,
  digest: string,
): Promise<T | undefined> {
  const { actionModuleCommandReceipts } = schemaFor(db)
  const [existing] = await db
    .select()
    .from(actionModuleCommandReceipts)
    .where(
      and(
        eq(actionModuleCommandReceipts.actorId, actorId),
        eq(actionModuleCommandReceipts.idempotencyKey, key),
      ),
    )
  if (!existing) return undefined
  if (existing.requestDigest !== digest) throw conflict('MODULE_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
  return existing.response as T
}

async function insertCommandReceipt<T>(
  db: Db,
  input: {
    actor: ExecutionActor
    key: string
    command: ActionModuleCommand
    request: unknown
    moduleId?: string | null
    scenarioId?: string | null
  },
  digest: string,
  response: T,
): Promise<void> {
  const { actionModuleCommandReceipts } = schemaFor(db)
  await db.insert(actionModuleCommandReceipts).values({
    id: newId(),
    actorId: input.actor.id,
    idempotencyKey: input.key,
    command: input.command,
    requestDigest: digest,
    moduleId: input.moduleId ?? null,
    scenarioId: input.scenarioId ?? null,
    response: response as never,
    createdAt: new Date(),
  })
}

async function withCommandReceipt<T>(
  db: Db,
  input: {
    actor: ExecutionActor
    key: string
    command: ActionModuleCommand
    request: unknown
    moduleId?: string | null
    scenarioId?: string | null
  },
  apply: (tx: Db) => Promise<T>,
): Promise<T> {
  const { consoleAccounts } = schemaFor(db)
  return atomic(db, async (tx) => {
    await locked(tx, tx.select({ id: consoleAccounts.id }).from(consoleAccounts).where(eq(consoleAccounts.id, input.actor.id)))
    const digest = sha256Hex(input.request)
    const existing = await findCommandReceipt<T>(tx as unknown as Db, input.actor.id, input.key, digest)
    if (existing !== undefined) return existing
    const response = await apply(tx as unknown as Db)
    await insertCommandReceipt(tx as unknown as Db, input, digest, response)
    return response
  })
}

/** 批量升级：回执检查与写入单独提交，每个场景自己的事务，避免 SQLite 嵌套锁死。 */
async function withDeferredCommandReceipt<T>(
  db: Db,
  input: {
    actor: ExecutionActor
    key: string
    command: ActionModuleCommand
    request: unknown
    moduleId?: string | null
    scenarioId?: string | null
  },
  apply: () => Promise<T>,
): Promise<T> {
  const digest = sha256Hex(input.request)
  const existing = await atomic(db, async (tx) => {
    const { consoleAccounts } = schemaFor(tx)
    await locked(tx, tx.select({ id: consoleAccounts.id }).from(consoleAccounts).where(eq(consoleAccounts.id, input.actor.id)))
    return findCommandReceipt<T>(tx as unknown as Db, input.actor.id, input.key, digest)
  })
  if (existing !== undefined) return existing
  const response = await apply()
  await atomic(db, async (tx) => {
    const replay = await findCommandReceipt<T>(tx as unknown as Db, input.actor.id, input.key, digest)
    if (replay !== undefined) return
    await insertCommandReceipt(tx as unknown as Db, input, digest, response)
  })
  return response
}

async function lastRunsByScenario(db: Db, scenarioIds: string[]) {
  if (scenarioIds.length === 0) return new Map<string, ModuleReferenceItem['lastRun']>()
  const { runs } = schemaFor(db)
  const rows = await db
    .select({
      id: runs.id,
      scenarioId: runs.scenarioId,
      status: runs.status,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(and(inArray(runs.scenarioId, scenarioIds), isNull(runs.deletedAt)))
    .orderBy(desc(runs.createdAt))
  const map = new Map<string, ModuleReferenceItem['lastRun']>()
  for (const row of rows) {
    if (map.has(row.scenarioId)) continue
    map.set(row.scenarioId, {
      id: row.id,
      status: row.status,
      createdAt: iso(row.createdAt)!,
    })
  }
  return map
}

export async function listModuleReferences(
  db: Db,
  moduleId: string,
  query: Partial<ModuleReferenceListQuery> = {},
): Promise<ModuleReferenceListResponse> {
  await requireModule(db, moduleId)
  const parsed = moduleReferenceListQuerySchema.parse(query)
  const { scenarioModuleRefs, scenarios, scenarioVersions, targets } = schemaFor(db)
  const versions = await listActionModuleVersions(db, moduleId)
  const latest = latestSelectableVersion(versions.items)

  const conditions = [
    eq(scenarioModuleRefs.moduleId, moduleId),
    isNull(scenarios.deletedAt),
    isNull(targets.deletedAt),
  ]
  if (parsed.versionId) conditions.push(eq(scenarioModuleRefs.moduleVersionId, parsed.versionId))

  const distinct = await db
    .selectDistinct({
      scenarioId: scenarios.id,
      name: scenarios.name,
      status: scenarios.status,
      purpose: scenarios.purpose,
      createdAt: scenarios.createdAt,
      updatedAt: scenarios.updatedAt,
    })
    .from(scenarioModuleRefs)
    .innerJoin(scenarios, eq(scenarios.id, scenarioModuleRefs.scenarioId))
    .innerJoin(targets, eq(targets.id, scenarios.targetId))
    .where(and(...conditions))
    .orderBy(desc(scenarios.updatedAt), desc(scenarios.id))

  const total = distinct.length
  const pageRows = distinct.slice((parsed.page - 1) * parsed.pageSize, parsed.page * parsed.pageSize)
  const scenarioIds = pageRows.map((row) => row.scenarioId)
  const refs = scenarioIds.length
    ? await db
        .select()
        .from(scenarioModuleRefs)
        .where(and(eq(scenarioModuleRefs.moduleId, moduleId), inArray(scenarioModuleRefs.scenarioId, scenarioIds)))
    : []
  const publishedVersions = scenarioIds.length
    ? await db
        .select()
        .from(scenarioVersions)
        .where(and(inArray(scenarioVersions.scenarioId, scenarioIds), eq(scenarioVersions.kind, 'published')))
    : []
  const latestPublished = new Map<string, string>()
  for (const version of publishedVersions) {
    if (version.versionNo == null) continue
    const current = latestPublished.get(version.scenarioId)
    if (!current) {
      latestPublished.set(version.scenarioId, version.id)
      continue
    }
    const currentRow = publishedVersions.find((item) => item.id === current)
    if ((currentRow?.versionNo ?? 0) < version.versionNo) latestPublished.set(version.scenarioId, version.id)
  }
  const versionNoById = new Map(versions.items.map((item) => [item.id, item.versionNo]))
  const lastRuns = await lastRunsByScenario(db, scenarioIds)

  const items = pageRows.map((row) => {
    const scenarioRefs = refs.filter((item) => item.scenarioId === row.scenarioId)
    const draftUses: ModuleReferenceUse[] = scenarioRefs
      .filter((item) => item.scenarioVersionId == null)
      .map((item) => ({
        invocationId: item.invocationId,
        moduleVersionId: item.moduleVersionId ?? undefined,
        versionNo: item.moduleVersionId ? versionNoById.get(item.moduleVersionId) : undefined,
      }))
    const publishedId = latestPublished.get(row.scenarioId)
    const publishedUses: ModuleReferenceUse[] = scenarioRefs
      .filter((item) => item.scenarioVersionId && item.scenarioVersionId === publishedId)
      .map((item) => ({
        invocationId: item.invocationId,
        moduleVersionId: item.moduleVersionId ?? undefined,
        versionNo: item.moduleVersionId ? versionNoById.get(item.moduleVersionId) : undefined,
      }))
    const usedVersionIds = [...draftUses, ...publishedUses].map((item) => item.moduleVersionId).filter(Boolean)
    return moduleReferenceItemSchema.parse({
      scenarioId: row.scenarioId,
      name: row.name,
      status: row.status,
      purpose: row.purpose ?? 'user',
      draftUses,
      publishedUses,
      lastRun: lastRuns.get(row.scenarioId) ?? null,
      upgradeAvailable: Boolean(latest && usedVersionIds.some((id) => id !== latest.id)),
    })
  })

  return moduleReferenceListResponseSchema.parse({
    items,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  })
}

async function previewUpgradeOnDocument(
  db: Db,
  scenario: ScenarioDetailDto,
  document: ScenarioAuthoringDocumentV2,
  invocationId: string,
  toVersion: UpgradeModuleVersion,
  bindingsPatch: Record<string, ModuleInputBinding> = {},
): Promise<ModuleUpgradePreviewResponse> {
  const invocation = document.nodes.find((node) => node.kind === 'module' && node.invocationId === invocationId)
  if (!invocation || invocation.kind !== 'module') throw notFound('MODULE_VERSION_NOT_FOUND', '场景草稿中没有该模块调用')
  if (invocation.moduleId !== toVersion.moduleId) throw badRequest('MODULE_TARGET_MISMATCH', '升级目标不属于该调用的模块')
  const from = invocation.moduleVersionId
    ? toUpgradeVersion(await getActionModuleVersion(db, invocation.moduleId, invocation.moduleVersionId))
    : toVersion
  const nextDocument = applyModuleUpgrade({
    document,
    invocationId,
    toVersionId: toVersion.versionId,
    toContract: toVersion.content.contract,
    bindingsPatch,
  })
  const diffs = diffModuleVersions({ from, to: toVersion, document, invocation })
  const expansion = await expandWithLoader(db, scenario.targetId, nextDocument, 'preview', true)
  return moduleUpgradePreviewResponseSchema.parse({
    invocationId,
    fromVersionId: invocation.moduleVersionId,
    toVersionId: toVersion.versionId,
    severity: diffs.some((item) => item.severity === 'blocking') || expansion.diagnostics.some((item) => item.severity === 'error')
      ? 'blocking'
      : diffs.some((item) => item.severity === 'warning')
        ? 'warning'
        : 'info',
    diffs,
    document: nextDocument,
    diagnostics: expansion.diagnostics,
  })
}

export async function previewScenarioModuleUpgrade(
  db: Db,
  scenarioId: string,
  body: { invocationId: string; toVersionId: string },
): Promise<ModuleUpgradePreviewResponse> {
  const parsed = moduleUpgradePreviewBodySchema.parse(body)
  const { scenario, document } = await loadDraftDocument(db, scenarioId)
  const invocation = document.nodes.find((node) => node.kind === 'module' && node.invocationId === parsed.invocationId)
  if (!invocation || invocation.kind !== 'module') throw notFound('MODULE_VERSION_NOT_FOUND', '场景草稿中没有该模块调用')
  const to = toUpgradeVersion(await getActionModuleVersion(db, invocation.moduleId, parsed.toVersionId))
  return previewUpgradeOnDocument(db, scenario, document, parsed.invocationId, to)
}

export async function upgradeScenarioModuleDraft(
  db: Db,
  scenarioId: string,
  input: {
    invocationId: string
    toVersionId: string
    baseRevision: number
    bindingsPatch?: Record<string, ModuleInputBinding>
    confirmedWarnings?: string[]
    idempotencyKey: string
    actor: ExecutionActor
  },
): Promise<ScenarioDetailDto> {
  const parsed = moduleUpgradeBodySchema.parse({
    invocationId: input.invocationId,
    toVersionId: input.toVersionId,
    baseRevision: input.baseRevision,
    bindingsPatch: input.bindingsPatch ?? {},
    confirmedWarnings: input.confirmedWarnings ?? [],
    idempotencyKey: input.idempotencyKey,
  })
  return withCommandReceipt(
    db,
    {
      actor: input.actor,
      key: parsed.idempotencyKey,
      command: 'upgrade',
      request: { scenarioId, ...parsed },
      scenarioId,
    },
    async (tx) => {
      const { scenario, document, revision } = await loadDraftDocument(tx, scenarioId)
      if (revision !== parsed.baseRevision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', { revision })
      }
      const invocation = document.nodes.find((node) => node.kind === 'module' && node.invocationId === parsed.invocationId)
      if (!invocation || invocation.kind !== 'module') throw notFound('MODULE_VERSION_NOT_FOUND', '场景草稿中没有该模块调用')
      const to = toUpgradeVersion(await getActionModuleVersion(tx, invocation.moduleId, parsed.toVersionId))
      if (invocation.moduleVersionId === to.versionId && Object.keys(parsed.bindingsPatch).length === 0) {
        return scenario
      }
      const preview = await previewUpgradeOnDocument(tx, scenario, document, parsed.invocationId, to, parsed.bindingsPatch)
      const blockers = unresolvedUpgradeBlockers(preview.diffs, invocation, to.content.contract, parsed.bindingsPatch)
      const expandErrors = preview.diagnostics.filter((item) => item.severity === 'error')
      if (blockers.length || expandErrors.length) {
        throw conflict('MODULE_UPGRADE_BLOCKED', blockers[0]?.message ?? expandErrors[0]?.message ?? '升级存在阻断项', {
          diffs: preview.diffs,
          diagnostics: preview.diagnostics,
        })
      }
      const warnings = unconfirmedUpgradeWarnings(preview.diffs, parsed.confirmedWarnings)
      if (warnings.length) {
        throw conflict('MODULE_UPGRADE_CONFIRMATION_REQUIRED', warnings[0]!.message, { diffs: preview.diffs })
      }
      const saved = await saveScenarioDraft(tx, scenarioId, {
        revision: parsed.baseRevision,
        document: preview.document,
        actor: input.actor,
      })
      await recordAudit(tx, input.actor, 'module.upgrade', 'scenario', scenarioId, `升级调用 ${parsed.invocationId} 到模块版本 ${to.versionNo}`)
      return saved
    },
  )
}

export async function batchUpgradeModuleDrafts(
  db: Db,
  moduleId: string,
  input: { toVersionId: string; scenarioIds: string[]; idempotencyKey: string; actor: ExecutionActor },
): Promise<ModuleBatchUpgradeResponse> {
  await requireModule(db, moduleId)
  const parsed = moduleBatchUpgradeBodySchema.parse({
    toVersionId: input.toVersionId,
    scenarioIds: input.scenarioIds,
    idempotencyKey: input.idempotencyKey,
  })
  const to = toUpgradeVersion(await getActionModuleVersion(db, moduleId, parsed.toVersionId))
  if (!isSelectablePublication(to.publicationStatus)) {
    throw conflict('MODULE_UPGRADE_BLOCKED', '撤回版本不能作为批量升级目标')
  }
  return withDeferredCommandReceipt(
    db,
    {
      actor: input.actor,
      key: parsed.idempotencyKey,
      command: 'batch_upgrade',
      request: { moduleId, ...parsed },
      moduleId,
    },
    async () => {
      const results: ModuleBatchUpgradeResponse['results'] = []
      for (const scenarioId of parsed.scenarioIds) {
        try {
          const { scenario, document, revision } = await loadDraftDocument(db, scenarioId)
          if (scenario.purpose !== 'user') {
            results.push({ scenarioId, status: 'skipped', code: 'MODULE_VERIFICATION_NOT_BATCHABLE', reason: '验证场景不参加批量升级' })
            continue
          }
          const invocations = document.nodes.filter(
            (node): node is Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'module' }> =>
              node.kind === 'module' && node.moduleId === moduleId && node.moduleVersionId !== to.versionId,
          )
          if (invocations.length === 0) {
            results.push({ scenarioId, status: 'skipped', code: 'MODULE_UPGRADE_NOT_NEEDED', reason: '没有需要升级的调用' })
            continue
          }
          let next = document
          let blocked: string | undefined
          let confirm: string | undefined
          for (const invocation of invocations) {
            const preview = await previewUpgradeOnDocument(db, scenario, next, invocation.invocationId, to)
            const blockers = unresolvedUpgradeBlockers(preview.diffs, invocation, to.content.contract)
            const expandErrors = preview.diagnostics.filter((item) => item.severity === 'error')
            const warnings = unconfirmedUpgradeWarnings(preview.diffs, [])
            if (blockers.length || expandErrors.length) {
              blocked = blockers[0]?.message ?? expandErrors[0]?.message
              break
            }
            if (warnings.length) {
              confirm = warnings[0]!.message
              break
            }
            next = preview.document
          }
          if (blocked) {
            results.push({ scenarioId, status: 'skipped', code: 'MODULE_UPGRADE_BLOCKED', reason: blocked })
            continue
          }
          if (confirm) {
            results.push({ scenarioId, status: 'skipped', code: 'MODULE_UPGRADE_CONFIRMATION_REQUIRED', reason: confirm })
            continue
          }
          await saveScenarioDraft(db, scenarioId, { revision, document: next, actor: input.actor })
          results.push({ scenarioId, status: 'upgraded' })
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: string }).code) : 'MODULE_UPGRADE_BLOCKED'
          const message = error instanceof Error ? error.message : '升级失败'
          results.push({
            scenarioId,
            status: code === 'SCENARIO_DRAFT_CONFLICT' ? 'conflict' : 'skipped',
            code,
            reason: message,
          })
        }
      }
      return moduleBatchUpgradeResponseSchema.parse({ toVersionId: parsed.toVersionId, results })
    },
  )
}

const PUBLICATION_TRANSITIONS: Record<string, readonly string[]> = {
  published: ['deprecated', 'withdrawn'],
  deprecated: ['published', 'withdrawn'],
  withdrawn: ['deprecated'],
}

export async function updateModulePublication(
  db: Db,
  moduleId: string,
  versionId: string,
  input: ModulePublicationBody & { actor: ExecutionActor },
): Promise<ActionModuleVersionDto> {
  const parsed = modulePublicationBodySchema.parse({ status: input.status, reason: input.reason })
  await requireModule(db, moduleId)
  return atomic(db, async (tx) => {
    const { actionModuleVersions } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx
        .select()
        .from(actionModuleVersions)
        .where(and(eq(actionModuleVersions.id, versionId), eq(actionModuleVersions.moduleId, moduleId))),
    )
    if (!row) throw notFound('MODULE_VERSION_NOT_FOUND', '动作模块版本不存在')
    if (row.publicationStatus === parsed.status) {
      return getActionModuleVersion(tx as unknown as Db, moduleId, versionId)
    }
    if (!PUBLICATION_TRANSITIONS[row.publicationStatus]?.includes(parsed.status)) {
      throw conflict('MODULE_PUBLICATION_TRANSITION_INVALID', `不能从 ${row.publicationStatus} 迁移到 ${parsed.status}`)
    }
    await tx
      .update(actionModuleVersions)
      .set({ publicationStatus: parsed.status })
      .where(eq(actionModuleVersions.id, versionId))
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'module.publication',
      'module',
      moduleId,
      `版本 v${row.versionNo} ${row.publicationStatus} → ${parsed.status}：${parsed.reason}`,
    )
    return getActionModuleVersion(tx as unknown as Db, moduleId, versionId)
  })
}

export async function disableAffectedScenarios(
  db: Db,
  moduleId: string,
  input: {
    versionId: string
    scenarioIds: string[]
    confirm: true
    reason: string
    idempotencyKey: string
    actor: ExecutionActor
  },
) {
  await requireModule(db, moduleId)
  const parsed = disableAffectedScenariosBodySchema.parse({
    versionId: input.versionId,
    scenarioIds: input.scenarioIds,
    confirm: input.confirm,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })
  await getActionModuleVersion(db, moduleId, parsed.versionId)
  return withCommandReceipt(
    db,
    {
      actor: input.actor,
      key: parsed.idempotencyKey,
      command: 'disable_affected',
      request: { moduleId, ...parsed },
      moduleId,
    },
    async (tx) => {
      const refs = await listModuleReferences(tx, moduleId, { versionId: parsed.versionId, page: 1, pageSize: 100 })
      const allowed = new Set(
        refs.items
          .filter((item) => item.purpose === 'user' && item.publishedUses.some((use) => use.moduleVersionId === parsed.versionId))
          .map((item) => item.scenarioId),
      )
      const results = []
      for (const scenarioId of parsed.scenarioIds) {
        if (!allowed.has(scenarioId)) {
          results.push({ scenarioId, status: 'skipped' as const, reason: '场景未发布引用该版本' })
          continue
        }
        await updateScenarioMeta(tx, scenarioId, { status: 'disabled', actor: input.actor })
        results.push({ scenarioId, status: 'disabled' as const })
      }
      await recordAudit(tx, input.actor, 'module.publication', 'module', moduleId, `停用受影响场景：${parsed.reason}`)
      return disableAffectedScenariosResponseSchema.parse({ results })
    },
  )
}

async function userReferenceItems(db: Db, moduleId: string) {
  const listed = await listModuleReferences(db, moduleId, { page: 1, pageSize: 100 })
  return listed.items.filter((item) => item.purpose === 'user')
}

export async function previewDeleteActionModule(db: Db, moduleId: string): Promise<ModuleDeletePreviewResponse> {
  await requireModule(db, moduleId)
  const listed = await listModuleReferences(db, moduleId, { page: 1, pageSize: 100 })
  const draftReferences = listed.items.filter((item) => item.purpose === 'user' && item.draftUses.length > 0)
  const publishedReferences = listed.items.filter((item) => item.purpose === 'user' && item.publishedUses.length > 0)
  const verification = listed.items.find((item) => item.purpose === 'module_verification')
  const blockers = []
  if (verification) {
    const { runs } = schemaFor(db)
    const active = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(eq(runs.scenarioId, verification.scenarioId), isNull(runs.deletedAt)))
    const activeRuns = active.filter((row) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status))
    for (const row of activeRuns) {
      blockers.push({ code: 'RUN_NOT_TERMINAL', id: row.id, message: '验证场景存在未结束的运行' })
    }
  }
  return moduleDeletePreviewResponseSchema.parse({
    draftReferences,
    publishedReferences,
    verificationScenarioId: verification?.scenarioId ?? null,
    blockers,
  })
}

export async function deleteActionModuleProtected(
  db: Db,
  moduleId: string,
  actor: ExecutionActor,
): Promise<DeleteResourceResult> {
  await requireModule(db, moduleId)
  const users = await userReferenceItems(db, moduleId)
  if (users.some((item) => item.draftUses.length > 0 || item.publishedUses.length > 0)) {
    throw conflict('MODULE_REFERENCED', '模块仍被用户场景引用，不能删除', { references: users })
  }
  const preview = await previewDeleteActionModule(db, moduleId)
  if (preview.blockers.length) {
    throw conflict('RUN_NOT_TERMINAL', preview.blockers[0]!.message)
  }
  if (preview.verificationScenarioId) {
    await deleteScenario(db, preview.verificationScenarioId, actor)
  }
  const { actionModules } = schemaFor(db)
  const now = new Date()
  return atomic(db, async (tx) => {
    const [current] = await locked(tx, tx.select().from(actionModules).where(eq(actionModules.id, moduleId)))
    if (!current) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
    if (current.deletedAt && current.deletedBy) {
      return toDeleteResult({ id: moduleId, deletedAt: current.deletedAt, deletedBy: current.deletedBy })
    }
    const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
    await tx.update(actionModules).set({ deletedAt: now, deletedBy, updatedAt: now }).where(eq(actionModules.id, moduleId))
    await recordAudit(tx as unknown as Db, actor, 'module.delete', 'module', moduleId, '删除动作模块')
    return toDeleteResult({ id: moduleId, deletedAt: now, deletedBy })
  })
}

export async function extractModuleFromScenario(
  db: Db,
  scenarioId: string,
  input: {
    stepIds: string[]
    name: string
    key: string
    parameterized?: { stepId: string; key: string; label: string }[]
    confirmedPostconditionStepIds?: string[]
    description?: string
    idempotencyKey: string
    actor: ExecutionActor
  },
): Promise<ActionModuleDetail> {
  const parsed = moduleExtractBodySchema.parse({
    stepIds: input.stepIds,
    name: input.name,
    key: input.key,
    parameterized: input.parameterized ?? [],
    confirmedPostconditionStepIds: input.confirmedPostconditionStepIds ?? [],
    description: input.description,
    idempotencyKey: input.idempotencyKey,
  })
  const { scenario, document } = await loadDraftDocument(db, scenarioId)
  const built = buildExtractedModuleContent({
    document,
    selectedStepIds: parsed.stepIds,
    parameterized: parsed.parameterized,
    confirmedPostconditionStepIds: parsed.confirmedPostconditionStepIds,
  })
  if (!built.ok) throw badRequest('MODULE_EXTRACT_SELECTION_INVALID', built.proposal.error?.message ?? '提炼选择无效')
  const description = sourceDescription({
    scenarioName: scenario.name,
    scenarioId,
    draftRevision: scenario.draft!.revision,
    stepIds: parsed.stepIds,
    extra: parsed.description,
  })
  return withCommandReceipt(
    db,
    {
      actor: input.actor,
      key: parsed.idempotencyKey,
      command: 'extract',
      request: { scenarioId, ...parsed },
      scenarioId,
    },
    async (tx) => {
      const created = await createActionModule(tx, {
        idempotencyKey: `${parsed.idempotencyKey}:module`,
        targetId: scenario.targetId,
        key: parsed.key,
        name: parsed.name,
        description,
        capabilityKey: parsed.key,
        actor: input.actor,
      })
      const saved = await saveActionModuleDraft(tx, created.id, {
        baseRevision: created.draftRevision ?? 0,
        content: built.content,
        actor: input.actor,
      })
      await recordAudit(tx, input.actor, 'module.extract', 'module', saved.id, `从场景 ${scenarioId} 提炼模块`)
      return saved
    },
  )
}

export async function previewReplaceStepsWithModule(
  db: Db,
  scenarioId: string,
  input: { stepIds: string[]; moduleVersionId: string },
): Promise<ModuleReplacePreviewResponse> {
  const { scenario, document } = await loadDraftDocument(db, scenarioId)
  const versions = await listActionModuleVersions(db, (await findModuleIdForVersion(db, input.moduleVersionId)))
  const version = versions.items.find((item) => item.id === input.moduleVersionId)
  if (!version) throw notFound('MODULE_VERSION_NOT_FOUND', '动作模块版本不存在')
  if (version.moduleId && (await getActionModule(db, version.moduleId)).targetId !== scenario.targetId) {
    throw conflict('MODULE_TARGET_MISMATCH', '模块与场景不属于同一目标系统')
  }
  if (!isSelectablePublication(version.publicationStatus)) {
    throw conflict('MODULE_UPGRADE_BLOCKED', '撤回版本不能用于替换')
  }
  const invocation = buildReplaceInvocation({
    document,
    selectedStepIds: input.stepIds,
    moduleId: version.moduleId,
    moduleVersionId: version.id,
    invocationId: newId(),
    name: (await getActionModule(db, version.moduleId)).name,
  })
  const next = applyModuleReplace({ document, selectedStepIds: input.stepIds, invocation })
  const expansion = await expandWithLoader(db, scenario.targetId, next, 'preview', false)
  const entry = expansion.manifest.entries.find((item) => item.invocationId === invocation.invocationId)
  const expanded = (expansion.definition?.steps ?? []).filter((step) => entry?.expandedStepIds.includes(step.id))
  const original = document.nodes
    .filter((node): node is Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'step' }> => node.kind === 'step' && input.stepIds.includes(node.step.id))
    .map((node) => node.step)
  const steps = compareReplaceSteps(original, expanded, new Set(Object.values(invocation.outputBindings)))
  return moduleReplacePreviewResponseSchema.parse({
    equal: steps.every((item) => item.equal),
    steps,
    invocation,
  })
}

async function findModuleIdForVersion(db: Db, versionId: string): Promise<string> {
  const { actionModuleVersions } = schemaFor(db)
  const [row] = await db.select({ moduleId: actionModuleVersions.moduleId }).from(actionModuleVersions).where(eq(actionModuleVersions.id, versionId)).limit(1)
  if (!row) throw notFound('MODULE_VERSION_NOT_FOUND', '动作模块版本不存在')
  return row.moduleId
}

export async function replaceStepsWithModule(
  db: Db,
  scenarioId: string,
  input: {
    stepIds: string[]
    moduleVersionId: string
    baseRevision: number
    parameterized?: { stepId: string; key: string; label: string }[]
    idempotencyKey: string
    actor: ExecutionActor
  },
): Promise<ScenarioDetailDto> {
  const parsed = moduleReplaceBodySchema.parse({
    stepIds: input.stepIds,
    moduleVersionId: input.moduleVersionId,
    baseRevision: input.baseRevision,
    parameterized: input.parameterized ?? [],
    idempotencyKey: input.idempotencyKey,
  })
  return withCommandReceipt(
    db,
    {
      actor: input.actor,
      key: parsed.idempotencyKey,
      command: 'replace',
      request: { scenarioId, ...parsed },
      scenarioId,
    },
    async (tx) => {
      const { scenario, document, revision } = await loadDraftDocument(tx, scenarioId)
      if (revision !== parsed.baseRevision) throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', { revision })
      const preview = await previewReplaceStepsWithModule(tx, scenarioId, parsed)
      const next = applyModuleReplace({
        document,
        selectedStepIds: parsed.stepIds,
        invocation: parsed.parameterized.length
          ? buildReplaceInvocation({
              document,
              selectedStepIds: parsed.stepIds,
              moduleId: preview.invocation.moduleId,
              moduleVersionId: parsed.moduleVersionId,
              invocationId: preview.invocation.invocationId,
              name: preview.invocation.name ?? '动作模块',
              parameterized: parsed.parameterized,
            })
          : preview.invocation,
      })
      const saved = await saveScenarioDraft(tx, scenarioId, {
        revision: parsed.baseRevision,
        document: next,
        actor: input.actor,
      })
      await recordAudit(tx, input.actor, 'module.replace', 'scenario', scenarioId, '用模块替换原步骤')
      return saved
    },
  )
}

export async function proposeExtractFromScenario(db: Db, scenarioId: string, stepIds: string[]) {
  const { document } = await loadDraftDocument(db, scenarioId)
  return proposeModuleFromSteps(document, stepIds)
}
