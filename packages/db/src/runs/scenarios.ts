import type { ScenarioRow, ScenarioVersionRow } from '../records.js'
import { atomic, locked, schemaFor } from '../native.js'
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm'
import {
  ACTIVE_RUN_STATUSES,
  COMPILER_VERSION,
  ScenarioValidationError,
  assertRunFromResolved,
  compileScenarioDocument,
  deletePreviewResponseSchema,
  expandAuthoringDocument,
  isAuthoringDocumentV2,
  authoringHasModuleInvocations,
  authoringNodeId,
  normalizeAuthoringDocument,
  parseScenarioDocument,
  scenarioAuthoringDocumentV2Schema,
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
  type ScenarioListQuery,
  type ScenarioListResponse,
  type ScenarioStatus,
  type ScenarioVersionDto,
  type ScenarioVersionListResponse,
  type Step,
  type ExpansionResult,
  type LoadedModuleVersion,
  type ModuleContent,
  type CompileContext,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { freezeMapDraftBindingsTx, reconcileMapDraftBindingsTx } from '../map/references.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { sha256Hex } from './digest.js'
import {
  computeContentDigest,
  computeContractDigest,
  computeImplementationDigest,
} from '../action-modules/digest.js'
import { badRequest, conflict, isUniqueViolation, mapRestriction, notFound } from './errors.js'
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

function isDraftDirty(draftDocument: unknown, publishedDefinition: unknown): boolean {
  try {
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
}

function compileDocument(
  document: ScenarioDocument,
  target: { exists: boolean; status: 'active' | 'disabled' },
  mode: 'save' | 'release',
  options?: ScenarioCompileOptions,
): CompileResult {
  return compileScenarioDocument(document, {
    mode,
    target,
    executableTypes: mode === 'save' ? undefined : options?.executableTypes,
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
        steps: input.nodes.filter((node) => node.kind === 'step').map((node) => node.step),
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
  for (const node of doc.nodes) {
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
  return expandAuthoringDocument(doc, {
    targetId,
    mode,
    loadedModules,
    compilerCtx,
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
  const invocations = document.nodes.filter(
    (node): node is Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'module' }> =>
      node.kind === 'module',
  )
  if (invocations.length === 0) return

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
  const hasModuleInvocations = authoringDoc.nodes.some((s) => s.kind === 'module')
  if (hasModuleInvocations) {
    const expansion = await expandWithLoader(db, row.targetId, authoringDoc, 'preview', true)
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
      steps: authoringDoc.nodes
        .filter((s): s is Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'step' }> => s.kind === 'step')
        .map((s) => s.step),
    }
    compiled = compileDocument(legacyDoc, target, 'release', options)
  }
  const dirty = draft ? isDraftDirty(draft.document, latest.definition) : false
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
): Promise<ScenarioListResponse> {
  const parsed = scenarioListQuerySchema.parse(query)
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const limit = parsed.limit
  const filters: (SQL | undefined)[] = [
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

  const scenarioIds = rows.map((r) => r.id)
  const drafts =
    scenarioIds.length > 0
      ? await db
          .select()
          .from(scenarioDrafts)
          .where(inArray(scenarioDrafts.scenarioId, scenarioIds))
      : []
  const draftById = new Map(drafts.map((draft) => [draft.scenarioId, draft]))

  const paginated = paginateResults(rows, limit)
  const items: ScenarioDto[] = []
  for (const row of paginated.items) {
    const latest = await latestPublishedVersion(db, row.id)
    const draft = draftById.get(row.id)
    items.push(
      toScenarioDto(row, latest, draft ? isDraftDirty(draft.document, latest.definition) : false),
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
    status?: ScenarioStatus
    actor: AuditActor
    compileMode?: 'save' | 'release'
    executableTypes?: readonly string[]
  },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? []))
  const target = await loadTargetContext(db, input.targetId)
  if (!target.exists) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled')
    throw conflict('TARGET_DISABLED', '目标系统已停用，不能新建场景')
  const compiled = compileDocument(document, target, input.compileMode ?? 'release', input)
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
  input: { steps: Step[]; inputs?: ScenarioInputDecl[]; actor: AuditActor; executableTypes?: readonly string[] },
): Promise<ScenarioDetailDto> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const document = parseDocument(scenarioDefinitionFromSteps(input.steps, input.inputs ?? []))
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt))).limit(1),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const target = await loadTargetContext(tx as unknown as Db, current.targetId)
      throwIfBlocked(compileDocument(document, target, 'release', input))
      const latest = await latestPublishedVersion(tx as unknown as Db, scenarioId)
      const versionNo = publishedVersionNo(latest) + 1
      await tx.insert(scenarioVersions).values({
        id: newId(),
        scenarioId,
        versionNo,
        kind: 'published',
        definition: document,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: sourceDocumentDigest(document),
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })
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
      const hasModuleInvocations = authoringHasModuleInvocations(document)
      const isV2 = isAuthoringDocumentV2(input.document) || isV2Document(input.document)
      let savedDoc: unknown
      if (isV2 || hasModuleInvocations) {
        savedDoc = document
      } else {
        const legacyDoc: ScenarioDocument = {
          schemaVersion: 1,
          inputs: document.inputs,
          steps: document.nodes
            .filter((s): s is Extract<ScenarioAuthoringDocumentV2['nodes'][number], { kind: 'step' }> => s.kind === 'step')
            .map((s) => s.step),
        }
        compileDocument(legacyDoc, target, 'save')
        savedDoc = legacyDoc
      }
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
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, null, document)
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
      const compiled = throwIfBlocked(compileDocument(expandResult.definition!, target, 'release', input))
      const latest = await latestPublishedVersion(tx as unknown as Db, scenarioId)
      if (sourceDocumentDigest(compiled.definition) === sourceDocumentDigest(latest.definition)) {
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
      await freezeMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        scenarioVersionId: versionId,
      })
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
  },
): Promise<{ versionId: string }> {
  const { scenarioDrafts, scenarioVersions, scenarios } = schemaFor(db)
  const now = new Date()
  let versionId = ''
  try {
    await atomic(db, async (tx) => {
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
      const authoringDoc = normalizeAuthoringDocument(draft.document)
      const expandResult = await expandWithLoader(tx as unknown as Db, current.targetId, authoringDoc, 'trial', true)
      if (!expandResult.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '试跑编译未通过', {
          diagnostics: expandResult.diagnostics,
        })
      }
      const compiled = throwIfBlocked(compileDocument(expandResult.definition!, target, 'release', input))
      try {
        assertRunFromResolved(compiled.definition.steps, input.runInput)
      } catch (error) {
        if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
        throw error
      }
      const digest =
        expandResult.manifest.entries.length > 0
          ? expandResult.sourceDigest
          : sourceDocumentDigest(compiled.definition)
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
      await syncScenarioModuleRefsTx(tx as unknown as Db, scenarioId, versionId, authoringDoc)
      await freezeMapDraftBindingsTx(tx as unknown as Db, {
        scenarioId,
        targetId: current.targetId,
        scenarioVersionId: versionId,
      })
      if (created) {
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
  const activeBlockers = activeRunBlockers(activeRuns)

  return deletePreviewResponseSchema.parse({
    previewToken: newId(),
    counts: {
      runs: scenarioRuns.length,
    },
    blockers: activeBlockers,
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
      const nodeIndex = authoringDoc.nodes.findIndex(
        (node) => node.kind === 'module' && node.invocationId === invocationId,
      )
      if (nodeIndex === -1) {
        throw notFound('NODE_NOT_FOUND', '指定的动作模块调用节点不存在')
      }
      const invocationNode = authoringDoc.nodes[nodeIndex] as Extract<
        ScenarioAuthoringDocumentV2['nodes'][number],
        { kind: 'module' }
      >
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

      const newNodes = [
        ...authoringDoc.nodes.slice(0, nodeIndex),
        ...inlinedNodes,
        ...authoringDoc.nodes.slice(nodeIndex + 1),
      ]
      if (newNodes.length > 32) {
        throw badRequest(
          'SCENARIO_STEP_LIMIT_EXCEEDED',
          `内联展开后场景总步骤数达到 ${newNodes.length}，超过 32 步上限`,
        )
      }

      const newDoc: ScenarioAuthoringDocumentV2 = {
        ...authoringDoc,
        nodes: newNodes,
      }

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
