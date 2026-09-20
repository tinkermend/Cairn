import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import {
  EMPTY_SUITE_DOCUMENT,
  assertPublishedSuiteDocument,
  createSuiteBodySchema,
  deletePreviewResponseSchema,
  saveSuiteDraftBodySchema,
  suiteDetailSchema,
  suiteDocumentSchema,
  suiteListQuerySchema,
  suiteListResponseSchema,
  type CreateSuiteBody,
  type SaveSuiteDraftBody,
  type SuiteDetailDto,
  type SuiteDocument,
  type SuiteListQuery,
  type SuiteListResponse,
  type SuiteStatus,
  type DeletePreviewResponse,
  type DeleteResourceBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, isUniqueViolation, mapRestriction, notFound } from '../runs/errors.js'
import { assertTargetPermission, scopedTargetFilter } from '../console/target-authorization.js'
import { snapshotDeletedBy, toDeleteResult } from '../lifecycle.js'
import { validateSuiteDocument } from './validate.js'

function rethrow(error: unknown): never {
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

function toDetail(
  suite: {
    id: string
    targetId: string
    name: string
    description: string | null
    status: SuiteStatus
    deletedAt: Date | null
    deletedBy: SuiteDetailDto['deletedBy']
    createdAt: Date
    updatedAt: Date
  },
  draft: { revision: number; document: SuiteDocument; updatedAt: Date },
  published: SuiteDetailDto['published'],
): SuiteDetailDto {
  return suiteDetailSchema.parse({
    id: suite.id,
    targetId: suite.targetId,
    name: suite.name,
    description: suite.description,
    status: suite.status,
    draft: {
      revision: draft.revision,
      document: draft.document,
      updatedAt: draft.updatedAt.toISOString(),
    },
    published,
    deletedAt: suite.deletedAt?.toISOString() ?? null,
    deletedBy: suite.deletedBy ?? null,
    createdAt: suite.createdAt.toISOString(),
    updatedAt: suite.updatedAt.toISOString(),
  })
}

async function loadSuiteRow(db: Db, suiteId: string) {
  const { scenarioSuites, scenarioSuiteDrafts, scenarioSuiteVersions } = schemaFor(db)
  const [suite] = await db.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
  if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
  const [draft] = await db.select().from(scenarioSuiteDrafts).where(eq(scenarioSuiteDrafts.suiteId, suiteId)).limit(1)
  if (!draft) throw notFound('SUITE_NOT_FOUND', '场景集草稿不存在')
  const [published] = await db
    .select()
    .from(scenarioSuiteVersions)
    .where(eq(scenarioSuiteVersions.suiteId, suiteId))
    .orderBy(desc(scenarioSuiteVersions.versionNo))
    .limit(1)
  return { suite, draft, published: published ?? null }
}

export async function getSuite(db: Db, suiteId: string, actorId?: string): Promise<SuiteDetailDto> {
  const loaded = await loadSuiteRow(db, suiteId)
  if (actorId) await assertTargetPermission(db, actorId, loaded.suite.targetId, 'suite:read')
  return toDetail(
    loaded.suite,
    loaded.draft,
    loaded.published
      ? {
          id: loaded.published.id,
          versionNo: loaded.published.versionNo,
          document: loaded.published.document,
          digest: loaded.published.digest,
          publishedAt: loaded.published.publishedAt.toISOString(),
          publishedBy: loaded.published.publishedByConsoleAccountId,
        }
      : null,
  )
}

export async function listSuites(db: Db, query: Partial<SuiteListQuery> = {}, actorId?: string): Promise<SuiteListResponse> {
  const parsed = suiteListQuerySchema.parse(query)
  const { scenarioSuites, scenarioSuiteDrafts, scenarioSuiteVersions } = schemaFor(db)
  const filters: (SQL | undefined)[] = [
    await scopedTargetFilter(db, actorId, scenarioSuites.targetId, 'suite:read'),
    isNull(scenarioSuites.deletedAt),
    parsed.targetId ? eq(scenarioSuites.targetId, parsed.targetId) : undefined,
    parsed.status ? eq(scenarioSuites.status, parsed.status) : undefined,
    parsed.q
      ? sql`lower(${scenarioSuites.name}) like ${'%' + parsed.q.toLowerCase() + '%'}`
      : undefined,
    cursorFilter(scenarioSuites.updatedAt, scenarioSuites.id, parsed.cursor),
  ]
  const rows = await db
    .select({
      suite: scenarioSuites,
      draftRevision: scenarioSuiteDrafts.revision,
      document: scenarioSuiteDrafts.document,
      publishedVersionNo: sql<number | null>`(
        select max(${scenarioSuiteVersions.versionNo}) from ${scenarioSuiteVersions}
        where ${scenarioSuiteVersions.suiteId} = ${scenarioSuites.id}
      )`,
    })
    .from(scenarioSuites)
    .innerJoin(scenarioSuiteDrafts, eq(scenarioSuiteDrafts.suiteId, scenarioSuites.id))
    .where(and(...filters.filter((item): item is SQL => item !== undefined)))
    .orderBy(desc(scenarioSuites.updatedAt), desc(scenarioSuites.id))
    .limit(parsed.limit + 1)
  const paginated = paginateResults(
    rows.map((row) => ({ ...row, id: row.suite.id, createdAt: row.suite.updatedAt })),
    parsed.limit,
  )
  return suiteListResponseSchema.parse({
    items: paginated.items.map((row) => ({
      id: row.suite.id,
      targetId: row.suite.targetId,
      name: row.suite.name,
      description: row.suite.description,
      status: row.suite.status,
      draftRevision: row.draftRevision,
      publishedVersionNo: row.publishedVersionNo == null ? null : Number(row.publishedVersionNo),
      memberCount: row.document.members.length,
      updatedAt: row.suite.updatedAt.toISOString(),
    })),
    nextCursor: paginated.nextCursor,
  })
}

export async function createSuite(db: Db, input: CreateSuiteBody, actor: AuditActor): Promise<SuiteDetailDto> {
  const body = createSuiteBodySchema.parse(input)
  await assertTargetPermission(db, actor.id, body.targetId, 'suite:write')
  const document = body.document ?? EMPTY_SUITE_DOCUMENT
  const id = newId()
  const now = new Date()
  try {
    await atomic(db, async (tx) => {
      const { scenarioSuites, scenarioSuiteDrafts, targets } = schemaFor(tx)
      const [target] = await tx.select().from(targets).where(eq(targets.id, body.targetId)).limit(1)
      if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用')
      await tx.insert(scenarioSuites).values({
        id,
        targetId: body.targetId,
        name: body.name,
        description: body.description ?? null,
        status: 'active',
        createdByConsoleAccountId: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(scenarioSuiteDrafts).values({
        suiteId: id,
        revision: 1,
        document,
        updatedByConsoleAccountId: actor.id,
        updatedAt: now,
      })
      await recordAudit(tx, actor, 'suite.create', 'suite', id, `创建场景集「${body.name}」`)
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SUITE_NAME_CONFLICT', '同一目标下场景集名称已存在')
    rethrow(error)
  }
  return getSuite(db, id)
}

export async function saveSuiteDraft(
  db: Db,
  suiteId: string,
  input: SaveSuiteDraftBody,
  actor: AuditActor,
): Promise<SuiteDetailDto> {
  const body = saveSuiteDraftBodySchema.parse(input)
  const document = suiteDocumentSchema.parse(body.document)
  try {
    await atomic(db, async (tx) => {
      const { scenarioSuites, scenarioSuiteDrafts } = schemaFor(tx)
      const [suite] = await tx.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
      if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
      await assertTargetPermission(tx, actor.id, suite.targetId, 'suite:write')
      const [draft] = await tx.select().from(scenarioSuiteDrafts).where(eq(scenarioSuiteDrafts.suiteId, suiteId)).limit(1)
      if (!draft || draft.revision !== body.expectedRevision) {
        throw conflict('SUITE_DRAFT_CONFLICT', '草稿已被他人更新，请刷新后重试')
      }
      const now = new Date()
      await tx
        .update(scenarioSuiteDrafts)
        .set({
          revision: draft.revision + 1,
          document,
          updatedByConsoleAccountId: actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioSuiteDrafts.suiteId, suiteId))
      await tx
        .update(scenarioSuites)
        .set({
          name: body.name ?? suite.name,
          description: body.description === undefined ? suite.description : body.description,
          updatedAt: now,
        })
        .where(eq(scenarioSuites.id, suiteId))
      await recordAudit(tx, actor, 'suite.update', 'suite', suiteId, '保存场景集草稿')
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('SUITE_NAME_CONFLICT', '同一目标下场景集名称已存在')
    rethrow(error)
  }
  return getSuite(db, suiteId)
}

export async function validateSuite(db: Db, suiteId: string, actorId?: string) {
  const detail = await getSuite(db, suiteId, actorId)
  const issues = await validateSuiteDocument(db, detail.targetId, detail.draft.document)
  return { ok: issues.every((item) => item.severity !== 'error'), issues }
}

export async function publishSuite(
  db: Db,
  suiteId: string,
  input: { expectedRevision: number; idempotencyKey: string },
  actor: AuditActor,
): Promise<SuiteDetailDto> {
  await atomic(db, async (tx) => {
    const { scenarioSuites, scenarioSuiteDrafts, scenarioSuiteVersions, scenarioSuitePublishReceipts } =
      schemaFor(tx)
    const [suite] = await tx.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
    if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
    await assertTargetPermission(tx, actor.id, suite.targetId, 'suite:write')
    const [existing] = await tx
      .select()
      .from(scenarioSuitePublishReceipts)
      .where(
        and(
          eq(scenarioSuitePublishReceipts.actorId, actor.id),
          eq(scenarioSuitePublishReceipts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
    const [draft] = await tx.select().from(scenarioSuiteDrafts).where(eq(scenarioSuiteDrafts.suiteId, suiteId)).limit(1)
    if (!draft) throw notFound('SUITE_NOT_FOUND', '场景集草稿不存在')
    if (existing) return
    if (draft.revision !== input.expectedRevision) throw conflict('SUITE_DRAFT_CONFLICT', '草稿已被他人更新，请刷新后重试')
    const empty = assertPublishedSuiteDocument(draft.document)
    if (empty.length) throw badRequest('SUITE_EMPTY', empty[0]!.message)
    const issues = await validateSuiteDocument(tx, suite.targetId, draft.document)
    if (issues.some((item) => item.severity === 'error')) {
      throw badRequest('SUITE_VALIDATION_FAILED', '场景集校验未通过', issues)
    }
    const [latest] = await tx
      .select({ versionNo: scenarioSuiteVersions.versionNo })
      .from(scenarioSuiteVersions)
      .where(eq(scenarioSuiteVersions.suiteId, suiteId))
      .orderBy(desc(scenarioSuiteVersions.versionNo))
      .limit(1)
    const versionId = newId()
    const digest = sha256Hex(draft.document)
    await tx.insert(scenarioSuiteVersions).values({
      id: versionId,
      suiteId,
      versionNo: (latest?.versionNo ?? 0) + 1,
      document: draft.document,
      digest,
      publishedByConsoleAccountId: actor.id,
    })
    await tx.insert(scenarioSuitePublishReceipts).values({
      actorId: actor.id,
      idempotencyKey: input.idempotencyKey,
      digest,
      versionId,
    })
    await recordAudit(tx, actor, 'suite.publish', 'suite', suiteId, `发布场景集 v${(latest?.versionNo ?? 0) + 1}`)
  })
  return getSuite(db, suiteId)
}

export async function updateSuiteEnabled(
  db: Db,
  suiteId: string,
  status: SuiteStatus,
  actor: AuditActor,
): Promise<SuiteDetailDto> {
  await atomic(db, async (tx) => {
    const { scenarioSuites } = schemaFor(tx)
    const [suite] = await tx.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
    if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
    await assertTargetPermission(tx, actor.id, suite.targetId, 'suite:write')
    await tx
      .update(scenarioSuites)
      .set({ status, updatedAt: new Date() })
      .where(eq(scenarioSuites.id, suiteId))
    await recordAudit(tx, actor, 'suite.update', 'suite', suiteId, status === 'active' ? '启用场景集' : '停用场景集')
  })
  return getSuite(db, suiteId)
}

export async function previewDeleteSuite(db: Db, suiteId: string): Promise<DeletePreviewResponse> {
  const { scenarioSuites, suiteRuns } = schemaFor(db)
  const [suite] = await db.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
  if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
  const open = await db
    .select({ id: suiteRuns.id, status: suiteRuns.status })
    .from(suiteRuns)
    .where(
      and(
        eq(suiteRuns.suiteId, suiteId),
        sql`${suiteRuns.status} in ('QUEUED', 'RUNNING', 'WAITING', 'NEEDS_REVIEW')`,
      ),
    )
  return deletePreviewResponseSchema.parse({
    previewToken: newId(),
    counts: { runs: open.length },
    blockers: open.map((row) => ({
      id: row.id,
      code: 'SUITE_RUN_ACTIVE',
      message: `集合运行仍在进行（${row.status}）`,
    })),
  })
}

export async function deleteSuite(db: Db, suiteId: string, _body: DeleteResourceBody, actor: AuditActor) {
  return atomic(db, async (tx) => {
    const { scenarioSuites } = schemaFor(tx)
    const [suite] = await tx.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
    if (!suite) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
    if (suite.deletedAt && suite.deletedBy) {
      return toDeleteResult({ id: suiteId, deletedAt: suite.deletedAt, deletedBy: suite.deletedBy })
    }
    await assertTargetPermission(tx, actor.id, suite.targetId, 'suite:delete')
    const preview = await previewDeleteSuite(tx, suiteId)
    if (preview.blockers.length) throw conflict('RESOURCE_BUSY', preview.blockers[0]!.message)
    const now = new Date()
    const deletedBy = await snapshotDeletedBy(tx, actor)
    await tx
      .update(scenarioSuites)
      .set({
        deletedAt: now,
        deletedBy,
        name: `${suite.name}#${suiteId.slice(0, 8)}`,
        updatedAt: now,
      })
      .where(eq(scenarioSuites.id, suiteId))
    await recordAudit(tx, actor, 'suite.delete', 'suite', suiteId, `删除场景集「${suite.name}」`)
    return toDeleteResult({ id: suiteId, deletedAt: now, deletedBy })
  })
}
