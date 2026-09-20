import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  type AnyColumn,
} from 'drizzle-orm'
import {
  DEFAULT_SERVICE_WEBHOOK_MAX_ATTEMPTS,
  MAP_SCHEDULER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  servicePlaygroundRunBodySchema,
  serviceWebhookDeliveryListSchema,
  serviceWebhookDeliveryQuerySchema,
  serviceWebhookDeliverySchema,
  serviceWebhookPayloadSchema,
  serviceWebhookRetryDelayMs,
  serviceWebhookSchema,
  serviceWebhookWriteSchema,
  jsonValueSchema,
  type JsonValue,
  type ServicePlaygroundRunBody,
  type ServiceWebhookDeliveryQuery,
  type ServiceWebhookDto,
  type ServiceWebhookEvent,
  type ServiceWebhookPayload,
  type ServiceWebhookWrite,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { actorPermissions } from '../credentials/access.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertIgnoreRows, locked, schemaFor } from '../native.js'
import { upsertStandaloneSecret } from '../secrets/store.js'
import { badRequest, conflict, forbidden, notFound } from '../runs/errors.js'
import { createServiceRun } from './access.js'

const CLAIM_TTL_MS = 60_000
const DEFAULT_SCAN_LIMIT = 100
const MAX_OUTPUTS = 100
const MAX_OUTPUT_BYTES = 32 * 1024

type WebhookRow = typeof import('../schema/service-webhooks.js').serviceWebhooks.$inferSelect
type DeliveryRow =
  typeof import('../schema/service-webhooks.js').serviceWebhookDeliveries.$inferSelect

export type ServiceWebhookClaim = {
  deliveryId: string
  workerId: string
  instanceId: string
  epoch: number
}
export type ServiceWebhookJob = ServiceWebhookClaim & {
  delivery: DeliveryRow
  webhook: WebhookRow
}

const iso = (value: Date | null) => value?.toISOString() ?? null

async function assertConsolePermissions(
  db: Db,
  actorId: string,
  required: readonly string[],
) {
  await lockConsoleAuthorization(db, actorId)
  const permissions = await actorPermissions(db, actorId)
  if (!required.every((permission) => permissions.includes(permission)))
    throw forbidden('FORBIDDEN', '当前账号没有执行此服务管理操作的权限')
}

async function callerRow(db: Db, callerId: string) {
  const { serviceCallers } = schemaFor(db)
  const [caller] = await locked(
    db,
    db.select().from(serviceCallers).where(eq(serviceCallers.id, callerId)),
  )
  if (!caller) throw notFound('SERVICE_NOT_FOUND', '服务调用方不存在')
  return caller
}

/** Reject enabling callbacks while an old, live maintenance/executor Worker could ignore them. */
export async function assertServiceWebhookWriterRollout(tx: Db) {
  const { workers } = schemaFor(tx)
  const now = await clockNow(tx)
  const live = await tx
    .select({ protocols: workers.protocolCapabilities })
    .from(workers)
    .where(
      and(
        inArray(workers.status, ['READY', 'DRAINING']),
        or(isNull(workers.heartbeatExpiresAt), gt(workers.heartbeatExpiresAt, now)),
      ),
    )
  const schedulerOnly = (protocols: string[]) =>
    protocols.length > 0 &&
    protocols.every((protocol) =>
      [MAP_SCHEDULER_PROTOCOL, SUITE_SCHEDULER_PROTOCOL].includes(protocol as typeof MAP_SCHEDULER_PROTOCOL),
    )
  if (
    live.some(
      (worker) =>
        !worker.protocols.includes(SERVICE_WEBHOOK_DELIVERY_PROTOCOL) &&
        !schedulerOnly(worker.protocols),
    )
  )
    throw conflict(
      'SERVICE_WEBHOOK_ROLLOUT_REQUIRED',
      '仍有旧版 Worker 在线，请完成停写升级后启用 Webhook',
    )
}

function assertCallerWritable(caller: { archivedAt: Date | null }) {
  if (caller.archivedAt)
    throw conflict('SERVICE_ARCHIVED', '服务调用方已归档，不能修改 Webhook 配置')
}

function webhookDto(row: WebhookRow): ServiceWebhookDto {
  return serviceWebhookSchema.parse({
    id: row.id,
    callerId: row.callerId,
    url: row.url,
    host: new URL(row.url).hostname,
    events: row.events,
    status: row.status,
    secretConfigured: Boolean(row.secretId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function deliveryDto(row: DeliveryRow) {
  return serviceWebhookDeliverySchema.parse({
    id: row.id,
    webhookId: row.webhookId,
    callerId: row.callerId,
    runId: row.runId,
    eventType: row.eventType,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    replayCount: row.replayCount,
    nextRetryAt: iso(row.nextRetryAt),
    lastResponseCode: row.lastResponseCode,
    lastResponseBody: row.lastResponseBody,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

export async function getServiceWebhook(
  db: Db,
  callerId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:read'])
    await callerRow(tx, callerId)
    const { serviceWebhooks } = schemaFor(tx)
    const [webhook] = await tx
      .select()
      .from(serviceWebhooks)
      .where(eq(serviceWebhooks.callerId, callerId))
      .limit(1)
    return webhook ? webhookDto(webhook) : null
  })
}

/** The API asks for this only to encrypt a replacement with a stable AAD id. */
export async function getServiceWebhookSecretId(
  db: Db,
  callerId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:write'])
    const caller = await callerRow(tx, callerId)
    assertCallerWritable(caller)
    const { serviceWebhooks } = schemaFor(tx)
    const [row] = await tx
      .select({ secretId: serviceWebhooks.secretId })
      .from(serviceWebhooks)
      .where(eq(serviceWebhooks.callerId, callerId))
      .limit(1)
    return row?.secretId ?? null
  })
}

export async function saveServiceWebhook(
  db: Db,
  callerId: string,
  body: ServiceWebhookWrite,
  actor: AuditActor,
  sealedSecret?: { id: string; ciphertext: Buffer },
) {
  const value = serviceWebhookWriteSchema.parse(body)
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:write'])
    const caller = await callerRow(tx, callerId)
    assertCallerWritable(caller)
    const { serviceWebhooks, serviceWebhookDeliveries } = schemaFor(tx)
    const [current] = await locked(
      tx,
      tx
        .select()
        .from(serviceWebhooks)
        .where(eq(serviceWebhooks.callerId, callerId)),
    )
    if (!current && !sealedSecret)
      throw badRequest('WEBHOOK_SECRET_REQUIRED', '首次登记 Webhook 必须填写签名密钥')
    if (current && sealedSecret && current.secretId !== sealedSecret.id)
      throw conflict(
        'WEBHOOK_SECRET_ROTATED',
        'Webhook 签名密钥已被其他管理员更新，请刷新后重试',
      )
    if (value.enabled) await assertServiceWebhookWriterRollout(tx)
    if (sealedSecret) await upsertStandaloneSecret(tx, sealedSecret)
    const now = await clockNow(tx)
    const status: 'active' | 'disabled' = value.enabled ? 'active' : 'disabled'
    const configurationChanged = Boolean(
      current &&
        (current.url !== value.url ||
          current.events.length !== value.events.length ||
          current.events.some((event) => !value.events.includes(event)) ||
          sealedSecret),
    )
    const enabledAt = value.enabled
      ? current?.status === 'active' && !configurationChanged
        ? current.enabledAt ?? now
        : now
      : null
    let saved: WebhookRow | undefined
    if (current) {
      await tx
        .update(serviceWebhooks)
        .set({
          url: value.url,
          events: value.events,
          status,
          enabledAt,
          ...(sealedSecret ? { secretId: sealedSecret.id } : {}),
          updatedAt: now,
        })
        .where(eq(serviceWebhooks.id, current.id))
      if (!value.enabled || configurationChanged) {
        // A changed endpoint/key must not receive events accrued under the old
        // configuration. An already-submitted request cannot be recalled; its
        // completion is fenced by this status transition.
        await tx
          .update(serviceWebhookDeliveries)
          .set({
            status: 'dead_letter',
            nextRetryAt: null,
            lastError: value.enabled
              ? 'webhook_reconfigured'
              : 'webhook_disabled',
            claimOwner: null,
            claimInstance: null,
            claimExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(serviceWebhookDeliveries.webhookId, current.id),
              inArray(serviceWebhookDeliveries.status, ['pending', 'retrying', 'sending']),
            ),
          )
      }
      ;[saved] = await tx
        .select()
        .from(serviceWebhooks)
        .where(eq(serviceWebhooks.id, current.id))
    } else {
      const id = newId()
      await tx.insert(serviceWebhooks).values({
        id,
        callerId,
        url: value.url,
        secretId: sealedSecret!.id,
        events: value.events,
        status,
        enabledAt,
        createdAt: now,
        updatedAt: now,
      })
      ;[saved] = await tx
        .select()
        .from(serviceWebhooks)
        .where(eq(serviceWebhooks.id, id))
    }
    if (!saved) throw new Error('Webhook 保存后未能读取配置')
    await recordAudit(
      tx,
      actor,
      current ? 'service.webhook.update' : 'service.webhook.create',
      'service',
      callerId,
      `${current ? '更新' : '登记'}服务 Webhook ${saved.id}`,
    )
    return webhookDto(saved)
  })
}

export async function listServiceWebhookDeliveries(
  db: Db,
  callerId: string,
  query: ServiceWebhookDeliveryQuery,
  actor: AuditActor,
) {
  const value = serviceWebhookDeliveryQuerySchema.parse(query)
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:read'])
    await callerRow(tx, callerId)
    const { serviceWebhookDeliveries } = schemaFor(tx)
    const [cursor] = value.cursor
      ? await tx
          .select({ id: serviceWebhookDeliveries.id, createdAt: serviceWebhookDeliveries.createdAt })
          .from(serviceWebhookDeliveries)
          .where(
            and(
              eq(serviceWebhookDeliveries.id, value.cursor),
              eq(serviceWebhookDeliveries.callerId, callerId),
            ),
          )
          .limit(1)
      : []
    if (value.cursor && !cursor)
      throw badRequest('SERVICE_WEBHOOK_CURSOR_INVALID', '分页游标无效，请从首页重新查询')
    const rows = await tx
      .select()
      .from(serviceWebhookDeliveries)
      .where(
        and(
          eq(serviceWebhookDeliveries.callerId, callerId),
          value.status ? eq(serviceWebhookDeliveries.status, value.status) : undefined,
          cursor
            ? or(
                lt(serviceWebhookDeliveries.createdAt, cursor.createdAt),
                and(
                  eq(serviceWebhookDeliveries.createdAt, cursor.createdAt),
                  lt(serviceWebhookDeliveries.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(serviceWebhookDeliveries.createdAt), desc(serviceWebhookDeliveries.id))
      .limit(value.limit + 1)
    const items = rows.slice(0, value.limit)
    return serviceWebhookDeliveryListSchema.parse({
      items: items.map(deliveryDto),
      nextCursor: rows.length > value.limit ? items.at(-1)?.id : undefined,
    })
  })
}

export async function retryServiceWebhookDelivery(
  db: Db,
  callerId: string,
  deliveryId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:write'])
    const caller = await callerRow(tx, callerId)
    assertCallerWritable(caller)
    const { serviceWebhooks, serviceWebhookDeliveries } = schemaFor(tx)
    const [delivery] = await locked(
      tx,
      tx
        .select()
        .from(serviceWebhookDeliveries)
        .where(
          and(
            eq(serviceWebhookDeliveries.id, deliveryId),
            eq(serviceWebhookDeliveries.callerId, callerId),
          ),
        ),
    )
    if (!delivery)
      throw notFound('SERVICE_WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook 投递记录不存在')
    if (delivery.status !== 'dead_letter')
      throw conflict('SERVICE_WEBHOOK_DELIVERY_NOT_DEAD', '只有死信投递可以手动重新推送')
    const [webhook] = await tx
      .select()
      .from(serviceWebhooks)
      .where(eq(serviceWebhooks.id, delivery.webhookId))
      .limit(1)
    if (!webhook || webhook.status !== 'active')
      throw conflict('SERVICE_WEBHOOK_DISABLED', 'Webhook 未启用，不能重新推送')
    const now = await clockNow(tx)
    await tx
      .update(serviceWebhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        replayCount: delivery.replayCount + 1,
        nextRetryAt: now,
        lastResponseCode: null,
        lastResponseBody: null,
        lastError: null,
        claimOwner: null,
        claimInstance: null,
        claimExpiresAt: null,
        submittedAt: null,
        updatedAt: now,
      })
      .where(eq(serviceWebhookDeliveries.id, delivery.id))
    const [saved] = await tx
      .select()
      .from(serviceWebhookDeliveries)
      .where(eq(serviceWebhookDeliveries.id, delivery.id))
    await recordAudit(
      tx,
      actor,
      'service.webhook.retry',
      'service_webhook_delivery',
      delivery.id,
      `手动重新推送 Webhook 投递 ${delivery.id}`,
    )
    return deliveryDto(saved!)
  })
}

function eventForRun(row: {
  status: string
  startedAt: Date | null
  finishedAt: Date | null
}): Array<{ event: ServiceWebhookEvent; occurredAt: Date }> {
  const events: Array<{ event: ServiceWebhookEvent; occurredAt: Date }> = []
  if (row.startedAt) events.push({ event: 'run.started', occurredAt: row.startedAt })
  if (row.finishedAt && row.status === 'SUCCEEDED')
    events.push({ event: 'run.completed', occurredAt: row.finishedAt })
  if (row.finishedAt && row.status === 'FAILED')
    events.push({ event: 'run.failed', occurredAt: row.finishedAt })
  if (row.finishedAt && row.status === 'CANCELLED')
    events.push({ event: 'run.cancelled', occurredAt: row.finishedAt })
  return events
}

function publicRunStatus(status: string) {
  if (status === 'SUCCEEDED') return 'COMPLETED' as const
  if (status === 'FAILED') return 'FAILED' as const
  if (status === 'CANCELLED') return 'CANCELLED' as const
  return 'RUNNING' as const
}

function outputPayload(value: unknown): { value: JsonValue; size: number } | null {
  try {
    const parsed = jsonValueSchema.safeParse(value)
    if (!parsed.success) return null
    const encoded = JSON.stringify(value)
    if (!encoded || Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) return null
    return { value: parsed.data, size: Buffer.byteLength(encoded) }
  } catch {
    return null
  }
}

async function buildWebhookPayload(
  db: Db,
  input: {
    id: string
    event: ServiceWebhookEvent
    occurredAt: Date
    callerId: string
    run: {
      id: string
      idempotencyKey: string | null
      status: string
      scenarioId: string
      scenarioVersionId: string
      targetId: string
      targetAccountId: string | null
      startedAt: Date | null
      finishedAt: Date | null
      evidenceStatus: string
    }
  },
): Promise<ServiceWebhookPayload> {
  const { evidences, stepRuns } = schemaFor(db)
  const startedEvent = input.event === 'run.started'
  const [outputRows, available] = startedEvent
    ? [[], 0] as const
    : await Promise.all([
        db
          .select({ name: stepRuns.name, ordinal: stepRuns.ordinal, payload: evidences.payload })
          .from(evidences)
          .innerJoin(stepRuns, eq(stepRuns.id, evidences.stepRunId))
          .where(
            and(
              eq(evidences.runId, input.run.id),
              eq(evidences.type, 'output'),
              eq(evidences.status, 'available'),
              eq(evidences.externalAccess, 1),
            ),
          )
          .orderBy(asc(stepRuns.ordinal), asc(evidences.createdAt)),
        db
          .select({ total: count() })
          .from(evidences)
          .where(and(eq(evidences.runId, input.run.id), eq(evidences.status, 'available'))),
      ]).then(([rows, totals]) => [rows, Number(totals[0]?.total ?? 0)] as const)
  let bytes = 0
  const outputs: Array<{ stepName: string; payload: JsonValue }> = []
  for (const row of outputRows) {
    if (outputs.length >= MAX_OUTPUTS) break
    const payload = outputPayload(row.payload)
    if (!payload || bytes + payload.size > MAX_OUTPUT_BYTES) continue
    bytes += payload.size
    outputs.push({ stepName: row.name ?? `步骤 ${row.ordinal + 1}`, payload: payload.value })
  }
  const durationSeconds =
    !startedEvent && input.run.startedAt && input.run.finishedAt
      ? Math.max(0, Math.floor((input.run.finishedAt.getTime() - input.run.startedAt.getTime()) / 1000))
      : null
  return serviceWebhookPayloadSchema.parse({
    id: input.id,
    event: input.event,
    timestamp: input.occurredAt.toISOString(),
    callerId: input.callerId,
    data: {
      runId: input.run.id,
      idempotencyKey: input.run.idempotencyKey,
      status: startedEvent ? 'RUNNING' : publicRunStatus(input.run.status),
      scenarioId: input.run.scenarioId,
      scenarioVersionId: input.run.scenarioVersionId,
      targetId: input.run.targetId,
      targetAccountId: input.run.targetAccountId,
      startedAt: iso(input.run.startedAt),
      finishedAt: startedEvent ? null : iso(input.run.finishedAt),
      durationSeconds,
      outputs,
      evidenceSummary: {
        status: startedEvent ? 'PENDING' : input.run.evidenceStatus,
        availableCount: available,
      },
    },
  })
}

function missingEventCondition(
  db: Db,
  webhookId: string,
  event: ServiceWebhookEvent,
  runId: AnyColumn,
) {
  const { serviceWebhookDeliveries } = schemaFor(db)
  return notExists(
    db
      .select({ id: serviceWebhookDeliveries.id })
      .from(serviceWebhookDeliveries)
      .where(
        and(
          eq(serviceWebhookDeliveries.webhookId, webhookId),
          eq(serviceWebhookDeliveries.runId, runId),
          eq(serviceWebhookDeliveries.eventType, event),
        ),
      ),
  )
}

/**
 * Repairs/creates event facts from persisted Run transitions.  It deliberately
 * never changes a Run, so a damaged or unavailable callback endpoint cannot
 * alter execution outcome facts.
 */
export async function enqueueServiceWebhookDeliveries(
  db: Db,
  input: { now?: Date; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_SCAN_LIMIT, DEFAULT_SCAN_LIMIT))
  return atomic(db, async (tx) => {
    const now = input.now ?? (await clockNow(tx))
    const { serviceWebhooks, runs, serviceWebhookDeliveries } = schemaFor(tx)
    const webhooks = await tx
      .select()
      .from(serviceWebhooks)
      .where(and(eq(serviceWebhooks.status, 'active'), isNotNull(serviceWebhooks.enabledAt)))
      .orderBy(asc(serviceWebhooks.createdAt), asc(serviceWebhooks.id))
    let inserted = 0
    for (const webhook of webhooks) {
      if (inserted >= limit) break
      const enabledAt = webhook.enabledAt!
      const conditions = webhook.events.flatMap((event) => {
        if (event === 'run.started')
          return [
            and(
              isNotNull(runs.startedAt),
              gte(runs.startedAt, enabledAt),
              missingEventCondition(tx, webhook.id, event, runs.id),
            ),
          ]
        const status =
          event === 'run.completed'
            ? 'SUCCEEDED'
            : event === 'run.failed'
              ? 'FAILED'
              : 'CANCELLED'
        return [
          and(
            eq(runs.status, status),
            isNotNull(runs.finishedAt),
            gte(runs.finishedAt, enabledAt),
            missingEventCondition(tx, webhook.id, event, runs.id),
          ),
        ]
      })
      if (!conditions.length) continue
      const candidates = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.serviceCallerId, webhook.callerId),
            isNull(runs.deletedAt),
            or(...conditions),
          ),
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(limit - inserted)
      for (const run of candidates) {
        for (const occurrence of eventForRun(run)) {
          if (inserted >= limit || !webhook.events.includes(occurrence.event)) continue
          if (occurrence.occurredAt < enabledAt) continue
          const id = newId()
          const payload = await buildWebhookPayload(tx, {
            id,
            event: occurrence.event,
            occurredAt: occurrence.occurredAt,
            callerId: webhook.callerId,
            run,
          })
          inserted += await insertIgnoreRows(tx, serviceWebhookDeliveries, {
            id,
            webhookId: webhook.id,
            callerId: webhook.callerId,
            runId: run.id,
            eventType: occurrence.event,
            payload,
            status: 'pending',
            attempts: 0,
            maxAttempts: DEFAULT_SERVICE_WEBHOOK_MAX_ATTEMPTS,
            replayCount: 0,
            nextRetryAt: now,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
    }
    return { inserted }
  })
}

async function liveWebhookWorker(db: Db, workerId: string, instanceId: string, now: Date) {
  const { workers } = schemaFor(db)
  const [worker] = await db
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.instanceId, instanceId)))
    .limit(1)
  return Boolean(
    worker &&
      worker.status === 'READY' &&
      (!worker.heartbeatExpiresAt || worker.heartbeatExpiresAt > now) &&
      worker.protocolCapabilities?.includes(SERVICE_WEBHOOK_DELIVERY_PROTOCOL),
  )
}

async function recoverExpiredClaims(tx: Db, now: Date) {
  const { serviceWebhookDeliveries } = schemaFor(tx)
  const rows = await tx
    .select()
    .from(serviceWebhookDeliveries)
    .where(and(eq(serviceWebhookDeliveries.status, 'sending'), lte(serviceWebhookDeliveries.claimExpiresAt, now)))
    .orderBy(asc(serviceWebhookDeliveries.claimExpiresAt), asc(serviceWebhookDeliveries.id))
    .limit(DEFAULT_SCAN_LIMIT)
  for (const row of rows) {
    const exhausted = row.attempts >= row.maxAttempts
    await tx
      .update(serviceWebhookDeliveries)
      .set({
        status: exhausted ? 'dead_letter' : 'retrying',
        nextRetryAt: exhausted ? null : now,
        lastError: exhausted ? 'delivery_receipt_unknown' : 'delivery_claim_expired',
        claimOwner: null,
        claimInstance: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(serviceWebhookDeliveries.id, row.id), eq(serviceWebhookDeliveries.status, 'sending')))
  }
}

export async function claimServiceWebhookDeliveries(
  db: Db,
  input: { workerId: string; instanceId: string; limit?: number; now?: Date },
): Promise<ServiceWebhookJob[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  return atomic(db, async (tx) => {
    const now = input.now ?? (await clockNow(tx))
    if (!(await liveWebhookWorker(tx, input.workerId, input.instanceId, now))) return []
    await recoverExpiredClaims(tx, now)
    const { serviceCallers, serviceWebhooks, serviceWebhookDeliveries } = schemaFor(tx)
    const rows = await locked(
      tx,
      tx
        .select({ delivery: serviceWebhookDeliveries, webhook: serviceWebhooks })
        .from(serviceWebhookDeliveries)
        .innerJoin(serviceWebhooks, eq(serviceWebhooks.id, serviceWebhookDeliveries.webhookId))
        .innerJoin(serviceCallers, eq(serviceCallers.id, serviceWebhookDeliveries.callerId))
        .where(
          and(
            inArray(serviceWebhookDeliveries.status, ['pending', 'retrying']),
            or(isNull(serviceWebhookDeliveries.nextRetryAt), lte(serviceWebhookDeliveries.nextRetryAt, now)),
            eq(serviceWebhooks.status, 'active'),
            eq(serviceCallers.status, 'active'),
            isNull(serviceCallers.archivedAt),
          ),
        )
        .orderBy(asc(serviceWebhookDeliveries.nextRetryAt), asc(serviceWebhookDeliveries.createdAt), asc(serviceWebhookDeliveries.id))
        .limit(limit),
      true,
    )
    const jobs: ServiceWebhookJob[] = []
    for (const row of rows) {
      const epoch = row.delivery.claimEpoch + 1
      const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS)
      await tx
        .update(serviceWebhookDeliveries)
        .set({
          status: 'sending',
          claimOwner: input.workerId,
          claimInstance: input.instanceId,
          claimEpoch: epoch,
          claimExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(serviceWebhookDeliveries.id, row.delivery.id),
            inArray(serviceWebhookDeliveries.status, ['pending', 'retrying']),
          ),
        )
      jobs.push({
        delivery: {
          ...row.delivery,
          status: 'sending',
          claimOwner: input.workerId,
          claimInstance: input.instanceId,
          claimEpoch: epoch,
          claimExpiresAt,
          updatedAt: now,
        },
        webhook: row.webhook,
        deliveryId: row.delivery.id,
        workerId: input.workerId,
        instanceId: input.instanceId,
        epoch,
      })
    }
    return jobs
  })
}

/** Marks the external-side-effect boundary and consumes one automatic attempt. */
export async function beginServiceWebhookSubmission(
  db: Db,
  claim: ServiceWebhookClaim,
) {
  return atomic(db, async (tx) => {
    const now = await clockNow(tx)
    if (!(await liveWebhookWorker(tx, claim.workerId, claim.instanceId, now))) return null
    const { serviceWebhookDeliveries } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(serviceWebhookDeliveries).where(eq(serviceWebhookDeliveries.id, claim.deliveryId)),
    )
    if (
      !row ||
      row.status !== 'sending' ||
      row.claimOwner !== claim.workerId ||
      row.claimInstance !== claim.instanceId ||
      row.claimEpoch !== claim.epoch ||
      row.claimExpiresAt === null ||
      row.claimExpiresAt <= now
    )
      return null
    if (row.attempts >= row.maxAttempts) {
      await tx
        .update(serviceWebhookDeliveries)
        .set({
          status: 'dead_letter',
          nextRetryAt: null,
          lastError: 'delivery_attempt_limit_reached',
          claimOwner: null,
          claimInstance: null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(serviceWebhookDeliveries.id, row.id))
      return null
    }
    await tx
      .update(serviceWebhookDeliveries)
      .set({ attempts: row.attempts + 1, submittedAt: now, updatedAt: now })
      .where(eq(serviceWebhookDeliveries.id, row.id))
    return { attempt: row.attempts + 1 }
  })
}

export async function finishServiceWebhookDelivery(
  db: Db,
  claim: ServiceWebhookClaim,
  result: {
    ok: boolean
    retryable?: boolean
    responseCode?: number | null
    responseBody?: string | null
    errorCode?: string | null
  },
) {
  return atomic(db, async (tx) => {
    const now = await clockNow(tx)
    const { serviceWebhookDeliveries } = schemaFor(tx)
    const [row] = await locked(
      tx,
      tx.select().from(serviceWebhookDeliveries).where(eq(serviceWebhookDeliveries.id, claim.deliveryId)),
    )
    if (
      !row ||
      row.status !== 'sending' ||
      row.claimOwner !== claim.workerId ||
      row.claimInstance !== claim.instanceId ||
      row.claimEpoch !== claim.epoch
    )
      return null
    const retry = !result.ok && Boolean(result.retryable) && row.attempts < row.maxAttempts
    const status = result.ok ? 'success' : retry ? 'retrying' : 'dead_letter'
    const nextRetryAt = retry
      ? new Date(now.getTime() + serviceWebhookRetryDelayMs(row.attempts))
      : null
    await tx
      .update(serviceWebhookDeliveries)
      .set({
        status,
        nextRetryAt,
        lastResponseCode: result.responseCode ?? null,
        lastResponseBody: result.responseBody ?? null,
        lastError: result.ok ? null : result.errorCode ?? 'webhook_delivery_failed',
        claimOwner: null,
        claimInstance: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(serviceWebhookDeliveries.id, row.id))
    const [saved] = await tx
      .select()
      .from(serviceWebhookDeliveries)
      .where(eq(serviceWebhookDeliveries.id, row.id))
    return deliveryDto(saved!)
  })
}

export async function createServicePlaygroundRun(
  db: Db,
  callerId: string,
  body: ServicePlaygroundRunBody,
  actor: AuditActor,
  requestId: string,
  hangWaitMs?: number,
) {
  const value = servicePlaygroundRunBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:write', 'run:execute'])
    const caller = await callerRow(tx, callerId)
    assertCallerWritable(caller)
    const { scenarios, serviceCredentials } = schemaFor(tx)
    const [scenario] = await tx
      .select({ targetId: scenarios.targetId })
      .from(scenarios)
      .where(and(eq(scenarios.id, value.scenarioId), isNull(scenarios.deletedAt)))
      .limit(1)
    if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
    await assertTargetPermission(tx, actor.id, scenario.targetId, 'run:execute')
    const [credential] = await tx
      .select()
      .from(serviceCredentials)
      .where(
        and(
          eq(serviceCredentials.id, value.credentialId),
          eq(serviceCredentials.callerId, callerId),
        ),
      )
      .limit(1)
    if (!credential) throw notFound('CREDENTIAL_NOT_FOUND', '服务凭据不存在')
    const { credentialId, ...runBody } = value
    return createServiceRun(
      tx,
      {
        kind: 'service',
        id: callerId,
        credentialId,
        scopes: credential.scopes,
      },
      runBody,
      requestId,
      undefined,
      hangWaitMs,
    )
  })
}

/** A valid OpenAPI 3 document plus a caller-scoped discovery extension. */
export async function buildServiceOpenApi(
  db: Db,
  callerId: string,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    await assertConsolePermissions(tx, actor.id, ['service:read'])
    await callerRow(tx, callerId)
    const {
      credentialTargetAccountGrants,
      credentialTargetGrants,
      scenarios,
      scenarioVersions,
      serviceCredentials,
      targets,
      targetAccounts,
    } = schemaFor(tx)
    const grants = await tx
      .select({
        credentialId: serviceCredentials.id,
        targetId: targets.id,
        targetName: targets.name,
        allowAnonymous: credentialTargetGrants.allowAnonymous,
      })
      .from(serviceCredentials)
      .innerJoin(credentialTargetGrants, eq(credentialTargetGrants.credentialId, serviceCredentials.id))
      .innerJoin(targets, eq(targets.id, credentialTargetGrants.targetId))
      .where(
        and(
          eq(serviceCredentials.callerId, callerId),
          eq(targets.status, 'active'),
          isNull(targets.deletedAt),
        ),
      )
      .orderBy(asc(targets.name), asc(targets.id))
    const catalog = await Promise.all(
      grants.map(async (grant) => {
        const [accounts, versions] = await Promise.all([
          tx
            .select({ id: targetAccounts.id, name: targetAccounts.displayName })
            .from(targetAccounts)
            .innerJoin(
              credentialTargetAccountGrants,
              eq(credentialTargetAccountGrants.targetAccountId, targetAccounts.id),
            )
            .where(
              and(
                eq(credentialTargetAccountGrants.credentialId, grant.credentialId),
                eq(credentialTargetAccountGrants.targetId, grant.targetId),
                isNull(targetAccounts.deletedAt),
                eq(targetAccounts.status, 'active'),
              ),
            )
            .orderBy(asc(targetAccounts.displayName), asc(targetAccounts.id)),
          tx
            .select({
              scenarioId: scenarios.id,
              scenarioName: scenarios.name,
              scenarioVersionId: scenarioVersions.id,
              versionNo: scenarioVersions.versionNo,
              inputs: scenarioVersions.definition,
            })
            .from(scenarios)
            .innerJoin(scenarioVersions, eq(scenarioVersions.scenarioId, scenarios.id))
            .where(
              and(
                eq(scenarios.targetId, grant.targetId),
                eq(scenarios.status, 'active'),
                isNull(scenarios.deletedAt),
                eq(scenarioVersions.kind, 'published'),
              ),
            )
            .orderBy(asc(scenarios.name), desc(scenarioVersions.versionNo)),
        ])
        return {
          credentialId: grant.credentialId,
          targetId: grant.targetId,
          targetName: grant.targetName,
          allowAnonymous: grant.allowAnonymous === 1,
          accounts,
          scenarios: versions.map((version) => ({
            scenarioId: version.scenarioId,
            scenarioName: version.scenarioName,
            scenarioVersionId: version.scenarioVersionId,
            versionNo: version.versionNo,
            inputs: version.inputs.inputs ?? [],
          })),
        }
      }),
    )
    return {
      openapi: '3.0.3',
      info: {
        title: 'Cairn 受控执行 API',
        version: 'v1',
        description: '此文档只列出当前服务调用方被授权的目标与已发布场景。',
      },
      servers: [{ url: '/api/open/v1' }],
      paths: {
        '/runs': {
          post: {
            operationId: 'createRun',
            summary: '发起一次受控执行',
            security: [{ bearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CreateRunRequest' },
                },
              },
            },
            responses: {
              '201': { description: '已受理' },
              '200': { description: '幂等命中已有运行' },
              '400': { description: '请求无效' },
              '403': { description: '凭据权限不足' },
            },
          },
        },
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        schemas: {
          CreateRunRequest: {
            type: 'object',
            required: ['scenarioId', 'scenarioVersionId', 'idempotencyKey'],
            properties: {
              scenarioId: { type: 'string', format: 'uuid' },
              scenarioVersionId: { type: 'string', format: 'uuid' },
              targetAccountId: { type: 'string', format: 'uuid' },
              idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
              input: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      'x-cairn-authorized-catalog': catalog,
    }
  })
}
