import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, ne } from 'drizzle-orm'
import {
  MAX_SCENARIO_STEPS,
  RECORDING_NORMALIZER_VERSION,
  RECORDING_TICKET_TTL_SECONDS,
  RECORDING_UPLOAD_TTL_SECONDS,
  RecordingNormalizationError,
  applyRecordingImportBodySchema,
  candidateStepFromItem,
  canonicalJson,
  compileScenarioDocument,
  normalizeApiOrigin,
  normalizeRecording,
  parseScenarioDocument,
  recordingBindingSchema,
  recordingDraftSchema,
  recordingImportListResponseSchema,
  recordingImportPreviewSchema,
  recordingImportReceiptSchema,
  recordingItemReady,
  sameSourceIndexes,
  type ApplyRecordingImportBody,
  type CreateRecordingBindingBody,
  type RecordingBindingCreated,
  type RecordingBindingDto,
  type RecordingDisposition,
  type RecordingImportListResponse,
  type RecordingImportPreview,
  type RecordingImportReceipt,
  type RecordingInsertAnchor,
  type ScenarioDetailDto,
  type ScenarioDocument,
  type Step,
} from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, forbidden, mapRestriction, notFound } from '../runs/errors.js'
import { getScenario } from '../runs/scenarios.js'
import { getRecordingDraft } from './recordings.js'

function iso(value: Date): string {
  return value.toISOString()
}

export function hashRecordingTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex')
}

export function newRecordingTicket(): string {
  return randomBytes(32).toString('hex')
}

export async function createRecordingBinding(
  db: Db,
  scenarioId: string,
  input: CreateRecordingBindingBody & { apiOrigin: string },
  actor: AuditActor,
): Promise<RecordingBindingCreated> {
  const { recordingBindings, scenarioDrafts, scenarios, targets } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const [draft] = await db.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1)
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  const document = parseScenarioDocument(draft.document)
  assertAnchor(document, input.insertAnchor)
  const [target] = await db.select().from(targets).where(eq(targets.id, scenario.targetId)).limit(1)
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能开始录制')

  const id = newId()
  const ticket = newRecordingTicket()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + RECORDING_TICKET_TTL_SECONDS * 1000)
  const uploadExpiresAt = new Date(now.getTime() + RECORDING_UPLOAD_TTL_SECONDS * 1000)
  const apiOrigin = normalizeApiOrigin(input.apiOrigin)

  await db.insert(recordingBindings).values({
    id,
    createdByConsoleAccountId: actor.id,
    targetId: scenario.targetId,
    scenarioId,
    draftRevision: input.revision,
    insertAnchor: input.insertAnchor,
    ticketHash: hashRecordingTicket(ticket),
    status: 'issued',
    apiOrigin,
    expiresAt,
    uploadExpiresAt,
    createdAt: now,
    updatedAt: now,
  })
  await recordAudit(db, actor, 'recording.create', 'recording', id, `从场景「${scenario.name}」发起录制`)

  const binding = recordingBindingSchema.parse({
    id,
    scenarioId,
    scenarioName: scenario.name,
    targetId: target.id,
    targetName: target.name,
    entryUrl: target.entryUrl,
    loginUrl: target.loginUrl ?? null,
    draftRevision: input.revision,
    insertAnchor: input.insertAnchor,
    status: 'issued',
    apiOrigin,
    expiresAt: iso(expiresAt),
    uploadExpiresAt: iso(uploadExpiresAt),
    recordingDraftId: null,
    createdAt: iso(now),
    claimedAt: null,
    closedAt: null,
  })
  return { binding, ticket }
}

export async function claimRecordingBinding(
  db: Db,
  input: { ticket?: string; bindingId?: string; apiOrigin: string },
  actor: AuditActor,
): Promise<RecordingBindingDto> {
  const { recordingBindings } = schemaFor(db)
  const now = new Date()
  const [row] = input.ticket
    ? await db
        .select()
        .from(recordingBindings)
        .where(eq(recordingBindings.ticketHash, hashRecordingTicket(input.ticket)))
        .limit(1)
    : await db
        .select()
        .from(recordingBindings)
        .where(eq(recordingBindings.id, input.bindingId!))
        .limit(1)
  if (!row || row.createdByConsoleAccountId !== actor.id) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.status === 'closed') throw conflict('RECORDING_BINDING_CLOSED', '录制绑定已关闭')
  if (row.status === 'claimed') throw conflict('RECORDING_BINDING_CLAIMED', '录制绑定已被领取')
  if (row.expiresAt.getTime() <= now.getTime()) throw conflict('RECORDING_BINDING_EXPIRED', '录制绑定已过期')
  if (normalizeApiOrigin(row.apiOrigin) !== normalizeApiOrigin(input.apiOrigin)) {
    throw forbidden('RECORDING_BINDING_ORIGIN_MISMATCH', '插件连接的环境与发起录制的环境不一致')
  }
  await db
    .update(recordingBindings)
    .set({ status: 'claimed', claimedAt: now, updatedAt: now })
    .where(eq(recordingBindings.id, row.id))
  await recordAudit(db, actor, 'recording.create', 'recording', row.id, '插件领取录制绑定')
  return toBindingDto(db, row.id)
}

export async function closeRecordingBinding(
  db: Db,
  bindingId: string,
  actor: AuditActor,
): Promise<RecordingBindingDto> {
  const { recordingBindings } = schemaFor(db)
  const [row] = await db.select().from(recordingBindings).where(eq(recordingBindings.id, bindingId)).limit(1)
  if (!row || row.createdByConsoleAccountId !== actor.id) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.status !== 'closed') {
    const now = new Date()
    await db
      .update(recordingBindings)
      .set({ status: 'closed', closedAt: row.closedAt ?? now, updatedAt: now })
      .where(eq(recordingBindings.id, bindingId))
    await recordAudit(db, actor, 'recording.create', 'recording', bindingId, '关闭录制绑定')
  }
  return toBindingDto(db, bindingId)
}

export async function getOpenRecordingBinding(db: Db, actorId: string): Promise<RecordingBindingDto | null> {
  const { recordingBindings } = schemaFor(db)
  const now = new Date()
  const rows = await db
    .select()
    .from(recordingBindings)
    .where(
      and(eq(recordingBindings.createdByConsoleAccountId, actorId), ne(recordingBindings.status, 'closed')),
    )
    .orderBy(desc(recordingBindings.createdAt))
    .limit(8)
  const open = rows.find((row) => {
    if (row.status === 'issued') return row.expiresAt.getTime() > now.getTime()
    return row.uploadExpiresAt.getTime() > now.getTime()
  })
  return open ? toBindingDto(db, open.id) : null
}

export async function listScenarioRecordingImports(
  db: Db,
  scenarioId: string,
  actorId: string,
): Promise<RecordingImportListResponse> {
  const { recordingBindings, recordingDrafts, recordingImportReceipts, scenarios, targets, consoleAccounts } =
    schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  const receipts = await db
    .select()
    .from(recordingImportReceipts)
    .where(eq(recordingImportReceipts.scenarioId, scenarioId))
    .orderBy(desc(recordingImportReceipts.createdAt))

  const importedIds = new Set(receipts.map((row) => row.recordingDraftId))
  const bindings = await db
    .select()
    .from(recordingBindings)
    .where(
      and(eq(recordingBindings.scenarioId, scenarioId), eq(recordingBindings.createdByConsoleAccountId, actorId)),
    )
    .orderBy(desc(recordingBindings.createdAt))

  const drafts = await db
    .select({
      draft: recordingDrafts,
      targetName: targets.name,
      actorName: consoleAccounts.displayName,
    })
    .from(recordingDrafts)
    .innerJoin(targets, eq(recordingDrafts.targetId, targets.id))
    .innerJoin(consoleAccounts, eq(recordingDrafts.createdByConsoleAccountId, consoleAccounts.id))
    .where(
      and(
        eq(recordingDrafts.createdByConsoleAccountId, actorId),
        eq(recordingDrafts.targetId, scenario.targetId),
      ),
    )
    .orderBy(desc(recordingDrafts.createdAt))

  return recordingImportListResponseSchema.parse({
    bindings: await Promise.all(bindings.filter((row) => row.status !== 'closed').map((row) => toBindingDto(db, row.id))),
    drafts: drafts
      .filter((row) => !importedIds.has(row.draft.id))
      .map((row) =>
        recordingDraftSchema.parse({
          id: row.draft.id,
          targetId: row.draft.targetId,
          targetName: row.targetName,
          name: row.draft.name,
          recordingId: row.draft.recordingId,
          sourceVersion: row.draft.sourceVersion,
          eventCount: row.draft.eventCount,
          itemCount: row.draft.itemCount,
          unresolvedCount: row.draft.unresolvedCount,
          createdBy: { id: row.draft.createdByConsoleAccountId, displayName: row.actorName },
          createdAt: iso(row.draft.createdAt),
          updatedAt: iso(row.draft.updatedAt),
        }),
      ),
    receipts: receipts.map(toReceiptDto),
  })
}

export async function previewRecordingImport(
  db: Db,
  scenarioId: string,
  input: { recordingDraftId: string; baseRevision: number; insertAnchor: RecordingInsertAnchor },
  actorId: string,
): Promise<RecordingImportPreview> {
  const { scenarioDrafts, scenarios } = schemaFor(db)
  const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const [draft] = await db.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1)
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
  const document = parseScenarioDocument(draft.document)
  assertAnchor(document, input.insertAnchor)
  const recording = await getRecordingDraft(db, input.recordingDraftId, actorId)
  if (recording.targetId !== scenario.targetId) {
    throw forbidden('RECORDING_BINDING_FORBIDDEN', '录制批次与场景的目标系统不一致')
  }
  const compiled = compileImportPreview(recording.events, recording.sourceVersion, recording.name)
  return recordingImportPreviewSchema.parse({
    ...compiled,
    recordingDraftId: recording.id,
    remainingStepCapacity: Math.max(0, MAX_SCENARIO_STEPS - document.steps.length),
    currentRevision: draft.revision,
    insertAnchor: input.insertAnchor,
  })
}

export async function applyRecordingImport(
  db: Db,
  scenarioId: string,
  input: ApplyRecordingImportBody,
  actor: AuditActor,
  options: { executableTypes?: readonly string[] } = {},
): Promise<{ receipt: RecordingImportReceipt; scenario: ScenarioDetailDto }> {
  applyRecordingImportBodySchema.parse(input)
  const requestDigest = sha256Hex(canonicalJson(input))
  const { recordingImportReceipts, scenarioDrafts, scenarios } = schemaFor(db)

  const existing = await findIdempotentReceipt(db, actor.id, input.idempotencyKey)
  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      throw conflict('RECORDING_IMPORT_CONFLICT', '相同幂等键对应不同的导入请求')
    }
    return { receipt: toReceiptDto(existing), scenario: await getScenario(db, scenarioId, options) }
  }

  try {
    await db.transaction(async (tx) => {
      const [scenario] = await locked(
        tx,
        tx.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1),
      )
      if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
      const [draft] = await locked(
        tx,
        tx.select().from(scenarioDrafts).where(eq(scenarioDrafts.scenarioId, scenarioId)).limit(1),
      )
      if (!draft) throw notFound('SCENARIO_NOT_FOUND', '场景草稿不存在')
      if (draft.revision !== input.baseRevision) {
        throw conflict('SCENARIO_DRAFT_CONFLICT', '草稿已被他人更新', {
          revision: draft.revision,
          document: draft.document,
        })
      }
      const document = parseScenarioDocument(draft.document)
      assertAnchor(document, input.insertAnchor)
      const recording = await getRecordingDraft(tx as unknown as Db, input.recordingDraftId, actor.id)
      if (recording.targetId !== scenario.targetId) {
        throw forbidden('RECORDING_BINDING_FORBIDDEN', '录制批次与场景的目标系统不一致')
      }
      const preview = compileImportPreview(recording.events, recording.sourceVersion, recording.name)
      if (preview.sourceDigest !== input.sourceDigest || input.normalizerVersion !== RECORDING_NORMALIZER_VERSION) {
        throw conflict('RECORDING_IMPORT_STALE', '转换结果已变化，请重新预览')
      }
      const next = applyDispositions(document, preview.items, input.dispositions, input.insertAnchor)
      const compiled = compileScenarioDocument(next.document, {
        mode: 'release',
        target: { exists: true, status: 'active' },
        executableTypes: options.executableTypes,
      })
      if (!compiled.ok) {
        throw badRequest('SCENARIO_COMPILE_BLOCKED', '回填后的草稿未通过编译', {
          diagnostics: compiled.diagnostics,
        })
      }
      const now = new Date()
      const newRevision = draft.revision + 1
      await tx
        .update(scenarioDrafts)
        .set({
          revision: newRevision,
          document: next.document,
          updatedByConsoleAccountId: actor.id,
          updatedAt: now,
        })
        .where(eq(scenarioDrafts.scenarioId, scenarioId))
      await tx.update(scenarios).set({ updatedAt: now }).where(eq(scenarios.id, scenarioId))
      await tx.insert(recordingImportReceipts).values({
        id: newId(),
        scenarioId,
        recordingDraftId: input.recordingDraftId,
        createdByConsoleAccountId: actor.id,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        sourceDigest: preview.sourceDigest,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        baseRevision: draft.revision,
        newRevision,
        insertAnchor: input.insertAnchor,
        sourceMap: next.sourceMap,
        createdAt: now,
      })
      await recordAudit(
        tx as unknown as Db,
        actor,
        'scenario.update',
        'scenario',
        scenarioId,
        `回填录制到草稿 r${newRevision}`,
      )
    })
  } catch (error) {
    const mapped = mapRestriction(error)
    if (mapped?.code === 'RECORDING_IMPORT_CONFLICT') {
      const raced = await findIdempotentReceipt(db, actor.id, input.idempotencyKey)
      if (raced && raced.requestDigest === requestDigest) {
        return { receipt: toReceiptDto(raced), scenario: await getScenario(db, scenarioId, options) }
      }
    }
    if (mapped) throw mapped
    throw error
  }
  const receipts = await db
    .select()
    .from(recordingImportReceipts)
    .where(
      and(
        eq(recordingImportReceipts.scenarioId, scenarioId),
        eq(recordingImportReceipts.recordingDraftId, input.recordingDraftId),
      ),
    )
    .limit(1)
  return { receipt: toReceiptDto(receipts[0]!), scenario: await getScenario(db, scenarioId, options) }
}

function compileImportPreview(
  events: unknown[],
  sourceVersion: string,
  recordingName: string,
) {
  let normalized
  try {
    normalized = normalizeRecording(events, { sourceVersion, forImport: true })
  } catch (error) {
    if (error instanceof RecordingNormalizationError) {
      throw badRequest(error.code, error.message)
    }
    throw error
  }
  const items = normalized.items.map((item) => {
    const candidateStep = candidateStepFromItem(item, '00000000-0000-4000-8000-000000000000')
    return {
      ...item,
      ready: recordingItemReady(item),
      candidateStep,
    }
  })
  return {
    recordingName,
    normalizerVersion: RECORDING_NORMALIZER_VERSION,
    sourceVersion,
    sourceDigest: sha256Hex(canonicalJson({ version: RECORDING_NORMALIZER_VERSION, events: normalized.events })),
    eventCount: normalized.eventCount,
    items,
    diagnostics: normalized.diagnostics,
  }
}

function applyDispositions(
  document: ScenarioDocument,
  items: RecordingImportPreview['items'],
  dispositions: RecordingDisposition[],
  anchor: RecordingInsertAnchor,
): { document: ScenarioDocument; sourceMap: RecordingImportReceipt['sourceMap'] } {
  if (dispositions.length !== items.length) {
    throw badRequest('RECORDING_IMPORT_INCOMPLETE', '必须处理预览中的每一项')
  }
  const used = new Set<number>()
  const inserted: Step[] = []
  const sourceMap: RecordingImportReceipt['sourceMap'] = []
  for (const item of items) {
    const index = dispositions.findIndex((entry) => sameSourceIndexes(entry.sourceIndexes, item.sourceIndexes))
    if (index < 0 || used.has(index)) {
      throw badRequest('RECORDING_IMPORT_INCOMPLETE', '必须处理预览中的每一项，且不能重复')
    }
    used.add(index)
    const disposition = dispositions[index]!
    if (disposition.disposition === 'discard') {
      sourceMap.push({
        sourceIndexes: item.sourceIndexes,
        disposition: 'discard',
        reason: disposition.reason,
      })
      continue
    }
    let step: Step
    if (disposition.disposition === 'accept') {
      if (!item.ready || !item.candidateStep) {
        throw badRequest('RECORDING_IMPORT_INCOMPLETE', `「${item.name}」还不能接受，请修正或舍弃`)
      }
      step = { ...item.candidateStep, id: newId() }
    } else {
      step = { ...disposition.step, id: newId() }
    }
    inserted.push(step)
    sourceMap.push({
      sourceIndexes: item.sourceIndexes,
      stepId: step.id,
      disposition: disposition.disposition,
    })
  }
  if (inserted.length === 0) {
    throw badRequest('RECORDING_IMPORT_INCOMPLETE', '全部舍弃请使用放弃导入，不要提交空回填')
  }
  if (document.steps.length + inserted.length > MAX_SCENARIO_STEPS) {
    throw badRequest(
      'RECORDING_IMPORT_CAPACITY',
      `回填后将超过 ${MAX_SCENARIO_STEPS} 步，当前还可插入 ${Math.max(0, MAX_SCENARIO_STEPS - document.steps.length)} 步`,
    )
  }
  const at =
    anchor.kind === 'start'
      ? 0
      : document.steps.findIndex((step) => step.id === anchor.stepId) + 1
  if (anchor.kind === 'after' && at === 0) {
    throw conflict('RECORDING_IMPORT_STALE', '插入位置的步骤已不存在，请重新预览')
  }
  const steps = [...document.steps.slice(0, at), ...inserted, ...document.steps.slice(at)]
  return { document: { ...document, steps }, sourceMap }
}

function assertAnchor(document: ScenarioDocument, anchor: RecordingInsertAnchor) {
  if (anchor.kind === 'start') return
  if (!document.steps.some((step) => step.id === anchor.stepId)) {
    throw conflict('RECORDING_IMPORT_STALE', '插入位置的步骤已不存在，请重新预览')
  }
}

async function findIdempotentReceipt(db: Db, actorId: string, key: string) {
  const { recordingImportReceipts } = schemaFor(db)
  const [row] = await db
    .select()
    .from(recordingImportReceipts)
    .where(
      and(
        eq(recordingImportReceipts.createdByConsoleAccountId, actorId),
        eq(recordingImportReceipts.idempotencyKey, key),
      ),
    )
    .limit(1)
  return row
}

async function toBindingDto(db: Db, id: string): Promise<RecordingBindingDto> {
  const { recordingBindings, scenarios, targets } = schemaFor(db)
  const [row] = await db
    .select({
      binding: recordingBindings,
      scenarioName: scenarios.name,
      targetName: targets.name,
      entryUrl: targets.entryUrl,
      loginUrl: targets.loginUrl,
    })
    .from(recordingBindings)
    .innerJoin(scenarios, eq(recordingBindings.scenarioId, scenarios.id))
    .innerJoin(targets, eq(recordingBindings.targetId, targets.id))
    .where(eq(recordingBindings.id, id))
    .limit(1)
  if (!row) throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  return recordingBindingSchema.parse({
    id: row.binding.id,
    scenarioId: row.binding.scenarioId,
    scenarioName: row.scenarioName,
    targetId: row.binding.targetId,
    targetName: row.targetName,
    entryUrl: row.entryUrl,
    loginUrl: row.loginUrl ?? null,
    draftRevision: row.binding.draftRevision,
    insertAnchor: row.binding.insertAnchor,
    status: row.binding.status,
    apiOrigin: row.binding.apiOrigin,
    expiresAt: iso(row.binding.expiresAt),
    uploadExpiresAt: iso(row.binding.uploadExpiresAt),
    recordingDraftId: row.binding.recordingDraftId,
    createdAt: iso(row.binding.createdAt),
    claimedAt: row.binding.claimedAt ? iso(row.binding.claimedAt) : null,
    closedAt: row.binding.closedAt ? iso(row.binding.closedAt) : null,
  })
}

function toReceiptDto(row: {
  id: string
  scenarioId: string
  recordingDraftId: string
  sourceDigest: string
  normalizerVersion: string
  baseRevision: number
  newRevision: number
  sourceMap: RecordingImportReceipt['sourceMap']
  createdAt: Date
}): RecordingImportReceipt {
  return recordingImportReceiptSchema.parse({
    id: row.id,
    scenarioId: row.scenarioId,
    recordingDraftId: row.recordingDraftId,
    sourceDigest: row.sourceDigest,
    normalizerVersion: row.normalizerVersion,
    baseRevision: row.baseRevision,
    newRevision: row.newRevision,
    insertedStepIds: row.sourceMap.flatMap((item) => (item.stepId ? [item.stepId] : [])),
    sourceMap: row.sourceMap,
    createdAt: iso(row.createdAt),
  })
}
