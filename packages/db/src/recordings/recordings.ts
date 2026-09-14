import { schemaFor } from '../native.js'
import { and, desc, eq } from 'drizzle-orm'
import {
  RecordingNormalizationError, assertRecordingPayloadSize, canonicalJson, normalizeRecording, recordingDraftDetailSchema, recordingDraftListResponseSchema, recordingDraftSchema, type CreateRecordingBody, type RecordingDraftDetailDto, type RecordingDraftListResponse, } from '@cairn/shared'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, forbidden, mapRestriction, notFound } from '../runs/errors.js'
import { newId } from '../id.js'
import { consoleAccounts } from '../schema/console.js'
import { recordingDrafts } from '../schema/authoring.js'
import { targets } from '../schema/targets.js'

function iso(value: Date): string {
  return value.toISOString()
}

function recordingDigest(input: CreateRecordingBody, events: CreateRecordingBody['events']): string {
  return sha256Hex(
    canonicalJson({
      targetId: input.targetId,
      recordingId: input.recordingId,
      sourceVersion: input.sourceVersion,
      events,
    }),
  )
}

function defaultName(events: CreateRecordingBody['events']): string {
  const firstUrl = events.find((event) => typeof event.url === 'string' && event.url && event.url !== 'about:blank')
    ?.url
  if (firstUrl) {
    try {
      return `录制 ${new URL(firstUrl).host}`
    } catch {
      return '未命名录制'
    }
  }
  return '未命名录制'
}

export async function createRecordingDraft(
  db: Db,
  input: CreateRecordingBody,
  actor: AuditActor,
): Promise<{ created: boolean; detail: RecordingDraftDetailDto }> {
  const { recordingDrafts, targets } = schemaFor(db)
  assertRecordingPayloadSize(input)
  let normalized
  try {
    normalized = normalizeRecording(input.events, { sourceVersion: input.sourceVersion })
  } catch (error) {
    if (error instanceof RecordingNormalizationError) {
      throw badRequest(error.code, error.message)
    }
    throw error
  }

  const [target] = await db.select().from(targets).where(eq(targets.id, input.targetId)).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能上传录制')

  if (input.bindingId) {
    await assertBindingAcceptsUpload(db, input.bindingId, actor.id, input.targetId)
  }

  const digest = recordingDigest(input, normalized.events)
  const existing = await findIdempotent(db, actor.id, input.idempotencyKey)
  if (existing) {
    if (existing.payloadDigest !== digest) {
      throw conflict('RECORDING_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的录制内容')
    }
    if (input.bindingId) {
      await attachBindingDraft(db, input.bindingId, actor.id, existing.id)
    }
    return { created: false, detail: await toDetail(db, existing.id, actor.id) }
  }

  const id = newId()
  const now = new Date()
  const name = input.name?.trim() || defaultName(input.events)
  try {
    await db.transaction(async (tx) => {
      await tx.insert(recordingDrafts).values({
        id,
        targetId: input.targetId,
        createdByConsoleAccountId: actor.id,
        recordingId: input.recordingId,
        sourceVersion: input.sourceVersion,
        idempotencyKey: input.idempotencyKey,
        payloadDigest: digest,
        name,
        eventCount: normalized.eventCount,
        itemCount: normalized.items.length,
        unresolvedCount: normalized.unresolvedCount,
        events: normalized.events,
        items: normalized.items,
        diagnostics: normalized.diagnostics,
        createdAt: now,
        updatedAt: now,
      })
      await recordAudit(
        tx as unknown as Db,
        actor,
        'recording.create',
        'recording',
        id,
        `上传录制草稿「${name}」`,
      )
      if (input.bindingId) {
        await attachBindingDraft(tx as unknown as Db, input.bindingId, actor.id, id)
      }
    })
  } catch (error) {
    const mapped = mapRestriction(error)
    if (mapped?.code === 'RECORDING_IDEMPOTENCY_CONFLICT') {
      const raced = await findIdempotent(db, actor.id, input.idempotencyKey)
      if (raced && raced.payloadDigest === digest) {
        return { created: false, detail: await toDetail(db, raced.id, actor.id) }
      }
    }
    if (mapped) throw mapped
    throw error
  }

  return { created: true, detail: await toDetail(db, id, actor.id) }
}

export async function getRecordingDraft(
  db: Db,
  id: string,
  actorId?: string,
): Promise<RecordingDraftDetailDto> {
  return toDetail(db, id, actorId)
}

export async function listRecordingDrafts(db: Db, actorId: string): Promise<RecordingDraftListResponse> {
  const { consoleAccounts, recordingDrafts, targets } = schemaFor(db)
  const rows = await db
    .select({
      draft: recordingDrafts,
      targetName: targets.name,
      actorName: consoleAccounts.displayName,
    })
    .from(recordingDrafts)
    .innerJoin(targets, eq(recordingDrafts.targetId, targets.id))
    .innerJoin(consoleAccounts, eq(recordingDrafts.createdByConsoleAccountId, consoleAccounts.id))
    .where(eq(recordingDrafts.createdByConsoleAccountId, actorId))
    .orderBy(desc(recordingDrafts.createdAt), desc(recordingDrafts.id))

  return recordingDraftListResponseSchema.parse({
    items: rows.map((row) =>
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
  })
}

async function findIdempotent(db: Db, actorId: string, key: string) {
  const { recordingDrafts } = schemaFor(db)
  const [row] = await db
    .select()
    .from(recordingDrafts)
    .where(and(eq(recordingDrafts.createdByConsoleAccountId, actorId), eq(recordingDrafts.idempotencyKey, key)))
    .limit(1)
  return row
}

async function toDetail(db: Db, id: string, actorId?: string): Promise<RecordingDraftDetailDto> {
  const { consoleAccounts, recordingDrafts, targets } = schemaFor(db)
  const [row] = await db
    .select({
      draft: recordingDrafts,
      targetName: targets.name,
      actorName: consoleAccounts.displayName,
    })
    .from(recordingDrafts)
    .innerJoin(targets, eq(recordingDrafts.targetId, targets.id))
    .innerJoin(consoleAccounts, eq(recordingDrafts.createdByConsoleAccountId, consoleAccounts.id))
    .where(eq(recordingDrafts.id, id))
    .limit(1)
  if (!row || (actorId && row.draft.createdByConsoleAccountId !== actorId)) {
    throw notFound('RECORDING_NOT_FOUND', '录制草稿不存在')
  }
  return recordingDraftDetailSchema.parse({
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
    items: row.draft.items,
    diagnostics: row.draft.diagnostics,
    events: row.draft.events,
  })
}

async function assertBindingAcceptsUpload(db: Db, bindingId: string, actorId: string, targetId: string) {
  const { recordingBindings, scenarios } = schemaFor(db)
  const [row] = await db
    .select({ binding: recordingBindings, scenarioTargetId: scenarios.targetId })
    .from(recordingBindings)
    .innerJoin(scenarios, eq(recordingBindings.scenarioId, scenarios.id))
    .where(eq(recordingBindings.id, bindingId))
    .limit(1)
  if (!row || row.binding.createdByConsoleAccountId !== actorId) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.binding.status === 'closed') throw conflict('RECORDING_BINDING_CLOSED', '录制绑定已关闭')
  if (row.binding.status === 'issued') throw conflict('RECORDING_BINDING_EXPIRED', '录制绑定尚未领取')
  if (row.binding.uploadExpiresAt.getTime() <= Date.now()) {
    throw conflict('RECORDING_BINDING_EXPIRED', '录制绑定已过期，不能继续上传')
  }
  if (row.binding.targetId !== targetId || row.scenarioTargetId !== targetId) {
    throw forbidden('RECORDING_BINDING_FORBIDDEN', '录制绑定的目标系统与上传不一致')
  }
}

async function attachBindingDraft(db: Db, bindingId: string, actorId: string, draftId: string) {
  const { recordingBindings } = schemaFor(db)
  const [row] = await db.select().from(recordingBindings).where(eq(recordingBindings.id, bindingId)).limit(1)
  if (!row || row.createdByConsoleAccountId !== actorId) {
    throw notFound('RECORDING_BINDING_NOT_FOUND', '录制绑定不存在')
  }
  if (row.recordingDraftId && row.recordingDraftId !== draftId) {
    throw conflict('RECORDING_IMPORT_CONFLICT', '该绑定已经关联过录制批次')
  }
  if (row.recordingDraftId === draftId) return
  await db
    .update(recordingBindings)
    .set({ recordingDraftId: draftId, updatedAt: new Date() })
    .where(eq(recordingBindings.id, bindingId))
}
