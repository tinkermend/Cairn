import {
  collectAvailableContextKeys,
  insertModuleInvocation,
  resolveModulesByRules,
} from '@cairn/authoring'
import {
  FACTORY_PLATFORM_CONFIG,
  isSelectablePublication,
  moduleResolveAcceptBodySchema,
  moduleResolveCloseBodySchema,
  moduleResolveRequestSchema,
  moduleResolveResultSchema,
  normalizeAuthoringDocument,
  redactAuthoringExpression,
  type ExecutionActor,
  type ModuleResolveAcceptBody,
  type ModuleResolveAcceptResponse,
  type ModuleResolveCloseBody,
  type ModuleResolveRequest,
  type ModuleResolveResult,
  type ResolverCatalogModule,
  type ResolverTerm,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDetailDto,
} from '@cairn/shared'
import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { listTerminologyForCompose } from '../knowledge/terms.js'
import { newId } from '../id.js'
import { atomic, locked, schemaFor } from '../native.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { getScenario, previewScenarioExpansion, saveScenarioDraft } from '../runs/scenarios.js'
import { sha256Hex } from './digest.js'
import { getActionModuleVersion } from './modules.js'

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toResult(row: {
  id: string
  termRevision: string | null
  status: ModuleResolveResult['status']
  candidates: unknown
  inputSuggestions: unknown
  unknowns: unknown
  aiSkipped: string | null
  outcome: ModuleResolveResult['outcome']
}): ModuleResolveResult {
  return moduleResolveResultSchema.parse({
    requestId: row.id,
    status: row.status,
    termRevision: row.termRevision ?? undefined,
    aiSkipped: row.aiSkipped ?? undefined,
    candidates: row.candidates,
    inputSuggestions: row.inputSuggestions,
    unknowns: row.unknowns ?? [],
    outcome: row.outcome,
  })
}

async function requireLiveTarget(db: Db, targetId: string) {
  const { targets } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  return target
}

function requireUserAuthoringScenario(scenario: { purpose?: string | null }) {
  if ((scenario.purpose ?? 'user') !== 'user') {
    throw badRequest('RESOLUTION_SCENARIO_NOT_WRITABLE', '只能写入用户场景草稿，不能改验证或地图作业场景')
  }
}

async function loadCatalog(db: Db, targetId: string): Promise<ResolverCatalogModule[]> {
  const { actionModules, actionModuleVersions } = schemaFor(db)
  const modules = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.targetId, targetId), isNull(actionModules.deletedAt)))
  if (modules.length === 0) return []
  const versions = await db
    .select()
    .from(actionModuleVersions)
    .where(
      inArray(
        actionModuleVersions.moduleId,
        modules.map((item) => item.id),
      ),
    )
  return modules.map((module) => ({
    moduleId: module.id,
    targetId: module.targetId,
    key: module.key,
    name: module.name,
    capabilityKey: module.capabilityKey,
    aliases: Array.isArray(module.aliases) ? module.aliases : [],
    intentExamples: Array.isArray(module.intentExamples) ? module.intentExamples : [],
    tags: Array.isArray(module.tags) ? module.tags : [],
    versions: versions
      .filter((version) => version.moduleId === module.id)
      .map((version) => ({
        versionId: version.id,
        versionNo: version.versionNo,
        publishedAt: iso(version.createdAt),
        publicationStatus: version.publicationStatus,
        executionMode: version.executionMode,
        effectCeiling: version.effectCeiling,
        inputs: version.content.contract.inputs,
      })),
  }))
}

async function loadAvailableKeys(
  db: Db,
  scenarioId: string | undefined,
  anchorNodeId: string | undefined,
): Promise<string[] | undefined> {
  if (!scenarioId) return undefined
  const scenario = await getScenario(db, scenarioId)
  if (!scenario.draft) return []
  const document = normalizeAuthoringDocument(scenario.draft.document)
  return collectAvailableContextKeys(document, anchorNodeId)
}

export async function purgeExpiredModuleResolutions(db: Db, retainDays: number, now = new Date()): Promise<number> {
  const { moduleResolutionRequests } = schemaFor(db)
  const cutoff = new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000)
  const stale = await db
    .select({ id: moduleResolutionRequests.id })
    .from(moduleResolutionRequests)
    .where(lt(moduleResolutionRequests.createdAt, cutoff))
  if (stale.length === 0) return 0
  await db.delete(moduleResolutionRequests).where(
    inArray(
      moduleResolutionRequests.id,
      stale.map((item) => item.id),
    ),
  )
  return stale.length
}

export async function resolveActionModules(
  db: Db,
  input: ModuleResolveRequest & { actor: ExecutionActor },
): Promise<ModuleResolveResult> {
  const parsed = moduleResolveRequestSchema.parse({
    targetId: input.targetId,
    scenarioId: input.scenarioId,
    draftRevision: input.draftRevision,
    anchorNodeId: input.anchorNodeId,
    expression: input.expression,
    mode: input.mode,
    idempotencyKey: input.idempotencyKey,
    termRevision: input.termRevision,
  })
  const digest = sha256Hex({
    targetId: parsed.targetId,
    scenarioId: parsed.scenarioId ?? null,
    draftRevision: parsed.draftRevision ?? null,
    anchorNodeId: parsed.anchorNodeId ?? null,
    expression: parsed.expression,
    mode: parsed.mode,
  })
  const config = (await getPlatformConfig(db))?.document ?? FACTORY_PLATFORM_CONFIG
  await purgeExpiredModuleResolutions(db, config.moduleResolver.logRetentionDays)

  return atomic(db, async (tx) => {
    const { moduleResolutionRequests, consoleAccounts } = schemaFor(tx)
    await locked(tx, tx.select({ id: consoleAccounts.id }).from(consoleAccounts).where(eq(consoleAccounts.id, input.actor.id)))
    const [existing] = await tx
      .select()
      .from(moduleResolutionRequests)
      .where(
        and(
          eq(moduleResolutionRequests.actorId, input.actor.id),
          eq(moduleResolutionRequests.idempotencyKey, parsed.idempotencyKey),
        ),
      )
      .limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('RESOLUTION_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return toResult(existing)
    }

    await requireLiveTarget(tx as unknown as Db, parsed.targetId)
    if (parsed.scenarioId) {
      const scenario = await getScenario(tx as unknown as Db, parsed.scenarioId)
      if (scenario.targetId !== parsed.targetId) throw conflict('MODULE_TARGET_MISMATCH', '场景与模块不属于同一目标系统')
      requireUserAuthoringScenario(scenario)
    }

    const terms = (await listTerminologyForCompose(tx as unknown as Db, parsed.targetId)) as ResolverTerm[]
    const resolved = resolveModulesByRules({
      expression: parsed.expression,
      catalog: await loadCatalog(tx as unknown as Db, parsed.targetId),
      terms,
      availableKeys: await loadAvailableKeys(tx as unknown as Db, parsed.scenarioId, parsed.anchorNodeId),
      maxCandidates: config.moduleResolver.maxCandidates,
    })
    const now = new Date()
    const id = newId()
    const aiSkipped = parsed.mode === 'rules_then_ai' ? 'ai_layer_not_open' : undefined
    await tx.insert(moduleResolutionRequests).values({
      id,
      targetId: parsed.targetId,
      scenarioId: parsed.scenarioId ?? null,
      actorId: input.actor.id,
      idempotencyKey: parsed.idempotencyKey,
      requestDigest: digest,
      expression: redactAuthoringExpression(parsed.expression),
      mode: parsed.mode,
      termRevision: resolved.termRevision ?? null,
      status: resolved.status,
      candidates: resolved.candidates,
      inputSuggestions: resolved.inputSuggestions,
      unknowns: resolved.unknowns,
      aiSkipped: aiSkipped ?? null,
      outcome: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    await recordAudit(tx as unknown as Db, input.actor, 'module.resolve', 'target', parsed.targetId, `解析模块说法「${redactAuthoringExpression(parsed.expression).slice(0, 64)}」`)
    return toResult({
      id,
      termRevision: resolved.termRevision ?? null,
      status: resolved.status,
      candidates: resolved.candidates,
      inputSuggestions: resolved.inputSuggestions,
      unknowns: resolved.unknowns,
      aiSkipped: aiSkipped ?? null,
      outcome: 'pending',
    })
  })
}

export async function getModuleResolution(
  db: Db,
  requestId: string,
  actor: ExecutionActor,
): Promise<ModuleResolveResult> {
  const { moduleResolutionRequests } = schemaFor(db)
  const [row] = await db.select().from(moduleResolutionRequests).where(eq(moduleResolutionRequests.id, requestId)).limit(1)
  if (!row) throw notFound('RESOLUTION_NOT_FOUND', '映射请求不存在')
  if (row.actorId !== actor.id) throw notFound('RESOLUTION_NOT_FOUND', '映射请求不存在')
  return toResult(row)
}

export async function closeModuleResolution(
  db: Db,
  requestId: string,
  input: ModuleResolveCloseBody & { actor: ExecutionActor },
): Promise<ModuleResolveResult> {
  const parsed = moduleResolveCloseBodySchema.parse({ outcome: input.outcome })
  return atomic(db, async (tx) => {
    const { moduleResolutionRequests } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(moduleResolutionRequests).where(eq(moduleResolutionRequests.id, requestId)).limit(1),
    )
    if (!row || row.actorId !== input.actor.id) throw notFound('RESOLUTION_NOT_FOUND', '映射请求不存在')
    if (row.outcome !== 'pending') throw conflict('RESOLUTION_ALREADY_SETTLED', '映射请求已经结束')
    const now = new Date()
    await tx
      .update(moduleResolutionRequests)
      .set({ outcome: parsed.outcome, updatedAt: now })
      .where(eq(moduleResolutionRequests.id, requestId))
    return toResult({ ...row, outcome: parsed.outcome })
  })
}

export async function acceptModuleResolution(
  db: Db,
  scenarioId: string,
  requestId: string,
  input: ModuleResolveAcceptBody & { actor: ExecutionActor },
): Promise<ModuleResolveAcceptResponse> {
  const parsed = moduleResolveAcceptBodySchema.parse({
    moduleVersionId: input.moduleVersionId,
    inputBindings: input.inputBindings,
    outputBindings: input.outputBindings,
    anchorNodeId: input.anchorNodeId,
    baseRevision: input.baseRevision,
    idempotencyKey: input.idempotencyKey,
  })
  return atomic(db, async (tx) => {
    const { moduleResolutionRequests } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(moduleResolutionRequests).where(eq(moduleResolutionRequests.id, requestId)).limit(1),
    )
    if (!row || row.actorId !== input.actor.id) throw notFound('RESOLUTION_NOT_FOUND', '映射请求不存在')
    if (row.outcome === 'accepted' && row.acceptIdempotencyKey === parsed.idempotencyKey && row.acceptResponse) {
      return row.acceptResponse as ModuleResolveAcceptResponse
    }
    if (row.outcome !== 'pending') throw conflict('RESOLUTION_ALREADY_SETTLED', '映射请求已经结束')
    if (row.scenarioId && row.scenarioId !== scenarioId) throw conflict('MODULE_TARGET_MISMATCH', '映射请求不属于该场景')

    const scenario = await getScenario(tx as unknown as Db, scenarioId)
    if (scenario.targetId !== row.targetId) throw conflict('MODULE_TARGET_MISMATCH', '场景与模块不属于同一目标系统')
    requireUserAuthoringScenario(scenario)
    if (!scenario.draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
    if (scenario.draft.revision !== parsed.baseRevision) {
      throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', { revision: scenario.draft.revision })
    }

    const candidates = moduleResolveResultSchema.shape.candidates.parse(row.candidates)
    const candidate = candidates.find((item) => item.moduleVersionId === parsed.moduleVersionId)
    if (!candidate) throw conflict('RESOLUTION_CANDIDATE_MISMATCH', '所选版本不在本次候选中')

    const version = await getActionModuleVersion(tx as unknown as Db, candidate.moduleId, parsed.moduleVersionId)
    if (!isSelectablePublication(version.publicationStatus)) {
      throw conflict('RESOLUTION_CANDIDATE_UNAVAILABLE', '候选版本已不可用')
    }

    const allowedInputs = new Set(version.content.contract.inputs.map((item) => item.key))
    for (const key of Object.keys(parsed.inputBindings)) {
      if (!allowedInputs.has(key)) throw badRequest('RESOLUTION_BINDING_INVALID', `未知模块输入「${key}」`)
    }

    const document = normalizeAuthoringDocument(scenario.draft.document) as ScenarioAuthoringDocumentV2
    const invocation = {
      kind: 'module' as const,
      invocationId: newId(),
      name: candidate.name,
      moduleId: candidate.moduleId,
      moduleVersionId: version.id,
      implementationKey: 'default',
      inputBindings: parsed.inputBindings,
      outputBindings: parsed.outputBindings,
    }
    const next = insertModuleInvocation(document, invocation, parsed.anchorNodeId)
    if (!next) throw notFound('RESOLUTION_ANCHOR_NOT_FOUND', '插入位置不存在')

    const saved = await saveScenarioDraft(tx as unknown as Db, scenarioId, {
      revision: parsed.baseRevision,
      document: next,
      actor: input.actor,
    })
    const expansion = await previewScenarioExpansion(tx as unknown as Db, scenarioId, {
      document: saved.draft?.document,
    })
    const request = toResult({
      ...row,
      outcome: 'accepted',
    })
    const response: ModuleResolveAcceptResponse = {
      request: { ...request, outcome: 'accepted' },
      scenario: saved,
      diagnostics: expansion.diagnostics,
    }
    const now = new Date()
    await tx
      .update(moduleResolutionRequests)
      .set({
        scenarioId,
        outcome: 'accepted',
        acceptedModuleVersionId: version.id,
        acceptIdempotencyKey: parsed.idempotencyKey,
        acceptResponse: response,
        updatedAt: now,
      })
      .where(eq(moduleResolutionRequests.id, requestId))
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'module.resolve_accept',
      'scenario',
      scenarioId,
      `接受模块映射 ${candidate.key}@v${candidate.versionNo}`,
    )
    return response
  })
}

export type { ScenarioDetailDto }
