import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, count, eq, gt, inArray, or, sql } from 'drizzle-orm'
import {
  stepUsesBrowser,
  externalRunBodySchema,
  externalRunSchema,
  hasAiSteps,
  isAiCallEvidence,
  issueServiceCredentialSchema,
  serviceAdmissionSchema,
  serviceCallerBodySchema,
  serviceCallerDetailSchema,
  serviceCallerListSchema,
  serviceCredentialPolicySchema,
  serviceCredentialSchema,
  servicePageQuerySchema,
  servicePrincipalSchema,
  type AiExecutionConfig,
  type ExternalRunBody,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCredentialPolicy,
  type ServicePageQuery,
  type ServicePrincipal,
  type ServiceScope,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, locked, schemaFor } from '../native.js'
import { newId } from '../id.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { badRequest, conflict, DomainError, forbidden, notFound } from '../runs/errors.js'
import { createRunWithSnapshot, getRun, requestRunCancel } from '../runs/runs.js'
import { sha256Hex } from '../runs/digest.js'

const outstanding = ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW'] as const
const denied = () =>
  new DomainError('unauthorized', 'SERVICE_CREDENTIAL_INVALID', '服务凭据无效或已停用')
const digestSecret = (secret: string) =>
  createHash('sha256').update('cairn-service-key-v1\0').update(secret).digest()
const iso = (d: Date | null) => d?.toISOString() ?? null
function page<T extends { id: string }>(rows: T[], limit: number) {
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
  }
}
async function callerRow(db: Db, id: string) {
  const { serviceCallers } = schemaFor(db)
  // ponytail: one lock per caller serializes admission and governance; split only if measured throughput requires it.
  const [row] = await locked(db, db.select().from(serviceCallers).where(eq(serviceCallers.id, id)))
  if (!row) throw notFound('SERVICE_NOT_FOUND', '服务调用方不存在')
  return row
}
async function credentialRow(db: Db, callerId: string, id: string) {
  const { serviceCredentials } = schemaFor(db)
  const [row] = await db
    .select()
    .from(serviceCredentials)
    .where(and(eq(serviceCredentials.id, id), eq(serviceCredentials.callerId, callerId)))
  if (!row) throw notFound('CREDENTIAL_NOT_FOUND', '服务凭据不存在')
  return row
}
async function credentialDto(db: Db, row: Awaited<ReturnType<typeof credentialRow>>) {
  const { credentialTargetGrants: tg, credentialTargetAccountGrants: ag } = schemaFor(db)
  const grants = await db.select().from(tg).where(eq(tg.credentialId, row.id))
  const accounts = await db.select().from(ag).where(eq(ag.credentialId, row.id))
  const now = await clockNow(db)
  return serviceCredentialSchema.parse({
    ...row,
    status: row.revokedAt ? 'revoked' : row.expiresAt <= now ? 'expired' : 'active',
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    lastUsedAt: iso(row.lastUsedAt),
    grants: grants.map((g) => ({
      targetId: g.targetId,
      allowAnonymous: g.allowAnonymous === 1,
      accountIds: accounts.filter((a) => a.targetId === g.targetId).map((a) => a.targetAccountId),
    })),
  })
}
async function callerDto(db: Db, row: Awaited<ReturnType<typeof callerRow>>) {
  const { runs, serviceCredentials } = schemaFor(db)
  const [n] = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.serviceCallerId, row.id), inArray(runs.status, [...outstanding])))
  const [c] = await db
    .select({ n: count() })
    .from(serviceCredentials)
    .where(eq(serviceCredentials.callerId, row.id))
  return {
    ...row,
    outstandingRuns: Number(n!.n),
    credentialCount: Number(c!.n),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}
export async function listServiceCallers(db: Db, query: ServicePageQuery) {
  const q = servicePageQuerySchema.parse(query),
    { serviceCallers } = schemaFor(db)
  const rows = await db
    .select()
    .from(serviceCallers)
    .where(q.cursor ? gt(serviceCallers.id, q.cursor) : undefined)
    .orderBy(asc(serviceCallers.id))
    .limit(q.limit + 1)
  const result = page(rows, q.limit)
  return serviceCallerListSchema.parse({
    ...result,
    items: await Promise.all(result.items.map((r) => callerDto(db, r))),
  })
}
export async function getServiceCaller(db: Db, id: string) {
  const { serviceCredentials } = schemaFor(db)
  const caller = await callerRow(db, id)
  const credentials = await db
    .select()
    .from(serviceCredentials)
    .where(eq(serviceCredentials.callerId, id))
    .orderBy(asc(serviceCredentials.createdAt))
  return serviceCallerDetailSchema.parse({
    caller: await callerDto(db, caller),
    credentials: await Promise.all(credentials.map((c) => credentialDto(db, c))),
  })
}
export async function saveServiceCaller(
  db: Db,
  id: string | null,
  body: ServiceCallerBody,
  actor: AuditActor,
) {
  const value = serviceCallerBodySchema.parse(body),
    callerId = id ?? newId()
  await atomic(db, async (tx) => {
    const { serviceCallers } = schemaFor(tx),
      now = await clockNow(tx)
    if (id) {
      await callerRow(tx, id)
      await tx
        .update(serviceCallers)
        .set({ ...value, updatedAt: now })
        .where(eq(serviceCallers.id, id))
    } else
      await tx
        .insert(serviceCallers)
        .values({ id: callerId, ...value, createdAt: now, updatedAt: now })
    await recordAudit(
      tx,
      actor,
      id ? 'service.update' : 'service.create',
      'service',
      callerId,
      id ? '更新服务调用方与资源限制' : '创建服务调用方',
    )
  })
  return getServiceCaller(db, callerId)
}
async function replaceGrants(
  db: Db,
  credentialId: string,
  grants: ServiceCredentialPolicy['grants'],
) {
  const {
    credentialTargetGrants: tg,
    credentialTargetAccountGrants: ag,
    targets,
    targetAccounts,
  } = schemaFor(db)
  for (const g of grants) {
    const [t] = await db.select({ id: targets.id }).from(targets).where(eq(targets.id, g.targetId))
    if (!t) throw badRequest('GRANT_TARGET_INVALID', '授权目标不存在')
    if (g.accountIds.length) {
      const accounts = await db
        .select({ id: targetAccounts.id })
        .from(targetAccounts)
        .where(
          and(eq(targetAccounts.targetId, g.targetId), inArray(targetAccounts.id, g.accountIds)),
        )
      if (accounts.length !== g.accountIds.length)
        throw badRequest('GRANT_ACCOUNT_MISMATCH', '授权账号不属于目标系统')
    }
  }
  await db.delete(ag).where(eq(ag.credentialId, credentialId))
  await db.delete(tg).where(eq(tg.credentialId, credentialId))
  for (const g of grants) {
    await db
      .insert(tg)
      .values({ credentialId, targetId: g.targetId, allowAnonymous: g.allowAnonymous ? 1 : 0 })
    if (g.accountIds.length)
      await db.insert(ag).values(
        g.accountIds.map((targetAccountId) => ({
          credentialId,
          targetId: g.targetId,
          targetAccountId,
        })),
      )
  }
}
export async function issueServiceCredential(
  db: Db,
  callerId: string,
  body: IssueServiceCredential,
  actor: AuditActor,
) {
  const value = issueServiceCredentialSchema.parse(body),
    id = newId(),
    secret = randomBytes(32).toString('base64url')
  const credential = await atomic(db, async (tx) => {
    const { serviceCredentials } = schemaFor(tx)
    await callerRow(tx, callerId)
    const [total] = await tx
      .select({ n: count() })
      .from(serviceCredentials)
      .where(eq(serviceCredentials.callerId, callerId))
    if (Number(total!.n) >= 200)
      throw conflict('CREDENTIAL_LIMIT', '每个调用方最多保留 200 个凭据，请建立新的调用方')
    const now = await clockNow(tx)
    await tx.insert(serviceCredentials).values({
      id,
      callerId,
      name: value.name,
      scopes: value.scopes,
      secretDigest: digestSecret(secret).toString('hex'),
      expiresAt: new Date(now.getTime() + value.expiresInDays * 86400000),
      createdByConsoleAccountId: actor.id,
      createdAt: now,
    })
    await replaceGrants(tx, id, value.grants)
    await recordAudit(tx, actor, 'credential.issue', 'service', callerId, `签发凭据 ${id}`)
    return credentialDto(tx, await credentialRow(tx, callerId, id))
  })
  return { credential, token: `cairn_sk_${id}.${secret}` }
}
export async function updateServiceCredential(
  db: Db,
  callerId: string,
  id: string,
  body: ServiceCredentialPolicy | null,
  actor: AuditActor,
) {
  const value = body === null ? null : serviceCredentialPolicySchema.parse(body)
  return atomic(db, async (tx) => {
    const { serviceCredentials } = schemaFor(tx)
    await callerRow(tx, callerId)
    const current = await credentialRow(tx, callerId, id),
      now = await clockNow(tx)
    if (value && (current.revokedAt || current.expiresAt <= now))
      throw conflict('CREDENTIAL_INACTIVE', '已吊销或过期凭据不可修改')
    await tx
      .update(serviceCredentials)
      .set({
        ...(value
          ? { name: value.name, scopes: value.scopes }
          : { revokedAt: current.revokedAt ?? now }),
        revision: current.revision + 1,
      })
      .where(eq(serviceCredentials.id, id))
    if (value) await replaceGrants(tx, id, value.grants)
    await recordAudit(
      tx,
      actor,
      value ? 'credential.update' : 'credential.revoke',
      'service',
      callerId,
      `${value ? '更新' : '吊销'}凭据 ${id}`,
    )
    return credentialDto(tx, await credentialRow(tx, callerId, id))
  })
}
async function access(db: Db, raw: ServicePrincipal, required: ServiceScope[]) {
  const actor = servicePrincipalSchema.parse(raw)
  const caller = await callerRow(db, actor.id),
    credential = await credentialRow(db, actor.id, actor.credentialId),
    now = await clockNow(db)
  if (caller.status !== 'active' || credential.revokedAt || credential.expiresAt <= now)
    throw denied()
  if (!required.every((s) => credential.scopes.includes(s)))
    throw forbidden('SERVICE_SCOPE_DENIED', '服务凭据缺少所需权限')
  return { caller, credential, now, actor: { ...actor, scopes: credential.scopes } }
}
export async function authenticateService(
  db: Db,
  authorization: string | undefined,
): Promise<ServicePrincipal> {
  const m = /^Bearer cairn_sk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')
  if (!m || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m[1]!))
    throw denied()
  const { serviceCredentials } = schemaFor(db)
  const [found] = await db.select().from(serviceCredentials).where(eq(serviceCredentials.id, m[1]!))
  const actual = digestSecret(m[2]!),
    expected = Buffer.from(found?.secretDigest ?? '0'.repeat(64), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !found)
    throw denied()
  const outcome = await atomic(db, async (tx) => {
    const { serviceCallers, serviceCredentials } = schemaFor(tx)
    const { caller, credential, now, actor } = await access(
      tx,
      { kind: 'service', id: found.callerId, credentialId: found.id, scopes: found.scopes },
      [],
    )
    const reset =
      !caller.windowStartedAt || now.getTime() - caller.windowStartedAt.getTime() >= 60000
    const used = reset ? 0 : caller.windowRequests
    if (used >= caller.requestsPerMinute)
      return {
        limited: true as const,
        retryAfter: Math.max(
          1,
          Math.ceil((caller.windowStartedAt!.getTime() + 60000 - now.getTime()) / 1000),
        ),
      }
    await tx
      .update(serviceCallers)
      .set({ windowRequests: used + 1, windowStartedAt: reset ? now : caller.windowStartedAt })
      .where(eq(serviceCallers.id, caller.id))
    await tx
      .update(serviceCredentials)
      .set({ lastUsedAt: now })
      .where(eq(serviceCredentials.id, credential.id))
    return { limited: false as const, actor }
  })
  if (outcome.limited)
    throw new DomainError('rate_limited', 'SERVICE_RATE_LIMIT', '调用频率超过限制', {
      retryAfter: outcome.retryAfter,
    })
  return outcome.actor
}
async function assertTarget(
  db: Db,
  credentialId: string,
  targetId: string,
  accountId?: string | null,
) {
  const { credentialTargetGrants: tg, credentialTargetAccountGrants: ag } = schemaFor(db)
  const [grant] = await db
    .select()
    .from(tg)
    .where(and(eq(tg.credentialId, credentialId), eq(tg.targetId, targetId)))
  if (!grant) throw forbidden('TARGET_SCOPE_DENIED', '目标系统不在授权范围')
  if (!accountId) {
    if (!grant.allowAnonymous) throw forbidden('ACCOUNT_SCOPE_DENIED', '未授权匿名执行')
    return
  }
  const [account] = await db
    .select()
    .from(ag)
    .where(
      and(
        eq(ag.credentialId, credentialId),
        eq(ag.targetId, targetId),
        eq(ag.targetAccountId, accountId),
      ),
    )
  if (!account) throw forbidden('ACCOUNT_SCOPE_DENIED', '目标账号不在授权范围')
}
async function ownRun(db: Db, actor: ServicePrincipal, id: string) {
  const { runs } = schemaFor(db)
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.serviceCallerId, actor.id)))
  if (!row) throw notFound('RUN_NOT_FOUND', '运行不存在')
  try {
    await assertTarget(db, actor.credentialId, row.targetId, row.targetAccountId)
  } catch (error) {
    if (error instanceof DomainError && error.kind === 'forbidden')
      throw notFound('RUN_NOT_FOUND', '运行不存在')
    throw error
  }
  return row
}
async function publicRun(db: Db, id: string, results = false) {
  const detail = await getRun(db, id),
    { runs } = schemaFor(db)
  const [row] = await db
    .select({ cancelReason: runs.cancelReason })
    .from(runs)
    .where(eq(runs.id, id))
  const { evidences } = schemaFor(db)
  const approved = results
    ? await db
        .select({ attemptId: evidences.attemptId, payload: evidences.payload })
        .from(evidences)
        .where(
          and(
            eq(evidences.runId, id),
            eq(evidences.type, 'output'),
            eq(evidences.externalAccess, 1),
            eq(evidences.status, 'available'),
          ),
        )
    : []
  return externalRunSchema.parse({
    ...detail,
    cancelReason: row!.cancelReason,
    stepRuns: detail.stepRuns.map((s) => ({
      ...s,
      attempts: s.attempts.map((a) => ({
        ...a,
        errorCode: a.error?.code ?? null,
        output: approved.find((e) => e.attemptId === a.id)?.payload ?? null,
      })),
    })),
  })
}
export async function createServiceRun(
  db: Db,
  principal: ServicePrincipal,
  body: ExternalRunBody,
  requestId: string,
  aiExecution?: AiExecutionConfig,
  hangWaitMs?: number,
) {
  const input = externalRunBodySchema.parse(body)
  return atomic(db, async (tx) => {
    const { runs, scenarios, scenarioVersions } = schemaFor(tx)
    const { caller, credential, actor, now } = await access(tx, principal, ['run:execute'])
    const digest = sha256Hex({
      protocol: 'open-v1',
      ...input,
      targetAccountId: input.targetAccountId ?? null,
    })
    const [existing] = await tx
      .select()
      .from(runs)
      .where(
        and(eq(runs.serviceCallerId, caller.id), eq(runs.idempotencyKey, input.idempotencyKey)),
      )
    if (existing) {
      await ownRun(tx, actor, existing.id)
      if (existing.idempotencyDigest !== digest)
        throw conflict('RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的运行输入')
      if (hasAiSteps(existing.snapshot.steps) && !credential.scopes.includes('ai:execute'))
        throw forbidden('SERVICE_SCOPE_DENIED', '服务凭据没有 AI 执行权限')
      return { detail: await publicRun(tx, existing.id), created: false }
    }
    const [resolved] = await tx
      .select({
        targetId: scenarios.targetId,
        definition: scenarioVersions.definition,
        kind: scenarioVersions.kind,
      })
      .from(scenarios)
      .innerJoin(scenarioVersions, eq(scenarioVersions.scenarioId, scenarios.id))
      .where(
        and(eq(scenarios.id, input.scenarioId), eq(scenarioVersions.id, input.scenarioVersionId)),
      )
    if (!resolved) throw notFound('SCENARIO_NOT_FOUND', '已发布场景版本不存在')
    await assertTarget(tx, credential.id, resolved.targetId, input.targetAccountId)
    if (resolved.kind !== 'published')
      throw badRequest('SCENARIO_VERSION_NOT_PUBLISHED', '只能执行已发布版本')
    if (hasAiSteps(resolved.definition.steps) && !credential.scopes.includes('ai:execute'))
      throw forbidden('SERVICE_SCOPE_DENIED', '服务凭据没有 AI 执行权限')
    if (
      !input.targetAccountId &&
      resolved.definition.steps.some((step) => stepUsesBrowser(step.type))
    )
      throw badRequest('SESSION_ACCOUNT_REQUIRED', '浏览器步骤需要授权的目标账号')
    const [used] = await tx
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.serviceCallerId, caller.id), inArray(runs.status, [...outstanding])))
    if (Number(used!.n) >= caller.maxOutstandingRuns)
      throw new DomainError('rate_limited', 'SERVICE_RUN_CAPACITY', '未结束运行数已达到限制', {
        retryAfter: 5,
      })
    const result = await createRunWithSnapshot(tx, {
      ...input,
      actor: { ...actor, requestId },
      aiExecution,
      hangWaitMs,
      externalIdempotencyDigest: digest,
      deadlineAt: new Date(now.getTime() + caller.runTimeoutSeconds * 1000),
      serviceAdmission: serviceAdmissionSchema.parse({
        version: 1,
        requestId,
        credentialRevision: credential.revision,
        targetId: resolved.targetId,
        targetAccountId: input.targetAccountId ?? null,
        scopes: credential.scopes,
        maxOutstandingRuns: caller.maxOutstandingRuns,
        runTimeoutSeconds: caller.runTimeoutSeconds,
      }),
    })
    return { detail: await publicRun(tx, result.detail.id), created: result.created }
  })
}
export async function getServiceRun(
  db: Db,
  principal: ServicePrincipal,
  id: string,
  cancel = false,
) {
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, [cancel ? 'run:cancel' : 'run:read'])
    await ownRun(tx, actor, id)
    if (cancel) await requestRunCancel(tx, id, actor)
    return publicRun(tx, id, actor.scopes.includes('run:read'))
  })
}
function allowedRun(db: Db, actor: ServicePrincipal) {
  const { runs: r, credentialTargetGrants: tg, credentialTargetAccountGrants: ag } = schemaFor(db)
  return and(
    eq(r.serviceCallerId, actor.id),
    sql`EXISTS (SELECT 1 FROM ${tg} WHERE ${tg.credentialId} = ${actor.credentialId} AND ${tg.targetId} = ${r.targetId} AND ((${r.targetAccountId} IS NULL AND ${tg.allowAnonymous} = 1) OR EXISTS (SELECT 1 FROM ${ag} WHERE ${ag.credentialId} = ${actor.credentialId} AND ${ag.targetId} = ${r.targetId} AND ${ag.targetAccountId} = ${r.targetAccountId})))`,
  )
}
export async function listServiceRuns(
  db: Db,
  principal: ServicePrincipal,
  query: ServicePageQuery,
) {
  const q = servicePageQuerySchema.parse(query)
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, ['run:read']),
      { runs } = schemaFor(tx)
    const result = page(
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(allowedRun(tx, actor), q.cursor ? gt(runs.id, q.cursor) : undefined))
        .orderBy(asc(runs.id))
        .limit(q.limit + 1),
      q.limit,
    )
    return {
      ...result,
      items: await Promise.all(result.items.map((r) => publicRun(tx, r.id, true))),
    }
  })
}
export async function serviceCatalog(
  db: Db,
  principal: ServicePrincipal,
  query: ServicePageQuery,
  targetId?: string,
) {
  const q = servicePageQuerySchema.parse(query)
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, ['run:execute'])
    const {
      targets: t,
      targetAccounts: a,
      credentialTargetGrants: tg,
      credentialTargetAccountGrants: ag,
      scenarios: s,
      scenarioVersions: v,
    } = schemaFor(tx)
    if (targetId) {
      const [grant] = await tx
        .select()
        .from(tg)
        .where(and(eq(tg.credentialId, actor.credentialId), eq(tg.targetId, targetId)))
      if (!grant) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
      const rows = await tx
        .select({
          id: v.id,
          scenarioId: s.id,
          name: s.name,
          versionNo: v.versionNo,
          definition: v.definition,
        })
        .from(s)
        .innerJoin(v, eq(v.scenarioId, s.id))
        .innerJoin(t, eq(t.id, s.targetId))
        .where(
          and(
            eq(s.targetId, targetId),
            eq(t.status, 'active'),
            eq(s.status, 'active'),
            eq(v.kind, 'published'),
            q.cursor ? gt(v.id, q.cursor) : undefined,
          ),
        )
        .orderBy(asc(v.id))
        .limit(q.limit + 1)
      const result = page(rows, q.limit)
      return {
        ...result,
        items: result.items.map(({ definition, ...row }) => ({
          ...row,
          inputs: definition.inputs ?? [],
          hasAi: hasAiSteps(definition.steps),
        })),
      }
    }
    const rows = await tx
      .select({ id: t.id, name: t.name, allowAnonymous: tg.allowAnonymous })
      .from(t)
      .innerJoin(tg, eq(tg.targetId, t.id))
      .where(
        and(
          eq(tg.credentialId, actor.credentialId),
          eq(t.status, 'active'),
          q.cursor ? gt(t.id, q.cursor) : undefined,
        ),
      )
      .orderBy(asc(t.id))
      .limit(q.limit + 1)
    const result = page(rows, q.limit)
    const items = []
    for (const row of result.items) {
      const accounts = await tx
        .select({ id: a.id, name: a.displayName })
        .from(a)
        .innerJoin(ag, eq(ag.targetAccountId, a.id))
        .where(
          and(
            eq(ag.credentialId, actor.credentialId),
            eq(ag.targetId, row.id),
            eq(a.status, 'active'),
          ),
        )
      items.push({ ...row, allowAnonymous: row.allowAnonymous === 1, accounts })
    }
    return { ...result, items }
  })
}
export async function releaseServiceEvidence(
  db: Db,
  runId: string,
  evidenceId: string,
  allowed: boolean,
  actor: AuditActor,
) {
  return atomic(db, async (tx) => {
    const { evidences: e } = schemaFor(tx)
    const [row] = await tx
      .select()
      .from(e)
      .where(and(eq(e.id, evidenceId), eq(e.runId, runId)))
    if (!row) throw notFound('EVIDENCE_NOT_FOUND', '证据不存在')
    if (
      allowed &&
      (row.status !== 'available' ||
        !(
          (row.type === 'screenshot' &&
            ['image/png', 'image/jpeg', 'image/webp'].includes(row.contentType ?? '')) ||
          (row.type === 'output' && row.payload !== null && !isAiCallEvidence(row.payload))
        ))
    )
      throw badRequest('EVIDENCE_RELEASE_DENIED', '仅可发布已人工检查的截图或业务输出')
    await tx
      .update(e)
      .set({ externalAccess: allowed ? 1 : 0 })
      .where(eq(e.id, evidenceId))
    await recordAudit(
      tx,
      actor,
      'evidence.release',
      'run',
      runId,
      `${allowed ? '允许' : '禁止'}证据对外访问 ${evidenceId}`,
    )
    return { id: evidenceId, externalAccess: allowed }
  })
}
export async function serviceEvidence(
  db: Db,
  principal: ServicePrincipal,
  runId: string,
  query: ServicePageQuery,
  evidenceId?: string,
) {
  const q = servicePageQuerySchema.parse(query)
  return atomic(db, async (tx) => {
    const { actor } = await access(tx, principal, ['run:read', 'evidence:read'])
    await ownRun(tx, actor, runId)
    const { evidences: e } = schemaFor(tx)
    const rows = await tx
      .select()
      .from(e)
      .where(
        and(
          eq(e.runId, runId),
          eq(e.status, 'available'),
          eq(e.externalAccess, 1),
          or(
            and(
              eq(e.type, 'screenshot'),
              inArray(e.contentType, ['image/png', 'image/jpeg', 'image/webp']),
            ),
            eq(e.type, 'output'),
          ),
          evidenceId ? eq(e.id, evidenceId) : undefined,
          q.cursor ? gt(e.id, q.cursor) : undefined,
        ),
      )
      .orderBy(asc(e.id))
      .limit(q.limit + 1)
    if (evidenceId) {
      if (!rows[0]?.objectKey) throw notFound('EVIDENCE_NOT_FOUND', '证据不存在')
      return { object: rows[0], items: [] }
    }
    const result = page(rows, q.limit)
    return {
      ...result,
      object: undefined,
      items: result.items.map((r) => ({
        id: r.id,
        runId: r.runId,
        stepRunId: r.stepRunId,
        attemptId: r.attemptId,
        type: r.type,
        contentType: r.contentType,
        byteSize: r.byteSize,
        createdAt: iso(r.createdAt),
        ...(r.type === 'output' ? { payload: r.payload } : {}),
      })),
    }
  })
}
