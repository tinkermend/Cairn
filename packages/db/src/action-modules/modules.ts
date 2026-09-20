import { compileModuleContent } from '@cairn/authoring'
import {
  actionModuleDetailSchema,
  actionModuleSummarySchema,
  actionModuleVersionDtoSchema,
  createModuleBodySchema,
  updateModuleMetaBodySchema,
  publishModuleBodySchema,
  moduleWarningKey,
  executableStepTypesFor,
  FACTORY_PLATFORM_CONFIG,
  MODULE_COMPILER_VERSION,
  moduleContentSchema,
  moduleListQuerySchema,
  moduleListResponseSchema,
  moduleVersionListResponseSchema,
  type ActionModuleDetail,
  type ActionModuleSummary,
  type ActionModuleVersionDto,
  type ExecutionActor,
  type ModuleCompileResult,
  type ModuleContent,
  type ModuleListQuery,
  type ModuleListResponse,
  type ModuleVersionListResponse,
} from '@cairn/shared'
import { and, count, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { newId } from '../id.js'
import { atomic, driverOf, locked, schemaFor } from '../native.js'
import type { ActionModuleRow, ActionModuleVersionRow } from '../records.js'
import { badRequest, conflict, isUniqueViolation, mapRestriction, notFound } from '../runs/errors.js'
import {
  sha256Hex,
  computeContentDigest,
  computeContractDigest,
  computeImplementationDigest,
  computeSingleImplementationDigest,
} from './digest.js'

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function rethrow(error: unknown): never {
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

async function loadTargetContext(db: Db, targetId: string) {
  const { targets } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target || target.deletedAt) return { exists: false as const, status: 'disabled' as const, row: null }
  return { exists: true as const, status: target.status, row: target }
}

async function latestPublishedVersion(db: Db, moduleId: string): Promise<ActionModuleVersionRow | null> {
  const { actionModuleVersions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(actionModuleVersions)
    .where(eq(actionModuleVersions.moduleId, moduleId))
    .orderBy(desc(actionModuleVersions.versionNo))
    .limit(1)
  return row ?? null
}

function toSummaryDto(
  module: ActionModuleRow,
  latestVersion: Pick<ActionModuleVersionRow, 'executionMode' | 'effectCeiling' | 'versionNo' | 'createdAt' | 'publicationStatus'> | null,
): ActionModuleSummary {
  return actionModuleSummarySchema.parse({
    id: module.id,
    targetId: module.targetId,
    key: module.key,
    name: module.name,
    description: module.description,
    capabilityKey: module.capabilityKey,
    executionMode: latestVersion?.executionMode ?? null,
    effectCeiling: latestVersion?.effectCeiling ?? null,
    latestVersionNo: latestVersion?.versionNo ?? null,
    latestVersionPublishedAt: latestVersion ? iso(latestVersion.createdAt) : null,
    publicationStatus: latestVersion?.publicationStatus ?? null,
    tags: Array.isArray(module.tags) ? module.tags : [],
    createdAt: iso(module.createdAt),
    updatedAt: iso(module.updatedAt),
  })
}

function toVersionDto(row: ActionModuleVersionRow): ActionModuleVersionDto {
  return actionModuleVersionDtoSchema.parse({
    id: row.id,
    moduleId: row.moduleId,
    versionNo: row.versionNo,
    content: row.content,
    contractDigest: row.contractDigest,
    implementationDigest: row.implementationDigest,
    contentDigest: row.contentDigest,
    compilerVersion: row.compilerVersion,
    executionMode: row.executionMode,
    effectCeiling: row.effectCeiling,
    publicationStatus: row.publicationStatus,
    sourceDraftRevision: row.sourceDraftRevision,
    createdBy: row.createdByConsoleAccountId,
    createdAt: iso(row.createdAt),
  })
}

function toDetailDto(
  module: ActionModuleRow,
  latestVersion: ActionModuleVersionRow | null,
  executableTypes: readonly string[],
): ActionModuleDetail {
  const summary = toSummaryDto(module, latestVersion)
  let compileResult: ModuleCompileResult | undefined
  if (module.draftContent) {
    try {
      const parsedContent = moduleContentSchema.parse(module.draftContent)
      compileResult = compileModuleContent(parsedContent, { mode: 'save', executableTypes })
    } catch {
      // 保持 compileResult 为 undefined
    }
  }

  return actionModuleDetailSchema.parse({
    ...summary,
    aliases: Array.isArray(module.aliases) ? module.aliases : [],
    intentExamples: Array.isArray(module.intentExamples) ? module.intentExamples : [],
    draftRevision: module.draftRevision,
    draftContent: module.draftContent ?? null,
    compile: compileResult
      ? {
          ok: compileResult.ok,
          diagnostics: compileResult.diagnostics,
        }
      : undefined,
  })
}

// ---------------------------------------------------------------------------
// 1. listActionModules
// ---------------------------------------------------------------------------

export async function listActionModules(db: Db, query: ModuleListQuery, actorId?: string): Promise<ModuleListResponse> {
  const { actionModules: modules, actionModuleVersions: versions, targets } = schemaFor(db)
  const q = moduleListQuerySchema.parse(query)
  const driver = driverOf(db)
  const escapeLike = (value: string) => value.replace(/[!%_]/g, (char) => `!${char}`)
  const pattern = `%${escapeLike(q.q?.toLowerCase() ?? '')}%`
  const conditions: SQL[] = [isNull(modules.deletedAt), isNull(targets.deletedAt)]
  const scope = await scopedTargetFilter(db, actorId, modules.targetId, 'module:read')
  if (scope) conditions.push(scope)
  if (q.targetId) conditions.push(eq(modules.targetId, q.targetId))
  if (q.capabilityKey) conditions.push(eq(modules.capabilityKey, q.capabilityKey))
  if (q.q) {
    const aliases = driver === 'postgres'
      ? sql`exists (select 1 from jsonb_array_elements_text(${modules.aliases}) as a(value) where lower(a.value) like ${pattern} escape '!')`
      : driver === 'mysql'
        ? sql`exists (select 1 from json_table(${modules.aliases}, '$[*]' columns(value varchar(128) path '$')) as a where lower(a.value) like ${pattern} escape '!')`
        : sql`exists (select 1 from json_each(${modules.aliases}) as a where lower(a.value) like ${pattern} escape '!')`
    conditions.push(or(sql`lower(${modules.name}) like ${pattern} escape '!'`, sql`lower(${modules.key}) like ${pattern} escape '!'`, aliases)!)
  }
  if (q.tag) conditions.push(driver === 'postgres'
    ? sql`${modules.tags} @> ${JSON.stringify([q.tag])}::jsonb`
    : driver === 'mysql'
      ? sql`json_contains(${modules.tags}, ${JSON.stringify(q.tag)})`
      : sql`exists (select 1 from json_each(${modules.tags}) as t where t.value = ${q.tag})`)
  const heads = db.select({ moduleId: versions.moduleId, versionNo: sql<number>`max(${versions.versionNo})`.as('latest_module_version_no') })
    .from(versions).groupBy(versions.moduleId).as('module_heads')
  if (q.executionMode) conditions.push(eq(versions.executionMode, q.executionMode))
  if (q.publication) conditions.push(eq(versions.publicationStatus, q.publication))
  const join = (selection: any) => db.select(selection).from(modules)
    .innerJoin(targets, eq(targets.id, modules.targetId))
    .leftJoin(heads, eq(heads.moduleId, modules.id))
    .leftJoin(versions, and(eq(versions.moduleId, modules.id), eq(versions.versionNo, heads.versionNo)))
    .where(and(...conditions))
  const [totalRow] = await join({ total: count() })
  // 列表只读摘要列；分页不装载所有草稿及所有历史版本内容。
  const rows = await join({
    id: modules.id, targetId: modules.targetId, key: modules.key, name: modules.name,
    description: modules.description, capabilityKey: modules.capabilityKey, tags: modules.tags,
    createdAt: modules.createdAt, updatedAt: modules.updatedAt,
    executionMode: versions.executionMode, effectCeiling: versions.effectCeiling,
    latestVersionNo: versions.versionNo, latestVersionPublishedAt: versions.createdAt,
    publicationStatus: versions.publicationStatus,
  }).orderBy(desc(modules.createdAt), desc(modules.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize)
  return moduleListResponseSchema.parse({
    items: rows.map((row: any) => ({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), latestVersionPublishedAt: iso(row.latestVersionPublishedAt) })),
    total: Number((totalRow as unknown as { total: number })?.total ?? 0), page: q.page, pageSize: q.pageSize,
  })
}

async function runtimeTypes(db: Db) {
  return executableStepTypesFor(((await getPlatformConfig(db))?.document ?? FACTORY_PLATFORM_CONFIG).browserAi.enabled)
}

/** 与 Target 删除保持同一锁顺序：账号授权 → Target → Module。 */
async function writableModule(db: Db, moduleId: string, actorId: string, permission = 'module:write') {
  await lockConsoleAuthorization(db, actorId)
  const { actionModules, targets } = schemaFor(db)
  const [candidate] = await db.select({ targetId: actionModules.targetId }).from(actionModules).where(eq(actionModules.id, moduleId))
  if (!candidate) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  const [target] = await locked(db, db.select().from(targets).where(eq(targets.id, candidate.targetId)))
  if (!target || target.deletedAt) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  const [module] = await locked(db, db.select().from(actionModules).where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt))))
  if (!module) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  await assertTargetPermission(db, actorId, module.targetId, permission)
  return module
}

async function withReceipt(db: Db, actor: ExecutionActor, key: string, request: unknown, apply: (tx: Db) => Promise<ActionModuleDetail>) {
  const { consoleAccounts, actionModuleReceipts } = schemaFor(db)
  return atomic(db, async (tx) => {
    const connection = tx as unknown as Db
    // 同一控制台身份的回执提交串行化，避免并发相同请求双写。
    await locked(tx, tx.select({ id: consoleAccounts.id }).from(consoleAccounts).where(eq(consoleAccounts.id, actor.id)))
    const digest = sha256Hex(request)
    const [existing] = await tx.select().from(actionModuleReceipts).where(and(eq(actionModuleReceipts.actorId, actor.id), eq(actionModuleReceipts.idempotencyKey, key)))
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('MODULE_IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      await getActionModule(connection, existing.moduleId)
      return actionModuleDetailSchema.parse(existing.response)
    }
    const response = await apply(connection)
    await tx.insert(actionModuleReceipts).values({ id: newId(), actorId: actor.id, idempotencyKey: key, requestDigest: digest, moduleId: response.id, response, createdAt: new Date() })
    return response
  })
}

// ---------------------------------------------------------------------------
// 2. getActionModule
// ---------------------------------------------------------------------------

export async function getActionModule(db: Db, moduleId: string, actorId?: string): Promise<ActionModuleDetail> {
  const { actionModules } = schemaFor(db)
  const [module] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
    .limit(1)

  if (!module) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  const latest = await latestPublishedVersion(db, moduleId)
  if (!(await loadTargetContext(db, module.targetId)).exists) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')
  if (actorId) await assertTargetPermission(db, actorId, module.targetId, 'module:read')
  return toDetailDto(module, latest, await runtimeTypes(db))
}

// ---------------------------------------------------------------------------
// 3. createActionModule
// ---------------------------------------------------------------------------

export async function createActionModule(
  db: Db,
  input: {
    idempotencyKey: string
    targetId: string
    key: string
    name: string
    description?: string | null
    capabilityKey?: string | null
    actor: ExecutionActor
  },
): Promise<ActionModuleDetail> {
  const { actor, ...body } = input
  const parsed = createModuleBodySchema.parse({ ...body, description: body.description ?? undefined, capabilityKey: body.capabilityKey ?? undefined })
  const { actionModules, targets } = schemaFor(db)
  try {
    return await withReceipt(db, actor, parsed.idempotencyKey, { operation: 'create', ...parsed }, async (tx) => {
      const [target] = await locked(tx, tx.select().from(targets).where(eq(targets.id, parsed.targetId)))
      if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能新建动作模块')
      await assertTargetPermission(tx, actor.id, parsed.targetId, 'module:write')
      const { idempotencyKey: _, ...metadata } = parsed
      const id = newId()
      const now = new Date()
      await tx.insert(actionModules).values({ ...metadata, id, tags: [], aliases: [], intentExamples: [], draftRevision: 0, draftContent: null,
        createdByConsoleAccountId: actor.id, updatedByConsoleAccountId: actor.id, createdAt: now, updatedAt: now })
      await recordAudit(tx, actor, 'module.create', 'module', id, '创建动作模块')
      return getActionModule(tx, id)
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('MODULE_KEY_DUPLICATE', '该目标系统下模块 key 已存在')
    rethrow(error)
  }
}

// ---------------------------------------------------------------------------
// 4. updateActionModuleMeta
// ---------------------------------------------------------------------------

export async function updateActionModuleMeta(
  db: Db,
  moduleId: string,
  input: {
    baseRevision: number
    name?: string
    description?: string | null
    capabilityKey?: string | null
    tags?: string[]
    aliases?: string[]
    intentExamples?: string[]
    actor: ExecutionActor
  },
): Promise<ActionModuleDetail> {
  const { actionModules } = schemaFor(db)
  const { actor: _actor, ...body } = input
  updateModuleMetaBodySchema.parse(body)
  const now = new Date()

  try {
    return await atomic(db, async (tx) => {
      const current = await writableModule(tx as unknown as Db, moduleId, input.actor.id)

      if (current.draftRevision !== input.baseRevision) throw conflict('MODULE_DRAFT_CONFLICT', '草稿已被他人更新', { currentRevision: current.draftRevision })
      const patch: Record<string, unknown> = { updatedAt: now, draftRevision: current.draftRevision + 1 }
      if (input.name !== undefined) patch.name = input.name
      if (input.description !== undefined) patch.description = input.description
      if (input.capabilityKey !== undefined) patch.capabilityKey = input.capabilityKey
      if (input.tags !== undefined) patch.tags = input.tags
      if (input.aliases !== undefined) patch.aliases = input.aliases
      if (input.intentExamples !== undefined) patch.intentExamples = input.intentExamples
      patch.updatedByConsoleAccountId = input.actor.id

      await tx.update(actionModules).set(patch).where(eq(actionModules.id, moduleId))

      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'module.update',
        'module',
        moduleId,
        '更新动作模块元数据',
      )
      return getActionModule(tx as unknown as Db, moduleId)
    })
  } catch (error) {
    rethrow(error)
  }

}

// ---------------------------------------------------------------------------
// 5. saveActionModuleDraft
// ---------------------------------------------------------------------------

export async function saveActionModuleDraft(
  db: Db,
  moduleId: string,
  input: {
    baseRevision: number
    content: ModuleContent
    actor: ExecutionActor
  },
): Promise<ActionModuleDetail> {
  const { actionModules } = schemaFor(db)
  const now = new Date()
  const validatedContent = moduleContentSchema.parse(input.content)

  try {
    return await atomic(db, async (tx) => {
      const current = await writableModule(tx as unknown as Db, moduleId, input.actor.id)

      if (current.draftRevision !== input.baseRevision) {
        throw conflict('MODULE_DRAFT_CONFLICT', '草稿已被他人更新', {
          currentRevision: current.draftRevision,
        })
      }

      await tx
        .update(actionModules)
        .set({
          draftRevision: current.draftRevision + 1,
          draftContent: validatedContent,
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(actionModules.id, moduleId))

      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'module.update',
        'module',
        moduleId,
        `保存草稿 r${current.draftRevision + 1}`,
      )
      return getActionModule(tx as unknown as Db, moduleId)
    })
  } catch (error) {
    rethrow(error)
  }

}

// ---------------------------------------------------------------------------
// 6. publishActionModule
// ---------------------------------------------------------------------------

export async function publishActionModule(
  db: Db,
  moduleId: string,
  input: {
    idempotencyKey: string
    expectedRevision: number
    confirmedWarnings?: string[]
    actor: ExecutionActor
  },
): Promise<ActionModuleDetail> {
  const { actionModules, actionModuleVersions } = schemaFor(db)
  const { actor, ...body } = input
  const request = publishModuleBodySchema.parse(body)
  const now = new Date()

  try {
    return await withReceipt(db, actor, request.idempotencyKey, { operation: 'publish', moduleId, ...request }, async (tx) => {
      const current = await writableModule(tx as unknown as Db, moduleId, actor.id, 'module:publish')

      if (current.draftRevision !== input.expectedRevision) {
        throw conflict('MODULE_DRAFT_CONFLICT', '草稿已被他人更新，请刷新重试', {
          currentRevision: current.draftRevision,
        })
      }

      if (!current.draftContent) {
        throw badRequest('MODULE_IMPLEMENTATION_EMPTY', '草稿为空，不能发布')
      }

      const content = moduleContentSchema.parse(current.draftContent)

      // 编译校验（release 模式）
      const compileResult = compileModuleContent(content, { mode: 'release', executableTypes: await runtimeTypes(tx as unknown as Db) })
      if (!compileResult.ok) {
        throw badRequest('MODULE_COMPILE_BLOCKED', '模块发布编译未通过', {
          diagnostics: compileResult.diagnostics,
        })
      }

      // 核对确认过的警告集合
      const warnings = compileResult.diagnostics
        .filter((d) => d.severity === 'warning')
        .map(moduleWarningKey)
      const confirmed = new Set(input.confirmedWarnings ?? [])
      const unconfirmedWarnings = warnings.filter((w) => !confirmed.has(w))
      if (unconfirmedWarnings.length > 0 || [...confirmed].some((key) => !warnings.includes(key))) {
        throw badRequest('MODULE_WARNINGS_NOT_CONFIRMED', '确认的警告集合与当前编译结果不一致', {
          unconfirmedWarnings,
        })
      }

      await assertImplementationsVerified(tx as unknown as Db, moduleId, content)

      // 计算摘要
      const contractDigest = computeContractDigest(content.contract)
      const implementationDigest = computeImplementationDigest(content.implementations)
      const contentDigest = computeContentDigest(content)

      // 检查幂等性：如果内容摘要等于最新发布版本的摘要，直接返回
      const latest = await latestPublishedVersion(tx as unknown as Db, moduleId)
      if (latest && latest.contentDigest === contentDigest) {
        return getActionModule(tx as unknown as Db, moduleId)
      }

      const nextVersionNo = latest ? latest.versionNo + 1 : 1
      const versionId = newId()

      await tx.insert(actionModuleVersions).values({
        id: versionId,
        moduleId,
        versionNo: nextVersionNo,
        content,
        contractDigest,
        implementationDigest,
        contentDigest,
        compilerVersion: MODULE_COMPILER_VERSION,
        executionMode: compileResult.executionMode,
        effectCeiling: content.contract.effectCeiling,
        publicationStatus: 'published',
        sourceDraftRevision: current.draftRevision,
        createdByConsoleAccountId: input.actor.id,
        createdAt: now,
      })

      await tx
        .update(actionModules)
        .set({
          updatedByConsoleAccountId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(actionModules.id, moduleId))

      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'module.publish',
        'module',
        moduleId,
        `发布版本 v${nextVersionNo}`,
      )
      return getActionModule(tx as unknown as Db, moduleId)
    })
  } catch (error) {
    rethrow(error)
  }

}

// ---------------------------------------------------------------------------
// 7. listActionModuleVersions
// ---------------------------------------------------------------------------

export async function listActionModuleVersions(
  db: Db,
  moduleId: string,
): Promise<ModuleVersionListResponse> {
  await getActionModule(db, moduleId)
  const { actionModuleVersions, actionModules } = schemaFor(db)
  const [module] = await db
    .select()
    .from(actionModules)
    .where(and(eq(actionModules.id, moduleId), isNull(actionModules.deletedAt)))
    .limit(1)

  if (!module) throw notFound('MODULE_NOT_FOUND', '动作模块不存在')

  const versions = await db
    .select()
    .from(actionModuleVersions)
    .where(eq(actionModuleVersions.moduleId, moduleId))
    .orderBy(desc(actionModuleVersions.versionNo))

  return moduleVersionListResponseSchema.parse({
    items: versions.map(toVersionDto),
  })
}

// ---------------------------------------------------------------------------
// 8. getActionModuleVersion
// ---------------------------------------------------------------------------

export async function getActionModuleVersion(
  db: Db,
  moduleId: string,
  versionId: string,
): Promise<ActionModuleVersionDto> {
  await getActionModule(db, moduleId)
  const { actionModuleVersions } = schemaFor(db)
  const [version] = await db
    .select()
    .from(actionModuleVersions)
    .where(
      and(
        eq(actionModuleVersions.id, versionId),
        eq(actionModuleVersions.moduleId, moduleId),
      ),
    )
    .limit(1)

  if (!version) throw notFound('MODULE_VERSION_NOT_FOUND', '动作模块版本不存在')
  return toVersionDto(version)
}

async function assertImplementationsVerified(db: Db, moduleId: string, content: ModuleContent): Promise<void> {
  if (content.implementations.length < 2) return
  const { moduleInvocationResults, runs } = schemaFor(db)
  const rows = await db
    .select({
      outcome: moduleInvocationResults.outcome,
      runKind: moduleInvocationResults.runKind,
      snapshot: runs.snapshot,
    })
    .from(moduleInvocationResults)
    .innerJoin(runs, eq(runs.id, moduleInvocationResults.runId))
    .where(
      and(
        eq(moduleInvocationResults.moduleId, moduleId),
        eq(moduleInvocationResults.runKind, 'module_verification'),
        eq(moduleInvocationResults.outcome, 'VERIFIED'),
        isNull(runs.deletedAt),
      ),
    )
  for (const impl of content.implementations) {
    const digest = computeSingleImplementationDigest(impl)
    const matched = rows.some((row) => {
      const entry = row.snapshot?.moduleManifest?.entries?.[0]
      if (!entry || entry.implementationKey !== impl.implementationKey) return false
      return entry.selectedImplementationDigest === digest || entry.implementationDigest === digest
    })
    if (!matched) {
      throw badRequest(
        'MODULE_IMPLEMENTATION_UNVERIFIED',
        `实现「${impl.implementationKey}」缺少与当前摘要一致的已验证试跑`,
      )
    }
  }
}

