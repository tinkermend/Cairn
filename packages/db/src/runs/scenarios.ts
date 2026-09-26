import type { ScenarioRow, ScenarioVersionRow } from '../records.js'
import { atomic, locked, schemaFor } from '../native.js'
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import {
  compileScenarioDocument,
  deriveOutcomeManifest,
  deriveRuntimeInvariantManifest,
  expandAuthoringDocument,
  type ExpansionResult,
  type LoadedModuleVersion,
} from '@cairn/authoring'
import {
  ACTIVE_RUN_STATUSES,
  COMPILER_VERSION,
  effectivePoliciesForSteps,
  FACTORY_COMPILE_RESOLUTION,
  resolutionCapabilitiesFromPlatform,
  upgradeAuthoringLocatorDocument,
  snapshotNeedsBrowserAi,
  canonicalJson,
  syncSha256,
  ScenarioValidationError,
  assertRunFromResolved,
  deletePreviewResponseSchema,
  isAuthoringDocumentV2,
  authoringHasModuleInvocations,
  authoringHasOutcomes,
  authoringNodeId,
  authoringSteps,
  insertNodeAfter,
  locateNode,
  normalizeAuthoringDocument,
  parseScenarioDocument,
  removeNode,
  replaceNode,
  scenarioAuthoringDocumentV2Schema,
  walkAuthoringNodes,
  scenarioDefinitionFromSteps,
  scenarioDetailSchema,
  scenarioDocumentSchema,
  scenarioListQuerySchema,
  scenarioListResponseSchema,
  scenarioSchema,
  scenarioVersionListResponseSchema,
  scenarioVersionSchema,
  validateScenarioDefinition,
  type AuthoringStepNode,
  type CompileResult,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
  type JsonValue,
  type ModuleManifest,
  type ScenarioAuthoringDocumentV2,
  type CompileDiagnostic,
  type ScenarioDefinition,
  type ScenarioDetailDto,
  type ScenarioDocument,
  type ScenarioDto,
  type ScenarioInputDecl,
  type ScenarioOutputDecl,
  type ScenarioListQuery,
  type ScenarioListResponse,
  type ScenarioStatus,
  type ScenarioVersionDto,
  type ScenarioVersionListResponse,
  type Step,
  type ModuleContent,
  type CompileContext,
  type CompileResolutionContext,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { freezeMapDraftBindingsTx, reconcileMapDraftBindingsTx } from '../map/references.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { sha256Hex } from './digest.js'
import { expireRepairCandidatesOnPublishTx } from '../repair/index.js'
import {
  computeContentDigest,
  computeContractDigest,
  computeImplementationDigest,
} from '../action-modules/digest.js'
import { badRequest, conflict, forbidden, isUniqueViolation, mapRestriction, notFound } from './errors.js'
import { assertTargetPermission, lockConsoleAuthorization, targetScopeFor } from '../console/target-authorization.js'
import { draftValidationSubject, saveValidationSubjectTx } from './validation.js'
import { suiteReferenceBlockers, suitesReferencingScenario } from '../suites/suites.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import {
  activeRunBlockers,
  assertExpectedCounts,
  assertResourceIdle,
  closeOpenBindings,
  deletedOccupancyMessage,
  snapshotDeletedBy,
  toDeleteResult,
} from '../lifecycle.js'

function iso(value: Date): string {
  return value.toISOString()
}

function rethrow(error: unknown): never {
  if (error instanceof ScenarioValidationError) {
    throw badRequest(error.code, error.message)
  }
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

function sourceDocumentDigest(value: unknown): string {
  return sha256Hex(scenarioDocumentSchema.parse(value))
}

function authoringExtrasDigest(input: {
  authoringDocument?: ScenarioAuthoringDocumentV2 | null
  definition?: ScenarioDefinition | null
}): string {
  return sha256Hex({
    runtimeInvariantManifest: deriveRuntimeInvariantManifest(input.authoringDocument ?? null) ?? null,
    outcomeManifest: deriveOutcomeManifest({
      authoringDocument: input.authoringDocument ?? null,
      definition: input.definition ?? null,
    }) ?? null,
  })
}

function isDraftDirty(draftDocument: unknown, publishedDefinition: unknown, publishedAuthoringDocument?: unknown): boolean {
  try {
    // v2 编排文档与编译后的运行定义结构不同；应与发布时冻结的编排文档比较。
    if (publishedAuthoringDocument) {
      return sha256Hex(normalizeAuthoringDocument(draftDocument)) !==
        sha256Hex(normalizeAuthoringDocument(publishedAuthoringDocument))
    }
    return sourceDocumentDigest(draftDocument) !== sourceDocumentDigest(publishedDefinition)
  } catch {
    return true
  }
}

function publishedVersionNo(row: ScenarioVersionRow): number {
  if (row.versionNo == null) {
    throw notFound('SCENARIO_VERSION_NOT_FOUND', '已发布场景版本不存在')
  }
  return row.versionNo
}

async function latestPublishedVersion(db: Db, scenarioId: string) {
  const { scenarioVersions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, scenarioId), eq(scenarioVersions.kind, 'published')))
    .orderBy(desc(scenarioVersions.versionNo))
    .limit(1)
  if (!row) throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
  return row
}

async function loadTargetContext(db: Db, targetId: string) {
  const { targets } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target || target.deletedAt) return { exists: false as const, status: 'disabled' as const, row: null }
  return { exists: true as const, status: target.status, row: target }
}

export type ScenarioCompileOptions = {
  executableTypes?: readonly string[]
  resolution?: CompileResolutionContext
}

async function compileResolutionFromPlatform(db: Db, targetId?: string): Promise<CompileResolutionContext> {
  const { minResolutionPolicy } = await import('@cairn/shared')
  const { loadResolutionLayers } = await import('./resolution-layers.js')
  const layers = await loadResolutionLayers(db, targetId)
  const caps = resolutionCapabilitiesFromPlatform(layers.document)
  const effectiveCeiling = minResolutionPolicy(caps.ceiling, layers.targetCeiling ?? 'ai_only')
  return {
    ...FACTORY_COMPILE_RESOLUTION,
    ceiling: caps.ceiling,
    default: caps.default,
    targetCeiling: layers.targetCeiling,
    targetPreference: layers.targetPreference,
    aiRungAvailable: caps.aiRungAvailable && effectiveCeiling !== 'deterministic_only',
    waitKindsAvailable: caps.waitKindsAvailable,
    locatorDocument: layers.document,
    locatorTarget: layers.targetPolicy,
  }
}

function compileDocument(
  document: ScenarioDocument,
  target: { exists: boolean; status: 'active' | 'disabled' },
  mode: 'save' | 'release',
  options?: ScenarioCompileOptions,
  outcomeManifest?: ReturnType<typeof deriveOutcomeManifest> | { entries: [] },
): CompileResult {
  return compileScenarioDocument(document, {
    mode,
    target,
    executableTypes: mode === 'save' ? undefined : options?.executableTypes,
    resolution: {
      ...FACTORY_COMPILE_RESOLUTION,
      ...options?.resolution,
      documentResolution: options?.resolution?.documentResolution ?? document.resolution,
      documentLocatorPlan: options?.resolution?.documentLocatorPlan ?? document.locatorPlan,
      locatorProtocol: options?.resolution?.locatorProtocol ?? document.locatorProtocol,
    },
    ...(outcomeManifest !== undefined ? { outcomeManifest } : {}),
  })
}

function throwIfBlocked(result: CompileResult): CompileResult {
  if (!result.ok) {
    throw badRequest('SCENARIO_COMPILE_BLOCKED', '场景编译未通过', {
      diagnostics: result.diagnostics,
    })
  }
  return result
}

function parseDocument(input: unknown): ScenarioDocument {
  try {
    if (isAuthoringDocumentV2(input)) {
      return parseScenarioDocument({
        schemaVersion: input.schemaVersion,
        inputs: input.inputs,
        steps: authoringSteps(input),
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.locatorPlan ? { locatorPlan: input.locatorPlan } : {}),
        ...(input.locatorProtocol === 2 ? { locatorProtocol: 2 as const } : {}),
      })
    }
    return parseScenarioDocument(input)
  } catch (error) {
    if (isZodError(error)) {
      throw badRequest('BAD_REQUEST', error.issues[0]?.message ?? '场景文档不合法')
    }
    throw error
  }
}

async function loadDraft(db: Db, scenarioId: string) {
  const { scenarioDrafts } = schemaFor(db)
  const [draft] = await db
    .select()
    .from(scenarioDrafts)
    .where(eq(scenarioDrafts.scenarioId, scenarioId))
    .limit(1)
  return draft ?? null
}

async function draftUpdatedBy(db: Db, accountId: string) {
  const { consoleAccounts } = schemaFor(db)
  const [account] = await db
    .select({ id: consoleAccounts.id, displayName: consoleAccounts.displayName })
    .from(consoleAccounts)
    .where(eq(consoleAccounts.id, accountId))
    .limit(1)
  return { id: accountId, displayName: account?.displayName || '控制台用户' }
}

export function createModuleVersionLoader(
  db: Db,
  scenarioTargetId: string,
  allowDraftFallback = false,
) {
  return async (moduleId: string, versionId?: string): Promise<LoadedModuleVersion | null> => {
    const { actionModules, actionModuleVersions } = schemaFor(db)
    const [mod] = await db
      .select()
      .from(actionModules)
      .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
      .limit(1)
    if (!mod) return null

    if (versionId) {
      const [ver] = await db
        .select()
        .from(actionModuleVersions)
        .where(and(eq(actionModuleVersions.id, versionId), eq(actionModuleVersions.moduleId, moduleId)))
        .limit(1)
      if (!ver) return null
      return {
        versionId: ver.id,
        moduleId: ver.moduleId,
        targetId: mod.targetId,
        moduleKey: mod.key,
        name: mod.name,
        versionNo: ver.versionNo,
        publicationStatus: ver.publicationStatus,
        contentDigest: ver.contentDigest,
        contractDigest: ver.contractDigest,
        implementationDigest: ver.implementationDigest,
        content: ver.content as ModuleContent,
      }
    }

    if (allowDraftFallback && mod.draftContent) {
      const content = mod.draftContent as ModuleContent
      return {
        versionId: undefined,
        moduleId: mod.id,
        targetId: mod.targetId,
        moduleKey: mod.key,
        name: mod.name,
        versionNo: 0,
        draftRevision: mod.draftRevision,
        publicationStatus: 'published',
        contentDigest: computeContentDigest(content),
        contractDigest: computeContractDigest(content.contract),
        implementationDigest: computeImplementationDigest(content.implementations),
        content,
      }
    }

    return null
  }
}

export async function expandWithLoader(
  db: Db,
  targetId: string,
  doc: ScenarioAuthoringDocumentV2,
  mode: 'publish' | 'trial' | 'preview',
  allowDraftFallback: boolean,
  compilerCtx?: Partial<CompileContext>,
): Promise<ExpansionResult> {
  const loader = createModuleVersionLoader(db, targetId, allowDraftFallback)
  const loadedModules = new Map<string, LoadedModuleVersion>()
  for (const item of walkAuthoringNodes(doc)) {
    const node = item.node
    if (node.kind === 'module') {
      const loaded = await loader(node.moduleId, node.moduleVersionId)
      if (loaded) {
        // 键必须与 expandAuthoringDocument 的查找键一致：引用版本用 versionId，
        // 引用草稿用 moduleId。两者都写会让同一模块的草稿与已发布版本互相覆盖。
        if (loaded.versionId) {
          loadedModules.set(loaded.versionId, loaded)
        } else {
          loadedModules.set(loaded.moduleId, loaded)
        }
      }
    }
  }
  const { getOrCreatePlatformConfig } = await import('../platform-config/store.js')
  const platform = await getOrCreatePlatformConfig(db)
  const resolution = await compileResolutionFromPlatform(db, targetId)
  return expandAuthoringDocument(doc, {
    targetId,
    mode,
    loadedModules,
    compilerCtx: {
      ...compilerCtx,
      resolution: {
        ...resolution,
        ...compilerCtx?.resolution,
        documentResolution: compilerCtx?.resolution?.documentResolution ?? doc.resolution,
      },
    },
    fallbackEnabled: platform.document.moduleFallback.enabled,
  })
}

export async function syncScenarioModuleRefsTx(
  tx: Db,
  scenarioId: string,
  scenarioVersionId: string | null,
  document: ScenarioAuthoringDocumentV2,
): Promise<void> {
  const { scenarioModuleRefs } = schemaFor(tx)
  // 同一作用域（草稿或某个版本）先清后写，重复试跑同一摘要不会累积重复引用行
  await tx
    .delete(scenarioModuleRefs)
    .where(
      and(
        eq(scenarioModuleRefs.scenarioId, scenarioId),
        scenarioVersionId === null
          ? isNull(scenarioModuleRefs.scenarioVersionId)
          : eq(scenarioModuleRefs.scenarioVersionId, scenarioVersionId),
      ),
    )
  const invocations = walkAuthoringNodes(document).flatMap((item) =>
    item.node.kind === 'module' ? [item.node] : [],
  )
  if (invocations.length === 0) return

  const moduleIds = [...new Set(invocations.map((node) => node.moduleId))]
  if (moduleIds.length > 0) {
    const { actionModules } = schemaFor(tx)
    const lockedModules = await locked(
      tx,
      tx.select({ id: actionModules.id, deletedAt: actionModules.deletedAt })
        .from(actionModules)
        .where(inArray(actionModules.id, moduleIds)),
    )
    for (const m of lockedModules) {
      if (m.deletedAt) {
        throw conflict('MODULE_NOT_FOUND', '引用的动作模块已被删除')
      }
    }
  }

  for (const node of invocations) {
    await tx.insert(scenarioModuleRefs).values({
      id: newId(),
      scenarioId,
      scenarioVersionId,
      invocationId: node.invocationId,
      moduleId: node.moduleId,
      moduleVersionId: node.moduleVersionId ?? null,
      createdAt: new Date(),
    })
  }
}

function toScenarioDto(
  row: ScenarioRow,
  latest: ScenarioVersionRow,
  draftDirty: boolean,
): ScenarioDto {
  return scenarioSchema.parse({
    id: row.id,
    targetId: row.targetId,
    name: row.name,
    status: row.status,
    purpose: row.purpose ?? 'user',
    latestVersionId: latest.id,
    latestVersionNo: publishedVersionNo(latest),
    stepCount: latest.definition.steps.length,
    draftDirty,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toVersionDto(version: ScenarioVersionRow): ScenarioVersionDto {
  return scenarioVersionSchema.parse({
    id: version.id,
    scenarioId: version.scenarioId,
    versionNo: version.versionNo,
    kind: version.kind,
    definition: version.definition,
    compilerVersion: version.compilerVersion,
    authoringDocument: version.authoringDocument ?? undefined,
    moduleManifest: version.moduleManifest ?? undefined,
    createdAt: iso(version.createdAt),
  })
}

function isV2Document(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false
  const d = doc as Record<string, unknown>
  if (d.authoringSchemaVersion === 2) return true
  if (Array.isArray(d.nodes)) return true
  return false
}

async function toDetailDto(
  db: Db,
  row: ScenarioRow,
  latest: ScenarioVersionRow,
  options?: ScenarioCompileOptions,
): Promise<ScenarioDetailDto> {
  const draft = await loadDraft(db, row.id)
  const target = await loadTargetContext(db, row.targetId)
  const authoringDoc = normalizeAuthoringDocument(
    draft?.document ?? latest.authoringDocument ?? latest.definition,
  )
  let compiled: CompileResult
  const hasModuleInvocations = authoringHasModuleInvocations(authoringDoc)
  const resolution = options?.resolution ?? (await compileResolutionFromPlatform(db, row.targetId))
  const compileOptions = { ...options, resolution }
  if (hasModuleInvocations) {
    const expansion = await expandWithLoader(db, row.targetId, authoringDoc, 'preview', true, {
      resolution,
    })
    compiled = {
      ok: expansion.ok,
      definition: expansion.definition!,
      compilerVersion: COMPILER_VERSION,
      diagnostics: expansion.diagnostics,
    }
  } else {
    const legacyDoc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: authoringDoc.inputs,
      steps: authoringSteps(authoringDoc),
      ...(authoringDoc.resolution ? { resolution: authoringDoc.resolution } : {}),
      ...(authoringDoc.locatorPlan ? { locatorPlan: authoringDoc.locatorPlan } : {}),
      ...(authoringDoc.locatorProtocol === 2 ? { locatorProtocol: 2 as const } : {}),
    }
    compiled = compileDocument(
      legacyDoc,
      target,
      'release',
      compileOptions,
      deriveOutcomeManifest({ authoringDocument: authoringDoc }) ?? { entries: [] },
    )
  }
  const dirty = draft ? isDraftDirty(draft.document, latest.definition, latest.authoringDocument) : false
  return scenarioDetailSchema.parse({
    ...toScenarioDto(row, latest, dirty),
    steps: latest.definition.steps,
    published: {
      versionId: latest.id,
      versionNo: publishedVersionNo(latest),
      definition: latest.definition,
      compilerVersion: latest.compilerVersion,
      authoringDocument: latest.authoringDocument ?? undefined,
      moduleManifest: latest.moduleManifest ?? undefined,
      createdAt: iso(latest.createdAt),
    },
    draft: draft
      ? {
          revision: draft.revision,
          document: draft.document,
          updatedAt: iso(draft.updatedAt),
          updatedBy: await draftUpdatedBy(db, draft.updatedByConsoleAccountId),
        }
      : undefined,
    compile: {
      ok: compiled.ok,
      compilerVersion: compiled.compilerVersion,
      diagnostics: compiled.diagnostics,
    },
  })
}

export async function getScenario(
  db: Db,
  scenarioId: string,
  options?: ScenarioCompileOptions,
): Promise<ScenarioDetailDto> {
  const { scenarios } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const latest = await latestPublishedVersion(db, scenarioId)
  return toDetailDto(db, row, latest, options)
}

export async function listScenarios(
  db: Db,
  query: ScenarioListQuery = {},
  actorId?: string,
): Promise<ScenarioListResponse> {
  const parsed = scenarioListQuerySchema.parse(query)
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const limit = parsed.limit
  const filters: (SQL | undefined)[] = [
    await (await import('../console/target-authorization.js')).scopedTargetFilter(db, actorId, scenarios.targetId, 'workflow:read'),
    isNull(scenarios.deletedAt),
    parsed.targetId ? eq(scenarios.targetId, parsed.targetId) : undefined,
    parsed.status ? eq(scenarios.status, parsed.status) : undefined,
    parsed.purpose
      ? eq(scenarios.purpose, parsed.purpose)
      : or(eq(scenarios.purpose, 'user'), isNull(scenarios.purpose)),
    parsed.search
      ? sql`lower(${scenarios.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`
      : undefined,
    parsed.hasDraft === true
      ? inArray(
          scenarios.id,
          db.select({ scenarioId: scenarioDrafts.scenarioId }).from(scenarioDrafts),
        )
      : parsed.hasDraft === false
        ? notInArray(
            scenarios.id,
            db.select({ scenarioId: scenarioDrafts.scenarioId }).from(scenarioDrafts),
          )
        : undefined,
    cursorFilter(scenarios.createdAt, scenarios.id, parsed.cursor),
  ]
  const rows = await db
    .select()
    .from(scenarios)
    .where(and(...filters.filter((f): f is SQL => f !== undefined)))
    .orderBy(desc(scenarios.createdAt), desc(scenarios.id))
    .limit(limit + 1)

  const paginated = paginateResults(rows, limit)
  const pageScenarioIds = paginated.items.map((r) => r.id)

  let latestByScenario = new Map<string, typeof scenarioVersions.$inferSelect>()
  if (pageScenarioIds.length > 0) {
    const rankedVersions = db
      .select({
        id: scenarioVersions.id,
        scenarioId: scenarioVersions.scenarioId,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${scenarioVersions.scenarioId} ORDER BY ${scenarioVersions.versionNo} DESC)`.as(
          'rn',
        ),
      })
      .from(scenarioVersions)
      .where(
        and(
          inArray(scenarioVersions.scenarioId, pageScenarioIds),
          eq(scenarioVersions.kind, 'published'),
        ),
      )
      .as('ranked_versions')

    const latestVersionRows = await db
      .select({ version: scenarioVersions })
      .from(scenarioVersions)
      .innerJoin(
        rankedVersions,
        and(eq(scenarioVersions.id, rankedVersions.id), eq(rankedVersions.rn, 1)),
      )

    latestByScenario = new Map(latestVersionRows.map((r) => [r.version.scenarioId, r.version]))
  }

  const drafts =
    pageScenarioIds.length > 0
      ? await db
          .select()
          .from(scenarioDrafts)
          .where(inArray(scenarioDrafts.scenarioId, pageScenarioIds))
      : []
  const draftById = new Map(drafts.map((draft) => [draft.scenarioId, draft]))

  const items: ScenarioDto[] = []
  for (const row of paginated.items) {
    const latest = latestByScenario.get(row.id)
    if (!latest) throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
    const draft = draftById.get(row.id)
    items.push(
      toScenarioDto(row, latest, draft ? isDraftDirty(draft.document, latest.definition, latest.authoringDocument) : false),
    )
  }
  return scenarioListResponseSchema.parse({
    items,
    nextCursor: paginated.nextCursor,
    hasMore: paginated.hasMore,
  })
}

export async function listScenarioVersions(
  db: Db,
  scenarioId: string,
): Promise<ScenarioVersionListResponse> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const [row] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const versions = await db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, scenarioId), eq(scenarioVersions.kind, 'published')))
    .orderBy(asc(scenarioVersions.versionNo))
  return scenarioVersionListResponseSchema.parse({
    items: versions.map(toVersionDto),
  })
}

export async function createScenarioWithVersion(
  db: Db,
  input: {
    targetId: string
    name: string
    steps: Step[]
    inputs?: ScenarioInputDecl[]
    outputs?: ScenarioOutputDecl
    status?: ScenarioStatus
    actor: AuditActor
    compileMode?: 'save' | 'release'
    executableTypes?: readonly string[]
  },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? [], input.outputs))
  const target = await loadTargetContext(db, input.targetId)
  if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled')
    throw conflict('TARGET_DISABLED', '目标系统已停用，不能新建场景')
  const compiled = compileDocument(document, target, input.compileMode ?? 'release', {
    executableTypes: input.executableTypes,
    resolution: await compileResolutionFromPlatform(db, input.targetId),
  })
  if ((input.compileMode ?? 'release') === 'release') throwIfBlocked(compiled)

  const id = newId()
  const versionId = newId()
  const now = new Date()
  const digest = sourceDocumentDigest(compiled.definition)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(scenarios).values({
        id,
        targetId: input.targetId,
        name: input.name,
        status: input.status ?? 'active',
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId: id,
        versionNo: 1,
        kind: 'published',
        definition: compiled.definition,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: digest,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await tx.insert(scenarioDrafts).values({
        scenarioId: id,
        revision: 1,
        document: compiled.definition,
        updatedByConsoleAccountId: input.actor.id,
        updatedAt: now,
      })
      const authoring = normalizeAuthoringDocument(compiled.definition)
      const expansion = await expandWithLoader(tx as unknown as Db, input.targetId, authoring, 'preview', true)
      if (expansion.ok) await saveValidationSubjectTx(tx as unknown as Db, versionId, await draftValidationSubject(tx as unknown as Db, input.targetId, id, authoring, expansion))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.create',
        'scenario',
        id,
        `创建了 ${compiled.definition.steps.length} 步的场景「${input.name}」`,
      )
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const occupied = await deletedOccupancyMessage(db, 'scenario_name', {
        targetId: input.targetId,
        name: input.name,
      })
      if (occupied) throw conflict('SCENARIO_NAME_CONFLICT', occupied)
    }
    rethrow(error)
  }
  return getScenario(db, id, input)
}

export async function updateScenarioMeta(
  db: Db,
  scenarioId: string,
  input: { name?: string; status?: ScenarioStatus; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarios } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(scenarios)
        .set({
          name: input.name ?? current.name,
          status: input.status ?? current.status,
          updatedAt: now,
        })
        .where(eq(scenarios.id, scenarioId))
      if (input.name !== undefined && input.name !== current.name) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          `改名为 ${input.name}`,
        )
      }
      if (input.status !== undefined && input.status !== current.status) {
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          input.status === 'disabled' ? '停用' : '启用',
        )
      }
    })
  } catch (error) {
    if (isUniqueViolation(error) && input.name) {
      const occupied = await deletedOccupancyMessage(db, 'scenario_name', {
        targetId: current.targetId,
        name: input.name,
      })
      if (occupied) throw conflict('SCENARIO_NAME_CONFLICT', occupied)
    }
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function appendScenarioVersion(
  db: Db,
  scenarioId: string,
  input: { steps: Step[]; inputs?: ScenarioInputDecl[]; outputs?: ScenarioOutputDecl; actor: AuditActor; executableTypes?: readonly string[] },
): Promise<ScenarioDetailDto> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? [], input.outputs))
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      throwIfBlocked(
        compileDocument(document, target, 'release', {
          executableTypes: input.executableTypes,
          resolution: await compileResolutionFromPlatform(tx as unknown as Db, current.targetId),
        }),
      )
      const latest = await latestPublishedVersion(tx as unknown as Db, scenarioId)
      const versionNo = publishedVersionNo(latest) + 1
      const versionId = newId()
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId,
        versionNo,
        kind: 'published',
        definition: document,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: sourceDocumentDigest(document),
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      const authoring = normalizeAuthoringDocument(document)
      const expansion = await expandWithLoader(tx as unknown as Db, current.targetId, authoring, 'preview', true)
      await saveValidationSubjectTx(tx as unknown as Db, versionId, await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoring, expansion))
      await freezeMapDraftBindingsTx(tx as unknown as Db, { scenarioId, targetId: current.targetId, scenarioVersionId: versionId })
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `追加了 ${document.steps.length} 步的版本 ${versionNo}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId, input)
}

export async function saveScenarioDraft(
  db: Db,
  scenarioId: string,
  input: { revision: number; document: unknown; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const document = normalizeAuthoringDocument(input.document)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      const existingDoc = normalizeAuthoringDocument(draft.document)
      if (authoringHasModuleInvocations(existingDoc) && !isAuthoringDocumentV2(input.document)) {
        throw badRequest(
          'AUTHORING_SCHEMA_UNSUPPORTED',
          '草稿已包含动作模块调用，旧客户端不能覆盖为 V1 文档。请更新编辑器。',
        )
      }
      if (authoringHasOutcomes(existingDoc) && !isAuthoringDocumentV2(input.document)) {
        throw badRequest(
          'AUTHORING_SCHEMA_UNSUPPORTED',
          '草稿已包含成功条件或运行期约束，旧客户端不能覆盖为 V1 文档。请更新编辑器。',
        )
      }
      const resolution = await compileResolutionFromPlatform(tx as unknown as Db, current.targetId)
      const savedDoc = upgradeAuthoringLocatorDocument({
        document,
        platform: resolution.locatorDocument!,
        target: resolution.locatorTarget,
      })
      await reconcileMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        revision: draft.revision + 1,
        document: savedDoc,
      })
      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document: savedDoc as any,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, savedDoc)
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `保存草稿 r${draft.revision + 1}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

export async function publishScenarioDraft(
  db: Db,
  scenarioId: string,
  input: { revision: number; actor: AuditActor; executableTypes?: readonly string[] },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能发布')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      if (target.status === 'disabled')
        throw conflict('TARGET_DISABLED', '目标系统已停用，不能发布')
      const authoringDoc = normalizeAuthoringDocument(draft.document)
      const expandResult = await expandWithLoader(tx as unknown as Db, current.targetId, authoringDoc, 'publish', false)
      if (!expandResult.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '场景编译未通过', {
          diagnostics: expandResult.diagnostics,
        })
      }
      const compiled = throwIfBlocked(
        compileDocument(
          expandResult.definition!,
          target,
          'release',
          {
            executableTypes: input.executableTypes,
            resolution: {
              ...(await compileResolutionFromPlatform(tx as unknown as Db, current.targetId)),
              documentResolution: expandResult.definition?.resolution,
            },
          },
          expandResult.outcomeManifest ?? { entries: [] },
        ),
      )
      const latest = await latestPublishedVersion(tx as unknown as Db, scenarioId)
      const validationDigest = await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoringDoc, expandResult)
      const { scenarioValidationSubjects } = schemaFor(tx)
      const [latestSubject] = await tx.select().from(scenarioValidationSubjects).where(eq(scenarioValidationSubjects.scenarioVersionId, latest.id)).limit(1)
      if (
        latestSubject?.subjectDigest === validationDigest &&
        sourceDocumentDigest(compiled.definition) === sourceDocumentDigest(latest.definition) &&
        authoringExtrasDigest({ authoringDocument: authoringDoc, definition: compiled.definition }) ===
          authoringExtrasDigest({
            authoringDocument: latest.authoringDocument ?? null,
            definition: latest.definition,
          })
      ) {
        return
      }
      const versionNo = publishedVersionNo(latest) + 1
      const versionId = newId()
      const digest =
        expandResult.manifest.entries.length > 0
          ? expandResult.sourceDigest
          : sourceDocumentDigest(compiled.definition)
      await tx.insert(scenarioVersions).values({
        id: versionId,
        scenarioId,
        versionNo,
        kind: 'published',
        definition: compiled.definition,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: digest,
        authoringDocument: authoringDoc,
        // 无模块调用时不落 manifest：旧 Worker 严格解析快照，空 manifest 也会被拒
        moduleManifest: expandResult.manifest.entries.length > 0 ? expandResult.manifest : null,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, versionId, authoringDoc)
      await saveValidationSubjectTx(tx as unknown as Db, versionId, validationDigest)
      await freezeMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        scenarioVersionId: versionId,
      })
      await expireRepairCandidatesOnPublishTx(tx, scenarioId, authoringDoc)
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `发布版本 ${versionNo}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId, input)
}

export async function prepareTrialVersion(
  db: Db,
  scenarioId: string,
  input: {
    revision: number
    runInput: Readonly<Record<string, unknown>>
    actor: AuditActor
    executableTypes?: readonly string[]
    overrideDocument?: unknown
  },
): Promise<{ versionId: string }> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const now = new Date()
  let versionId = ''
  try {
    await atomic(db, async (tx) => {
      await lockConsoleAuthorization(tx as unknown as Db, input.actor.id)
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能试跑')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      if (target.status === 'disabled')
        throw conflict('TARGET_DISABLED', '目标系统已停用，不能试跑')
      const authoringDoc = normalizeAuthoringDocument(input.overrideDocument ?? draft.document)
      const expandResult = await expandWithLoader(tx as unknown as Db, current.targetId, authoringDoc, 'trial', true)
      if (!expandResult.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '试跑编译未通过', {
          diagnostics: expandResult.diagnostics,
        })
      }
      const trialResolution = await compileResolutionFromPlatform(tx as unknown as Db, current.targetId)
      const compiled = throwIfBlocked(
        compileDocument(
          expandResult.definition!,
          target,
          'release',
          {
            executableTypes: input.executableTypes,
            resolution: {
              ...trialResolution,
              documentResolution: expandResult.definition?.resolution,
            },
          },
          expandResult.outcomeManifest ?? { entries: [] },
        ),
      )
      try {
        assertRunFromResolved(compiled.definition.steps, input.runInput)
      } catch (error) {
        if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
        throw error
      }
      const { getOrCreatePlatformConfig } = await import('../platform-config/store.js')
      const platform = await getOrCreatePlatformConfig(tx as unknown as Db)
      const effective = effectivePoliciesForSteps(
        compiled.definition.steps,
        {
          ...trialResolution,
          documentResolution: compiled.definition.resolution,
        },
        platform.document.browserAi.enabled,
      )
      if (snapshotNeedsBrowserAi(compiled.definition.steps, effective)) {
        const scope = await targetScopeFor(tx as unknown as Db, input.actor.id, 'ai:execute')
        if (!scope.all && !scope.ids.includes(current.targetId)) throw forbidden('AI_EXECUTE_FORBIDDEN', '缺少 ai:execute，不能运行含 AI 步骤或 AI 解析档位的场景')
      }
      const validationDigest = await draftValidationSubject(tx as unknown as Db, current.targetId, scenarioId, authoringDoc, expandResult)
      const digest = syncSha256(canonicalJson({ protocolVersion: 'trialSourceDigest@2', sourceDigest: expandResult.sourceDigest, validationSubjectDigest: validationDigest }))
      const [existing] = await tx
        .select()
        .from(scenarioVersions)
        .where(
          and(
            eq(scenarioVersions.scenarioId, scenarioId),
            eq(scenarioVersions.kind, 'trial'),
            eq(scenarioVersions.sourceDigest, digest),
          ),
        )
        .limit(1)
      let created = false
      if (existing) {
        versionId = existing.id
      } else {
        versionId = newId()
        try {
          await tx.insert(scenarioVersions).values({
            id: versionId,
            scenarioId,
            versionNo: null,
            kind: 'trial',
            definition: compiled.definition,
            compilerVersion: COMPILER_VERSION,
            sourceDigest: digest,
            authoringDocument: authoringDoc,
            moduleManifest:
              expandResult.manifest.entries.length > 0 ? expandResult.manifest : null,
            createdByConsoleAccountId: input.actor.id,
            createdAt: now,
          })
          created = true
        } catch (error) {
          const mapped = mapRestriction(error)
          if (mapped?.code === 'SCENARIO_NAME_CONFLICT') throw mapped
          const [again] = await tx
            .select()
            .from(scenarioVersions)
            .where(
              and(
                eq(scenarioVersions.scenarioId, scenarioId),
                eq(scenarioVersions.kind, 'trial'),
                eq(scenarioVersions.sourceDigest, digest),
              ),
            )
            .limit(1)
          if (!again) throw error
          versionId = again.id
        }
      }
      if (created) {
        await saveValidationSubjectTx(tx as unknown as Db, versionId, validationDigest)
        await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, versionId, authoringDoc)
        await freezeMapDraftBindingsTx(tx as unknown as Db, { scenarioId, targetId: current.targetId, scenarioVersionId: versionId })
        await recordAudit(
          tx as unknown as Db,
          input.actor,
          'scenario.update',
          'scenario',
          scenarioId,
          '创建试跑版本',
        )
      }
    })
  } catch (error) {
    rethrow(error)
  }
  return { versionId }
}

export async function previewDeleteScenario(
  db: Db,
  scenarioId: string,
): Promise<DeletePreviewResponse> {
  const { scenarios, runs } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  const scenarioRuns = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.scenarioId, scenarioId), isNull(runs.deletedAt)))

  const activeRuns = scenarioRuns.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status as any))
  const referenced = await suitesReferencingScenario(db, {
    targetId: current.targetId,
    scenarioId,
  })

  return deletePreviewResponseSchema.parse({
    previewToken: newId(),
    counts: {
      runs: scenarioRuns.length,
      suites: referenced.length,
    },
    blockers: [...activeRunBlockers(activeRuns), ...suiteReferenceBlockers(referenced)],
  })
}

export async function deleteScenario(
  db: Db,
  scenarioId: string,
  actor: AuditActor,
  input: DeleteResourceBody = {},
): Promise<DeleteResourceResult> {
  const { scenarios, runs } = schemaFor(db)
  try {
    return await db.transaction(async (tx) => {
      const [current] = await locked(tx, tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)))
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      if (current.deletedAt && current.deletedBy) {
        return toDeleteResult({
          id: scenarioId,
          deletedAt: current.deletedAt,
          deletedBy: current.deletedBy,
        })
      }
      const activeRuns = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.scenarioId, scenarioId),
            inArray(runs.status, ACTIVE_RUN_STATUSES as any),
            isNull(runs.deletedAt),
          ),
        )
        .limit(1)
      if (activeRuns.length > 0) {
        throw conflict('RUN_NOT_TERMINAL', '该场景存在运行中的任务，请先等待完成或取消')
      }
      const referenced = await suitesReferencingScenario(tx as unknown as Db, {
        targetId: current.targetId,
        scenarioId,
      })
      if (referenced.length > 0) {
        throw conflict('SCENARIO_IN_SUITE', suiteReferenceBlockers(referenced)[0]!.message)
      }
      await assertResourceIdle(tx as unknown as Db, { scenarioId })
      const [runCount] = await tx
        .select({ value: count() })
        .from(runs)
        .where(and(eq(runs.scenarioId, scenarioId), isNull(runs.deletedAt)))
      assertExpectedCounts({ runs: Number(runCount?.value ?? 0) }, input.expectedCounts)

      const now = new Date()
      const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
      await closeOpenBindings(tx as unknown as Db, { scenarioId }, now)
      await tx
        .update(scenarios)
        .set({ deletedAt: now, deletedBy, updatedAt: now })
        .where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        actor,
        'scenario.delete',
        'scenario',
        scenarioId,
        `删除场景 ${current.name}：保留历史运行 ${Number(runCount?.value ?? 0)} 条`,
      )
      return toDeleteResult({ id: scenarioId, deletedAt: now, deletedBy })
    })
  } catch (error) {
    rethrow(error)
  }
}

export async function countRunsForScenario(db: Db, scenarioId: string): Promise<number> {
  const { runs } = schemaFor(db)
  const [row] = await db.select({ n: count() }).from(runs).where(eq(runs.scenarioId, scenarioId))
  return Number(row?.n ?? 0)
}

export async function countScenariosForTarget(db: Db, targetId: string): Promise<number> {
  const { scenarios } = schemaFor(db)
  const [row] = await db
    .select({ n: count() })
    .from(scenarios)
    .where(eq(scenarios.targetId, targetId))
  return Number(row?.n ?? 0)
}

export async function loadScenarioVersion(
  db: Db,
  scenarioId: string,
  versionId?: string,
): Promise<{ scenario: ScenarioRow; version: ScenarioVersionRow }> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  if (versionId) {
    const [version] = await db
      .select()
      .from(scenarioVersions)
      .where(eq(scenarioVersions.id, versionId))
      .limit(1)
    if (!version || version.scenarioId !== scenarioId) {
      throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
    }
    return { scenario, version }
  }
  return { scenario, version: await latestPublishedVersion(db, scenarioId) }
}

function isZodError(error: unknown): error is { issues: { message: string }[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  )
}

/** 测试夹具仍可走仓库函数发布；HTTP 不再接收 steps。 */
export function validateDefinition(steps: Step[]): ScenarioDefinition {
  try {
    return validateScenarioDefinition(scenarioDefinitionFromSteps(steps))
  } catch (error) {
    if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
    if (isZodError(error)) {
      throw badRequest('BAD_REQUEST', error.issues[0]?.message ?? '场景定义不合法')
    }
    throw error
  }
}

export async function previewScenarioExpansion(
  db: Db,
  scenarioId: string,
  input?: { document?: unknown },
): Promise<{
  definition: ScenarioDefinition
  manifest?: ModuleManifest
  diagnostics: CompileDiagnostic[]
}> {
  const { scenarios, scenarioDrafts } = schemaFor(db)
  const [current] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  let rawDoc = input?.document
  if (!rawDoc) {
    const [draft] = await db
      .select()
      .from(scenarioDrafts)
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
      .limit(1)
    if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
    rawDoc = draft.document
  }
  const authoringDoc = normalizeAuthoringDocument(rawDoc)
  const result = await expandWithLoader(db, current.targetId, authoringDoc, 'preview', true)
  return {
    definition: result.definition!,
    manifest: result.manifest,
    diagnostics: result.diagnostics,
  }
}

export async function inlineScenarioModuleInvocation(
  db: Db,
  scenarioId: string,
  invocationId: string,
  input: { revision: number; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx
          .select()
          .from(scenarios)
          .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
          .limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const [draft] = await locked(
        tx,
        tx
          .select()
          .from(scenarioDrafts)
          .where(eq(scenarioDrafts.scenarioId, scenarioId))
          .limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.revision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const authoringDoc = normalizeAuthoringDocument(draft.document)
      const loc = locateNode(authoringDoc, invocationId)
      if (!loc) {
        throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      }
      const invocationItem = walkAuthoringNodes(authoringDoc).find((item) => item.id === invocationId)
      if (!invocationItem || invocationItem.node.kind !== 'module') {
        throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      }
      const invocationNode = invocationItem.node
      // 必须展开整篇文档：单独展开这一个调用会让调用序号回到 0，
      // 展开出来的步骤与绑定会和文档里其余调用对不上。
      const expanded = await expandWithLoader(
        tx as unknown as Db,
        current.targetId,
        authoringDoc,
        'preview',
        true,
      )
      if (!expanded.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '内联展开失败', {
          diagnostics: expanded.diagnostics,
        })
      }
      const entry = expanded.manifest.entries.find((item) => item.invocationId === invocationId)
      if (!entry) throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      const expandedById = new Map(expanded.definition!.steps.map((step) => [step.id, step]))

      // 内联后这些 outputKey 进入场景命名空间并长期存在，不能继续占用 `m{序号}_`：
      // 剩余调用会重新编号，迟早撞上同名键。改用调用自身派生的前缀。
      const exposedKeys = new Set(Object.values(invocationNode.outputBindings))
      const inlinePrefix = `i${invocationId.replace(/-/g, '').slice(0, 8)}_`
      const privateRenames = new Map<string, string>()
      for (const stepId of entry.expandedStepIds) {
        const key = expandedById.get(stepId)?.outputKey
        if (key && !exposedKeys.has(key)) {
          privateRenames.set(key, `${inlinePrefix}${key}`.slice(0, 128))
        }
      }

      const inlinedNodes: ScenarioAuthoringDocumentV2['nodes'] = entry.expandedStepIds.map((stepId) => {
        const step = structuredClone(expandedById.get(stepId)!)
        if (step.outputKey && privateRenames.has(step.outputKey)) {
          step.outputKey = privateRenames.get(step.outputKey)!
        }
        const stepInput = step.input as { from?: string }
        if (typeof stepInput.from === 'string' && privateRenames.has(stepInput.from)) {
          stepInput.from = privateRenames.get(stepInput.from)!
        }
        return {
          kind: 'step' as const,
          step,
          ...(invocationNode.moduleVersionId
            ? {
                origin: {
                  moduleVersionId: invocationNode.moduleVersionId,
                  invocationId,
                },
              }
            : {}),
        }
      })

      let updatedDoc = authoringDoc
      if (inlinedNodes.length > 0) {
        updatedDoc = replaceNode(updatedDoc, invocationId, inlinedNodes[0]!)
        let prevAnchor = authoringNodeId(inlinedNodes[0]!)
        for (let i = 1; i < inlinedNodes.length; i++) {
          updatedDoc = insertNodeAfter(updatedDoc, prevAnchor, inlinedNodes[i]!)
          prevAnchor = authoringNodeId(inlinedNodes[i]!)
        }
      } else {
        updatedDoc = removeNode(updatedDoc, invocationId)
      }
      const totalNodes = walkAuthoringNodes(updatedDoc).length
      if (totalNodes > 32) {
        throw badRequest(
          'SCENARIO_STEP_LIMIT_EXCEEDED',
          `内联展开后场景总步骤数达到 ${totalNodes}，超过 32 步上限`,
        )
      }

      const newDoc: ScenarioAuthoringDocumentV2 = updatedDoc

      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document: newDoc,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, newDoc)
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `内联展开模块调用节点 ${invocationId}`,
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return getScenario(db, scenarioId)
}

function verificationPlaceholder(name = '验证占位'): ScenarioDefinition {
  return {
    schemaVersion: 1,
    inputs: [],
    steps: [
      {
        id: newId(),
        name,
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 10 },
      },
    ],
  }
}

export async function getOrCreateModuleVerificationScenario(
  db: Db,
  input: {
    moduleId: string
    actor: AuditActor
  },
): Promise<{ scenarioId: string; targetId: string }> {
  const { actionModules, scenarios, scenarioDrafts, scenarioVersions, scenarioModuleRefs } = schemaFor(db)
  const [mod] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, input.moduleId), isNull(actionModules.deletedAt)))
    .limit(1)
  if (!mod) throw notFound('ACTION_MODULE_NOT_FOUND', '动作模块不存在')

  const [byRef] = await db
    .select({ id: scenarios.id, targetId: scenarios.targetId })
    .from(scenarioModuleRefs)
    .innerJoin(scenarios, eq(scenarios.id, scenarioModuleRefs.scenarioId))
    .where(
      and(
        eq(scenarioModuleRefs.moduleId, input.moduleId),
        eq(scenarios.purpose, 'module_verification'),
        isNull(scenarios.deletedAt),
      ),
    )
    .limit(1)
  if (byRef) return { scenarioId: byRef.id, targetId: byRef.targetId }

  const scenarioName = `[验证] ${mod.name} (${mod.key})`
  const [existing] = await db
    .select()
    .from(scenarios)
    .where(
      and(
        eq(scenarios.targetId, mod.targetId),
        eq(scenarios.purpose, 'module_verification'),
        eq(scenarios.name, scenarioName),
        isNull(scenarios.deletedAt),
      ),
    )
    .limit(1)

  if (existing) {
    return { scenarioId: existing.id, targetId: existing.targetId }
  }

  const now = new Date()
  const scenarioId = newId()
  const initialVersionId = newId()
  const placeholder = verificationPlaceholder()
  const draftContent = (mod.draftContent ?? null) as ModuleContent | null
  const initialDoc: ScenarioAuthoringDocumentV2 = draftContent
    ? {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: newId(),
            name: mod.name,
            moduleId: mod.id,
            moduleDraft: {
              moduleId: mod.id,
              revision: mod.draftRevision,
              contentDigest: computeContentDigest(draftContent),
            },
            implementationKey: 'default',
            inputBindings: {},
            outputBindings: {},
          },
        ],
      }
    : normalizeAuthoringDocument(placeholder)

  await db.transaction(async (tx) => {
    await tx.insert(scenarios).values({
      id: scenarioId,
      targetId: mod.targetId,
      name: scenarioName,
      status: 'active',
      purpose: 'module_verification',
      createdByConsoleAccountId: input.actor.id,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(scenarioVersions).values({
      id: initialVersionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      definition: placeholder,
      compilerVersion: COMPILER_VERSION,
      sourceDigest: sourceDocumentDigest(placeholder),
      createdByConsoleAccountId: input.actor.id,
      createdAt: now,
    })
    await tx.insert(scenarioDrafts).values({
      scenarioId,
      revision: 1,
      document: initialDoc,
      updatedByConsoleAccountId: input.actor.id,
      updatedAt: now,
    })
    await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, initialDoc)
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'scenario.create',
      'scenario',
      scenarioId,
      `创建模块验证场景：${scenarioName}`,
    )
  })

  return { scenarioId, targetId: mod.targetId }
}

export async function prepareModuleDraftTrial(
  db: Db,
  moduleId: string,
  input: {
    inputs?: Record<string, JsonValue>
    implementationKey?: string
    actor: AuditActor
  },
): Promise<{ scenarioId: string; revision: number }> {
  const { actionModules, scenarioDrafts, scenarios } = schemaFor(db)
  const [mod] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
    .limit(1)
  if (!mod) throw notFound('ACTION_MODULE_NOT_FOUND', '动作模块不存在')
  await assertTargetPermission(db, input.actor.id, mod.targetId, 'module:write')
  if (!mod.draftContent) {
    throw badRequest('MODULE_COMPILE_BLOCKED', '模块没有可试跑的草稿')
  }
  const content = mod.draftContent as ModuleContent
  const implementationKey = input.implementationKey ?? 'default'
  if (!content.implementations.some((item) => item.implementationKey === implementationKey)) {
    throw badRequest('MODULE_IMPLEMENTATION_UNKNOWN', `模块没有实现「${implementationKey}」`)
  }
  const contentDigest = computeContentDigest(content)
  const { scenarioId } = await getOrCreateModuleVerificationScenario(db, {
    moduleId,
    actor: input.actor,
  })

  const inputBindings: Record<string, { kind: 'literal'; value: JsonValue }> = {}
  for (const [key, value] of Object.entries(input.inputs ?? {})) {
    inputBindings[key] = { kind: 'literal', value }
  }

  const authoringDoc: ScenarioAuthoringDocumentV2 = {
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs: [],
    nodes: [
      {
        kind: 'module',
        invocationId: newId(),
        name: mod.name,
        moduleId: mod.id,
        moduleDraft: {
          moduleId: mod.id,
          revision: mod.draftRevision,
          contentDigest,
        },
        implementationKey: input.implementationKey ?? 'default',
        inputBindings,
        outputBindings: {},
      },
    ],
  }

  const now = new Date()
  let revision = 1
  await db.transaction(async (tx) => {
    const [draft] = await locked(
      tx,
      tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
    )
    if (!draft) throw notFound('SCENARIO_NOT_FOUND', '模块验证草稿不存在')
    revision = draft.revision + 1
    await tx
      .update(scenarioDrafts)
      .set({
        revision,
        document: authoringDoc,
        updatedByConsoleAccountId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(scenarioDrafts.scenarioId, scenarioId))
    await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
    await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, authoringDoc)
    await recordAudit(
      tx as unknown as Db,
      input.actor,
      'scenario.update',
      'scenario',
      scenarioId,
      `写入模块试跑草稿 r${revision}`,
    )
  })
  return { scenarioId, revision }
}
