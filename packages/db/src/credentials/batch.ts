import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { canonicalJson, credentialBatchSchema, CREDENTIAL_METADATA_BATCH_LIMIT, CREDENTIAL_PASSWORD_BATCH_LIMIT,
  type CredentialBatchCreateBody, type CredentialBatchItemSubmitBody } from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { lockConsoleAuthorization } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, clockNow, schemaFor } from '../native.js'
import { badRequest, conflict, DomainError, notFound } from '../runs/errors.js'
import { assertCredentialAccess } from './access.js'
import { getCredential, replaceCredentialMaterial, updateCredentialMetadata } from './catalog.js'
import type { SealedSecret } from './sync.js'

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')

export async function createCredentialBatch(db: Db, body: CredentialBatchCreateBody, actor: AuditActor) {
  const limit = body.kind === 'password_replace' ? CREDENTIAL_PASSWORD_BATCH_LIMIT : CREDENTIAL_METADATA_BATCH_LIMIT
  if (!body.items.length || body.items.length > limit) throw badRequest('CREDENTIAL_BATCH_LIMIT_EXCEEDED', `批次须为 1–${limit} 条`)
  if (new Set(body.items.map((item) => item.itemId)).size !== body.items.length || new Set(body.items.map((item) => item.credentialId)).size !== body.items.length) {
    throw badRequest('CREDENTIAL_BATCH_DUPLICATE', '同批账号或条目重复，请核对后提交')
  }
  const batchId = await atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { credentialBatches, credentialBatchItems } = schemaFor(tx)
    const [existing] = await tx.select().from(credentialBatches).where(and(eq(credentialBatches.actorConsoleAccountId, actor.id), eq(credentialBatches.idempotencyKey, body.idempotencyKey)))
    const requestDigest = digest(body)
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw conflict('CREDENTIAL_IDEMPOTENCY_CONFLICT', '同一提交标识对应不同内容')
      return existing.id
    }
    const bindings: Array<{ targetId: string; accountId: string }> = []
    for (const item of body.items) {
      const binding = await assertCredentialAccess(tx, item.credentialId, actor.id, 'credential:write')
      if (body.source === 'excel') await assertCredentialAccess(tx, item.credentialId, actor.id, 'credential:import')
      if ((item.targetId && item.targetId !== binding.targetId) || (item.targetAccountId && item.targetAccountId !== binding.accountId)) {
        throw badRequest('CREDENTIAL_BINDING_MISMATCH', '目标系统、账号与凭据不匹配')
      }
      bindings.push(binding)
    }
    const id = newId()
    const now = await clockNow(tx)
    await tx.insert(credentialBatches).values({ id, actorConsoleAccountId: actor.id, kind: body.kind, source: body.source ?? 'selection', idempotencyKey: body.idempotencyKey, requestDigest, createdAt: now })
    await tx.insert(credentialBatchItems).values(body.items.map((item, index) => ({ id: item.itemId, batchId: id,
      credentialId: item.credentialId, targetId: bindings[index]!.targetId, targetAccountId: bindings[index]!.accountId,
      expectedRevision: item.expectedRevision, itemIdempotencyKey: item.itemId, status: 'pending_material', createdAt: now, updatedAt: now })))
    await recordAudit(tx, { kind: 'console', id: actor.id }, 'credential.batch', 'credential', id, `批量维护 ${body.items.length} 个账号`)
    return id
  })
  if (body.kind === 'metadata') {
    for (const item of body.items) await submitCredentialBatchItem(db, batchId, item.itemId, {
      idempotencyKey: item.itemId, validity: item.validity, startedAt: item.startedAt,
      ownerConsoleAccountId: item.ownerConsoleAccountId, tags: item.tags,
    }, actor)
  }
  return getCredentialBatch(db, batchId, actor)
}

export async function getCredentialBatch(db: Db, batchId: string, actor: AuditActor) {
  const { credentialBatches, credentialBatchItems } = schemaFor(db)
  const [batch] = await db.select().from(credentialBatches).where(eq(credentialBatches.id, batchId))
  if (!batch || batch.actorConsoleAccountId !== actor.id) throw notFound('CREDENTIAL_BATCH_NOT_FOUND', '批次不存在')
  const rows = await db.select().from(credentialBatchItems).where(eq(credentialBatchItems.batchId, batchId))
  const items = await Promise.all(rows.map(async (item) => {
    let accessible = true
    try { await assertCredentialAccess(db, item.credentialId, actor.id) } catch { accessible = false }
    return { itemId: item.id, credentialId: accessible ? item.credentialId : null,
      targetId: accessible ? item.targetId : null, targetAccountId: accessible ? item.targetAccountId : null,
      expectedRevision: item.expectedRevision, status: accessible ? item.status : 'failed',
      errorCode: accessible ? item.errorCode : 'FORBIDDEN', errorMessage: accessible ? item.errorMessage : '对象已不可访问',
      resultRevision: accessible ? item.resultRevision : null }
  }))
  return credentialBatchSchema.parse({ batchId, kind: batch.kind, createdAt: batch.createdAt.toISOString(), items })
}

async function submit(db: Db, batchId: string, itemId: string, body: CredentialBatchItemSubmitBody,
  actor: AuditActor, sealed?: SealedSecret, protectedDigest?: string) {
  if (sealed && !protectedDigest) throw badRequest('CREDENTIAL_IDEMPOTENCY_REQUIRED', '密码提交需要受保护的内容校验')
  const requestDigest = protectedDigest ?? digest(body)
  try {
    await atomic(db, async (tx) => {
      await lockConsoleAuthorization(tx, actor.id)
      const { credentialBatches, credentialBatchItems } = schemaFor(tx)
      const [batch] = await tx.select().from(credentialBatches).where(and(eq(credentialBatches.id, batchId), eq(credentialBatches.actorConsoleAccountId, actor.id)))
      if (!batch) throw notFound('CREDENTIAL_BATCH_NOT_FOUND', '批次不存在')
      const [item] = await tx.select().from(credentialBatchItems).where(and(eq(credentialBatchItems.batchId, batchId), eq(credentialBatchItems.id, itemId))).for('update')
      if (!item) throw notFound('CREDENTIAL_BATCH_NOT_FOUND', '批次条目不存在')
      if (item.itemIdempotencyKey !== body.idempotencyKey || (item.requestDigest && item.requestDigest !== requestDigest)) {
        throw conflict('CREDENTIAL_IDEMPOTENCY_CONFLICT', '同一条目不能提交不同内容，请重新核对')
      }
      const binding = await assertCredentialAccess(tx, item.credentialId, actor.id, 'credential:write')
      if (batch.source === 'excel') await assertCredentialAccess(tx, item.credentialId, actor.id, 'credential:import')
      if (binding.accountId !== item.targetAccountId || binding.targetId !== item.targetId) throw badRequest('CREDENTIAL_BINDING_MISMATCH', '目标与账号绑定已变化')
      if (item.status === 'succeeded') return
      if (batch.kind === 'password_replace') {
        if (!sealed || !body.validity) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '请填写密码及有效期')
        await replaceCredentialMaterial(tx, item.credentialId, { expectedRevision: item.expectedRevision, validity: body.validity }, actor, sealed)
      } else {
        if (sealed || body.password !== undefined) throw badRequest('CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '维护信息批次不能提交密码')
        await updateCredentialMetadata(tx, item.credentialId, { expectedRevision: item.expectedRevision, validity: body.validity,
          startedAt: body.startedAt, ownerConsoleAccountId: body.ownerConsoleAccountId, tags: body.tags }, actor)
      }
      const latest = await getCredential(tx, item.credentialId, actor)
      await tx.update(credentialBatchItems).set({ status: 'succeeded', requestDigest, resultRevision: latest.revision,
        errorCode: null, errorMessage: null, updatedAt: await clockNow(tx) }).where(eq(credentialBatchItems.id, itemId))
    })
  } catch (error) {
    if (!(error instanceof DomainError) || error.code === 'CREDENTIAL_IDEMPOTENCY_CONFLICT') throw error
    // The failed mutation has rolled back before its receipt is persisted.
    await atomic(db, async (tx) => {
      await lockConsoleAuthorization(tx, actor.id)
      const { credentialBatches, credentialBatchItems } = schemaFor(tx)
      const [batch] = await tx.select().from(credentialBatches).where(and(eq(credentialBatches.id, batchId), eq(credentialBatches.actorConsoleAccountId, actor.id)))
      if (!batch) throw error
      const [item] = await tx.select().from(credentialBatchItems).where(and(eq(credentialBatchItems.batchId, batchId), eq(credentialBatchItems.id, itemId))).for('update')
      if (!item || item.itemIdempotencyKey !== body.idempotencyKey) throw error
      if (item.status === 'succeeded') return
      if (item.requestDigest && item.requestDigest !== requestDigest) throw conflict('CREDENTIAL_IDEMPOTENCY_CONFLICT', '条目内容冲突')
      await tx.update(credentialBatchItems).set({ status: error.kind === 'conflict' ? 'conflict' : 'failed', requestDigest,
        errorCode: error.code, errorMessage: error.message.slice(0, 256), updatedAt: await clockNow(tx) }).where(eq(credentialBatchItems.id, itemId))
    })
  }
  return getCredentialBatch(db, batchId, actor)
}

export async function submitCredentialBatchItem(db: Db, batchId: string, itemId: string, body: CredentialBatchItemSubmitBody, actor: AuditActor) {
  if (body.password !== undefined) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '密码必须经秘密提供方加密')
  return submit(db, batchId, itemId, body, actor)
}

export async function submitSealedBatchPassword(db: Db, input: { batchId: string; itemId: string; sealed: SealedSecret;
  validity: CredentialBatchItemSubmitBody['validity']; startedAt?: string; idempotencyKey: string; requestDigest: string; actor: AuditActor }) {
  return submit(db, input.batchId, input.itemId, { idempotencyKey: input.idempotencyKey, validity: input.validity, startedAt: input.startedAt }, input.actor, input.sealed, input.requestDigest)
}
