import type { ScenarioRow, ScenarioVersionRow } from '../records.js'
import { atomic, locked, schemaFor } from '../native.js'
import { and, asc, count, desc, eq } from 'drizzle-orm'
import {
  COMPILER_VERSION,
  ScenarioValidationError,
  assertRunFromResolved,
  compileScenarioDocument,
  parseScenarioDocument,
  scenarioDefinitionFromSteps,
  scenarioDetailSchema,
  scenarioDocumentSchema,
  scenarioListResponseSchema,
  scenarioSchema,
  scenarioVersionListResponseSchema,
  scenarioVersionSchema,
  validateScenarioDefinition,
  type CompileResult,
  type ScenarioDefinition,
  type ScenarioDetailDto,
  type ScenarioDocument,
  type ScenarioDto,
  type ScenarioInputDecl,
  type ScenarioListResponse,
  type ScenarioStatus,
  type ScenarioVersionDto,
  type ScenarioVersionListResponse,
  type Step,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { sha256Hex } from './digest.js'
import { badRequest, conflict, mapRestriction, notFound } from './errors.js'

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
  if (!target) return { exists: false as const, status: 'disabled' as const, row: null }
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
    createdAt: iso(version.createdAt),
  })
}

async function toDetailDto(
  db: Db,
  row: ScenarioRow,
  latest: ScenarioVersionRow,
  options?: ScenarioCompileOptions,
): Promise<ScenarioDetailDto> {
  const draft = await loadDraft(db, row.id)
  const target = await loadTargetContext(db, row.targetId)
  const document = draft
    ? parseDocument(draft.document)
    : scenarioDocumentSchema.parse(latest.definition)
  const compiled = compileDocument(document, target, 'release', options)
  const dirty = draft ? isDraftDirty(draft.document, latest.definition) : false
  return scenarioDetailSchema.parse({
    ...toScenarioDto(row, latest, dirty),
    steps: latest.definition.steps,
    published: {
      versionId: latest.id,
      versionNo: publishedVersionNo(latest),
      definition: latest.definition,
      compilerVersion: latest.compilerVersion,
      createdAt: iso(latest.createdAt),
    },
    draft: draft
      ? {
          revision: draft.revision,
          document,
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
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!row) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const latest = await latestPublishedVersion(db, scenarioId)
  return toDetailDto(db, row, latest, options)
}

export async function listScenarios(db: Db): Promise<ScenarioListResponse> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const rows = await db
    .select()
    .from(scenarios)
    .orderBy(asc(scenarios.createdAt), asc(scenarios.id))
  const drafts = await db.select().from(scenarioDrafts)
  const draftById = new Map(drafts.map((draft) => [draft.scenarioId, draft]))
  const items: ScenarioDto[] = []
  for (const row of rows) {
    const latest = await latestPublishedVersion(db, row.id)
    const draft = draftById.get(row.id)
    items.push(
      toScenarioDto(row, latest, draft ? isDraftDirty(draft.document, latest.definition) : false),
    )
  }
  return scenarioListResponseSchema.parse({ items })
}

export async function listScenarioVersions(
  db: Db,
  scenarioId: string,
): Promise<ScenarioVersionListResponse> {
  const { scenarioVersions, scenarios } = schemaFor(db)
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
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
  const [current] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
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
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1),
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
  input: { revision: number; document: ScenarioDocument; actor: AuditActor },
): Promise<ScenarioDetailDto> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const document = parseDocument(input.document)
  const now = new Date()
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1),
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
      compileDocument(document, target, 'save')
      await tx
        .update(scenarioDrafts)
        .set({
          revision: draft.revision + 1,
          document,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
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
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1),
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
      const document = parseDocument(draft.document)
      const compiled = throwIfBlocked(compileDocument(document, target, 'release', input))
      const latest = await latestPublishedVersion(tx as unknown as Db, scenarioId)
      if (sourceDocumentDigest(compiled.definition) === sourceDocumentDigest(latest.definition)) {
        return
      }
      const versionNo = publishedVersionNo(latest) + 1
      await tx.insert(scenarioVersions).values({
        id: newId(),
        scenarioId,
        versionNo,
        kind: 'published',
        definition: compiled.definition,
        compilerVersion: COMPILER_VERSION,
        sourceDigest: sourceDocumentDigest(compiled.definition),
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
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1),
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
      const document = parseDocument(draft.document)
      const compiled = throwIfBlocked(compileDocument(document, target, 'release', input))
      try {
        assertRunFromResolved(compiled.definition.steps, input.runInput)
      } catch (error) {
        if (error instanceof ScenarioValidationError) throw badRequest(error.code, error.message)
        throw error
      }
      const digest = sourceDocumentDigest(compiled.definition)
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
      if (existing) {
        versionId = existing.id
        return
      }
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
          createdByConsoleAccountId: input.actor.id,
          createdAt: now,
        })
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
        if (again) {
          versionId = again.id
          return
        }
        throw error
      }
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'scenario.update',
        'scenario',
        scenarioId,
        '创建试跑版本',
      )
    })
  } catch (error) {
    rethrow(error)
  }
  return { versionId }
}

export async function deleteScenario(db: Db, scenarioId: string, actor: AuditActor): Promise<void> {
  const { scenarioDrafts, scenarioVersions, scenarios, runs } = schemaFor(db)
  try {
    await db.transaction(async (tx) => {
      const [current] = await locked(
        tx,
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)),
      )
      if (!current) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.scenarioId, scenarioId))
        .limit(1)
      if (run) throw conflict('SCENARIO_HAS_RUNS', '请先删除该场景下的运行')
      await tx.delete(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.delete(scenarioVersions).where(eq(scenarioVersions.scenarioId, scenarioId))
      await tx.delete(scenarios).where(eq(scenarios.id, scenarioId))
      await recordAudit(
        tx as unknown as Db,
        actor,
        'scenario.delete',
        'scenario',
        scenarioId,
        current.name,
      )
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
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
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
