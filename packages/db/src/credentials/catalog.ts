import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, lte, not, or, sql, type SQL } from 'drizzle-orm'
import {
  capabilitiesForType,
  hasPermission,
  computeMaintenanceDueAt,
  credentialDetailSchema,
  credentialHistoryResponseSchema,
  credentialListQuerySchema,
  credentialListResponseSchema,
  credentialUsageResponseSchema,
  deriveMaintenanceStatus,
  policyFromWrite,
  type CredentialDetail,
  type CredentialHistoryQuery,
  type CredentialListItem,
  type CredentialListQuery,
  type CredentialMetadataBody,
  type CredentialRegisterBody,
  type CredentialReplaceBody,
  type CredentialRevisionBody,
  type CredentialSessionSummary,
  type CredentialStats,
  type CredentialValidityPolicy,
} from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { cursorFilter, encodeCursor, paginateResults } from '../cursor.js'
import { atomic, clockNow, schemaFor, timestampMinusDays } from '../native.js'
import { assertTargetPermission, lockConsoleAuthorization, targetScopeFilter, targetScopeFor } from '../console/target-authorization.js'
import { assertResourceIdle } from '../lifecycle.js'
import { badRequest, conflict, forbidden, notFound } from '../runs/errors.js'
import { loadOccupancyFactsForAccounts, statusFromFacts } from '../sessions/session-overview.js'
import { actorPermissions, assertCredentialAccess, canReadCredentialType, canWriteCredentialType, readableTypes } from './access.js'
import {
  invalidateReminders,
  clearTargetAccountSecrets,
  replaceAlertWebhookSecret,
  replaceTargetAccountSecret,
  type SealedSecret,
} from './sync.js'

const unavailableSession = (reason: 'not_applicable' | 'forbidden' | 'unavailable'): CredentialSessionSummary => ({
  browser: reason,
  auth: reason,
  identityState: reason,
  occupancy: reason,
  sessionId: null,
  generation: null,
  observedAt: null,
  lastAuthCheckedAt: null,
  lastAuthSuccessAt: null,
  occupyingLabel: null,
})

function consoleActor(actor: AuditActor) {
  return { kind: 'console' as const, id: actor.id }
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function policyOf(row: {
  mode: string
  amount: number | null
  timeZone: string | null
}): CredentialValidityPolicy {
  return {
    mode: row.mode as CredentialValidityPolicy['mode'],
    amount: row.amount,
    timeZone: row.timeZone,
  }
}

function ownerStatus(ownerId: string | null, ownerAccountStatus: string | null): 'assigned' | 'unclaimed' | 'needs_handover' {
  if (!ownerId) return 'unclaimed'
  if (ownerAccountStatus === 'disabled') return 'needs_handover'
  return 'assigned'
}

function safeIdentifier(input: {
  type: string
  username?: string | null
  modelOrigin?: string | null
  servicePrefix?: string | null
}): string {
  if (input.type === 'target_password') return input.username ?? '未保存密码'
  if (input.type === 'model_key') return input.modelOrigin ?? '模型服务'
  if (input.type === 'alert_webhook') return 'Webhook'
  return input.servicePrefix ?? 'cairn_sk_***'
}

/** A target credential is an extension of a live target account, not an independent account. */
function activeSourceFilter(db: Db) {
  const { credentials, credentialBindings, targetAccounts, targets } = schemaFor(db)
  return and(
      eq(credentials.type, 'target_password'),
      isNull(credentials.deletedAt),
      eq(credentialBindings.kind, 'target_account'),
      eq(credentialBindings.targetAccountId, credentials.id),
      eq(targetAccounts.targetId, targets.id),
      isNotNull(targetAccounts.id),
      isNull(targetAccounts.deletedAt),
      isNotNull(targets.id),
      isNull(targets.deletedAt),
  )
}

export async function listCredentials(
  db: Db,
  query: CredentialListQuery,
  actor: AuditActor,
  options?: { canReadSession?: boolean },
) {
  const parsed = credentialListQuerySchema.parse(query)
  const permissions = await actorPermissions(db, actor.id)
  const types = readableTypes(permissions)
  const now = await clockNow(db)
  if (types.length === 0) {
    return credentialListResponseSchema.parse({
      items: [],
      stats: emptyStats(),
      asOf: now.toISOString(),
      realtime: true,
    })
  }

  const {
    credentials,
    credentialBindings,
    credentialMaintenancePolicies,
    credentialVerifications,
    consoleAccounts,
    targets,
    targetAccounts,
    serviceCredentials,
  } = schemaFor(db)

  const filters: (SQL | undefined)[] = [
    inArray(credentials.type, types),
    activeSourceFilter(db),
    targetScopeFilter(targets.id, await targetScopeFor(db, actor.id, 'target:read')),
    targetScopeFilter(targets.id, await targetScopeFor(db, actor.id, 'credential:read')),
    parsed.type ? eq(credentials.type, parsed.type) : undefined,
    parsed.targetId ? eq(credentialBindings.targetId, parsed.targetId) : undefined,
    parsed.ownerConsoleAccountId ? eq(credentials.ownerConsoleAccountId, parsed.ownerConsoleAccountId) : undefined,
    parsed.mine ? eq(credentials.ownerConsoleAccountId, actor.id) : undefined,
    parsed.managementStatus ? eq(credentials.managementStatus, parsed.managementStatus) : undefined,
    parsed.search
      ? or(
          sql`lower(${targetAccounts.displayName}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          sql`lower(${targetAccounts.username}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          sql`lower(${targets.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
        )
      : undefined,
  ]

  const policy = credentialMaintenancePolicies
  const due = and(isNotNull(policy.maintenanceDueAt), lte(policy.maintenanceDueAt, now))!
  const approaching = and(gt(policy.maintenanceDueAt, now), sql`${timestampMinusDays(db, policy.maintenanceDueAt, policy.expiryReminderLeadDays)} <= ${sql.param(now, policy.maintenanceDueAt)}`)!
  const unknown = or(isNull(policy.credentialId), eq(policy.mode, 'unknown'))!
  const permanent = eq(policy.mode, 'permanent')
  const normal = and(not(due), not(approaching), not(unknown), not(permanent))!
  const sessionScope = await targetScopeFor(db, actor.id, 'session:read')
  const { browserSessions } = schemaFor(db)
  const abnormal = and(targetScopeFilter(targets.id, sessionScope), exists(db.select({ id: browserSessions.id }).from(browserSessions)
    .where(and(eq(browserSessions.targetAccountId, targetAccounts.id), inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING', 'LOST']),
      or(eq(browserSessions.authState, 'EXPIRED'), eq(browserSessions.identityState, 'MISMATCH'))))))!
  const pending = and(isNotNull(credentials.currentVersionId), not(exists(db.select({ id: credentialVerifications.id }).from(credentialVerifications)
    .where(eq(credentialVerifications.versionId, credentials.currentVersionId)))))!
  const unclaimed = isNull(credentials.ownerConsoleAccountId)
  const states: Record<string, SQL> = { due, approaching, unknown, permanent, not_due: normal,
    auth_abnormal: abnormal, pending_verification: pending, unclaimed }
  const sum = (condition: SQL) => sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`
  const [counts] = await db.select({ visible: sql<number>`count(*)`, approaching: sum(approaching), due: sum(due),
    unknown: sum(unknown), authAbnormal: sum(abnormal), pendingVerification: sum(pending), unclaimed: sum(unclaimed) })
    .from(credentials).innerJoin(credentialBindings, eq(credentialBindings.credentialId, credentials.id))
    .leftJoin(policy, eq(policy.credentialId, credentials.id)).innerJoin(targetAccounts, eq(targetAccounts.id, credentialBindings.targetAccountId))
    .innerJoin(targets, eq(targets.id, credentialBindings.targetId)).where(and(...filters))
  filters.push(cursorFilter(credentials.updatedAt, credentials.id, parsed.cursor), parsed.shortcut ? states[parsed.shortcut] : undefined,
    parsed.maintenanceStatus ? states[parsed.maintenanceStatus] : undefined)

  const rows = await db
    .select({
      credential: credentials,
      binding: credentialBindings,
      policy: credentialMaintenancePolicies,
      ownerStatus: consoleAccounts.status,
      ownerName: consoleAccounts.displayName,
      targetName: targets.name,
      targetCode: targets.code,
      accountName: targetAccounts.displayName,
      username: targetAccounts.username,
      servicePrefix: serviceCredentials.id,
    })
    .from(credentials)
    .leftJoin(credentialBindings, eq(credentialBindings.credentialId, credentials.id))
    .leftJoin(credentialMaintenancePolicies, eq(credentialMaintenancePolicies.credentialId, credentials.id))
    .leftJoin(consoleAccounts, eq(consoleAccounts.id, credentials.ownerConsoleAccountId))
    .leftJoin(targets, eq(targets.id, credentialBindings.targetId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, credentialBindings.targetAccountId))
    .leftJoin(serviceCredentials, eq(serviceCredentials.id, credentialBindings.serviceCredentialId))
    .where(and(...filters.filter((item): item is SQL => item !== undefined)))
    .orderBy(desc(credentials.updatedAt), desc(credentials.id))
    .limit(parsed.limit + 1)

  const latestVerify = await latestVerifications(
    db,
    rows.map((row) => row.credential.id),
  )
  const items = rows.map((row) =>
    toListItem(row, now, latestVerify.get(row.credential.id) ?? null, unavailableSession('unavailable')),
  )
  const sessionMap = options?.canReadSession
    ? await sessionSummaries(
        db,
        items
          .filter((item) => item.type === 'target_password' && item.targetId && item.targetAccountId)
          .map((item) => ({ targetId: item.targetId!, targetAccountId: item.targetAccountId! })),
      )
    : new Map<string, CredentialSessionSummary>()
  const withSession = items.map((item) => {
    if (item.type !== 'target_password') return { ...item, session: unavailableSession('not_applicable') }
    if (!options?.canReadSession || !(sessionScope.all || sessionScope.ids.includes(item.targetId!))) return { ...item, session: unavailableSession('forbidden') }
    return {
      ...item,
      session: sessionMap.get(`${item.targetId}:${item.targetAccountId}`) ?? unavailableSession('unavailable'),
    }
  })
  const filtered = await Promise.all(withSession.map(async (item) => ({ ...item, capabilities: await accountCapabilities(db, actor.id, item.targetId!, permissions) })))
  const paginated = paginateResults(
    filtered.map((item) => ({ ...item, createdAt: item.updatedAt })),
    parsed.limit,
  )

  return credentialListResponseSchema.parse({
    items: paginated.items.map((item) => ({ ...item, createdAt: rows.find((row) => row.credential.id === item.id)!.credential.createdAt.toISOString() })),
    nextCursor: paginated.nextCursor,
    stats: Object.fromEntries(Object.entries(counts ?? emptyStats()).map(([key, value]) => [key, Number(value)])),
    asOf: now.toISOString(),
    realtime: true,
  })
}

async function accountCapabilities(db: Db, actorId: string, targetId: string, permissions: string[]) {
  const allowed = async (permission: string) => {
    const scope = await targetScopeFor(db, actorId, permission)
    return scope.all || scope.ids.includes(targetId)
  }
  const canWrite = canWriteCredentialType(permissions, 'target_password') && await allowed('credential:write')
  return { canReplace: canWrite, canSetMaintenance: canWrite, canDisable: canWrite,
    canEditAccount: await allowed('target:write'), canDelete: canWrite && await allowed('credential:delete'),
    canImport: canWrite && await allowed('credential:import'), canVerify: await allowed('session:control'), externallyRenewed: false }
}

function emptyStats(): CredentialStats {
  return {
    visible: 0,
    approaching: 0,
    due: 0,
    unknown: 0,
    authAbnormal: 0,
    pendingVerification: 0,
    unclaimed: 0,
  }
}

function statsOf(items: CredentialListItem[]): CredentialStats {
  return {
    visible: items.length,
    approaching: items.filter((item) => item.maintenanceStatus === 'approaching').length,
    due: items.filter((item) => item.maintenanceStatus === 'due').length,
    unknown: items.filter((item) => item.maintenanceStatus === 'unknown').length,
    authAbnormal: items.filter((item) => item.session.auth === 'expired' || item.session.identityState === 'MISMATCH')
      .length,
    pendingVerification: items.filter((item) => item.verificationStatus === 'pending').length,
    unclaimed: items.filter((item) => item.ownerStatus === 'unclaimed').length,
  }
}

function matchesShortcut(
  item: CredentialListItem,
  shortcut?: string,
  maintenanceStatus?: string,
): boolean {
  if (maintenanceStatus && item.maintenanceStatus !== maintenanceStatus) return false
  if (!shortcut) return true
  if (shortcut === 'approaching') return item.maintenanceStatus === 'approaching'
  if (shortcut === 'due') return item.maintenanceStatus === 'due'
  if (shortcut === 'unknown') return item.maintenanceStatus === 'unknown'
  if (shortcut === 'pending_verification') return item.verificationStatus === 'pending'
  if (shortcut === 'unclaimed') return item.ownerStatus === 'unclaimed'
  if (shortcut === 'auth_abnormal') return item.session.auth === 'expired' || item.session.identityState === 'MISMATCH'
  return true
}

function toListItem(
  row: {
    credential: {
      id: string
      type: string
      source: string
      name: string
      revision: number
      managementStatus: string
      ownerConsoleAccountId: string | null
      currentVersionId: string | null
      updatedAt: Date
      createdAt: Date
    }
    binding: {
      targetId: string | null
      targetAccountId: string | null
      modelOrigin: string | null
      identityConfirmStatus: string
    } | null
    policy: {
      mode: string
      amount: number | null
      timeZone: string | null
      validityStartedAt: Date | null
      maintenanceDueAt: Date | null
      issuerExpiresAt: Date | null
      issuerExpirySource: string
      expiryReminderLeadDays: number
    } | null
    ownerStatus: string | null
    ownerName: string | null
    targetName: string | null
    targetCode?: string | null
    accountName?: string | null
    username: string | null
    servicePrefix: string | null
  },
  now: Date,
  verification: string | null,
  session: CredentialSessionSummary,
): CredentialListItem {
  const policy = row.policy ? policyOf(row.policy) : { mode: 'unknown' as const, amount: null, timeZone: null }
  const dueAt = row.policy?.maintenanceDueAt ?? computeMaintenanceDueAt({ policy, startedAt: row.policy?.validityStartedAt ?? null })
  const maintenanceStatus = deriveMaintenanceStatus({
    policy,
    dueAt,
    now,
    reminderLeadDays: row.policy?.expiryReminderLeadDays ?? 14,
  })
  return {
    id: row.credential.id,
    type: row.credential.type as CredentialListItem['type'],
    source: row.credential.source as CredentialListItem['source'],
    name: row.accountName ?? row.credential.name,
    safeIdentifier: safeIdentifier({
      type: row.credential.type,
      username: row.username,
      modelOrigin: row.binding?.modelOrigin,
      servicePrefix: row.servicePrefix ? `cairn_sk_${row.servicePrefix.slice(0, 8)}` : null,
    }),
    subjectLabel: row.targetName ?? row.binding?.modelOrigin ?? row.credential.name,
    targetId: row.binding?.targetId ?? null,
    targetAccountId: row.binding?.targetAccountId ?? null,
    target: row.binding?.targetId && row.binding.targetAccountId ? {
      id: row.binding.targetId, name: row.targetName ?? '', code: row.targetCode ?? '',
      accountId: row.binding.targetAccountId, accountName: row.accountName ?? row.credential.name, username: row.username ?? '',
    } : undefined,
    hasPassword: row.credential.currentVersionId !== null,
    revision: row.credential.revision,
    managementStatus: row.credential.managementStatus as CredentialListItem['managementStatus'],
    maintenanceStatus,
    maintenanceDueAt: iso(dueAt),
    validityStartedAt: iso(row.policy?.validityStartedAt ?? null),
    validityPolicy: policy,
    issuerExpiresAt: iso(row.policy?.issuerExpiresAt ?? null),
    issuerExpirySource: (row.policy?.issuerExpirySource ?? 'unknown') as CredentialListItem['issuerExpirySource'],
    verificationStatus:
      row.credential.type === 'target_password'
        ? row.credential.currentVersionId
          ? ((verification as CredentialListItem['verificationStatus']) ?? 'pending')
          : 'not_applicable'
        : 'not_applicable',
    identityBindingStatus:
      (row.binding?.identityConfirmStatus as CredentialListItem['identityBindingStatus']) ?? 'confirmed',
    ownerConsoleAccountId: row.credential.ownerConsoleAccountId,
    ownerDisplayName: row.ownerName,
    ownerStatus: ownerStatus(row.credential.ownerConsoleAccountId, row.ownerStatus),
    session,
    capabilities: capabilitiesForType(row.credential.type as CredentialListItem['type']),
    currentVersionId: row.credential.currentVersionId,
    updatedAt: row.credential.updatedAt.toISOString(),
    createdAt: row.credential.createdAt.toISOString(),
  }
}

async function latestVerifications(db: Db, ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (ids.length === 0) return result
  const { credentialVerifications, credentials } = schemaFor(db)
  const rows = await db
    .select({
      credentialId: credentialVerifications.credentialId,
      outcome: credentialVerifications.outcome,
      versionId: credentialVerifications.versionId,
      currentVersionId: credentials.currentVersionId,
    })
    .from(credentialVerifications)
    .innerJoin(credentials, eq(credentials.id, credentialVerifications.credentialId))
    .where(inArray(credentialVerifications.credentialId, ids))
    .orderBy(desc(credentialVerifications.verifiedAt))
  for (const row of rows) {
    if (result.has(row.credentialId)) continue
    result.set(row.credentialId, row.versionId === row.currentVersionId ? row.outcome : 'pending')
  }
  return result
}

async function sessionSummaries(
  db: Db,
  keys: Array<{ targetId: string; targetAccountId: string }>,
): Promise<Map<string, CredentialSessionSummary>> {
  const map = new Map<string, CredentialSessionSummary>()
  if (keys.length === 0) return map
  const facts = await loadOccupancyFactsForAccounts(db, keys)
  const now = await clockNow(db)
  for (const key of keys) {
    const fact = facts.get(`${key.targetId}:${key.targetAccountId}`) ?? facts.get(key.targetAccountId)
    const occupancy = fact ? statusFromFacts(fact) : 'unprepared'
    const live = fact?.live
    map.set(`${key.targetId}:${key.targetAccountId}`, {
      browser: !live
        ? 'unprepared'
        : live.status === 'OPEN'
          ? 'online'
          : live.status === 'LOST'
            ? 'lost'
            : live.status === 'CLOSED'
              ? 'closed'
              : 'unknown',
      auth:
        live?.authState === 'AUTHENTICATED'
          ? 'verified'
          : live?.authState === 'EXPIRED'
            ? 'expired'
            : live?.authState === 'UNKNOWN'
              ? 'pending'
              : 'unknown',
      identityState: live?.identityState ?? 'UNVERIFIED',
      occupancy:
        occupancy === 'executing'
          ? 'executing'
          : occupancy === 'maintenance'
            ? fact?.lease?.purpose === 'AUTH_WAIT'
              ? 'auth_wait'
              : 'maintenance'
            : 'idle',
      sessionId: live?.id ?? null,
      generation: live?.generation ?? null,
      observedAt: now.toISOString(),
      lastAuthCheckedAt: iso(live?.lastAuthCheckedAt ?? null),
      lastAuthSuccessAt: iso(live?.lastAuthSuccessAt ?? null),
      occupyingLabel: fact?.lease?.runId ?? fact?.activeOp?.id ?? null,
    })
  }
  return map
}

export async function getCredential(
  db: Db,
  credentialId: string,
  actor: AuditActor,
  options?: { canReadSession?: boolean },
): Promise<CredentialDetail> {
  await assertCredentialAccess(db, credentialId, actor.id)
  const permissions = await actorPermissions(db, actor.id)
  const {
    credentials,
    credentialBindings,
    credentialMaintenancePolicies,
    credentialVersions,
    consoleAccounts,
    targets,
    targetAccounts,
    serviceCredentials,
  } = schemaFor(db)
  const [row] = await db
    .select({
      credential: credentials,
      binding: credentialBindings,
      policy: credentialMaintenancePolicies,
      ownerStatus: consoleAccounts.status,
      ownerName: consoleAccounts.displayName,
      targetName: targets.name,
      targetCode: targets.code,
      accountName: targetAccounts.displayName,
      username: targetAccounts.username,
      servicePrefix: serviceCredentials.id,
    })
    .from(credentials)
    .leftJoin(credentialBindings, eq(credentialBindings.credentialId, credentials.id))
    .leftJoin(credentialMaintenancePolicies, eq(credentialMaintenancePolicies.credentialId, credentials.id))
    .leftJoin(consoleAccounts, eq(consoleAccounts.id, credentials.ownerConsoleAccountId))
    .leftJoin(targets, eq(targets.id, credentialBindings.targetId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, credentialBindings.targetAccountId))
    .leftJoin(serviceCredentials, eq(serviceCredentials.id, credentialBindings.serviceCredentialId))
    .where(and(eq(credentials.id, credentialId), activeSourceFilter(db)))
    .limit(1)
  if (!row || !canReadCredentialType(permissions, row.credential.type)) {
    throw notFound('CREDENTIAL_NOT_FOUND', '凭据不存在')
  }
  const now = await clockNow(db)
  const verify = await latestVerifications(db, [credentialId])
  let session = unavailableSession(row.credential.type === 'target_password' ? 'unavailable' : 'not_applicable')
  if (row.credential.type === 'target_password') {
    const scope = await targetScopeFor(db, actor.id, 'session:read')
    if (!options?.canReadSession || !(scope.all || scope.ids.includes(row.binding!.targetId!))) session = unavailableSession('forbidden')
    else if (row.binding?.targetId && row.binding.targetAccountId) {
      const map = await sessionSummaries(db, [
        { targetId: row.binding.targetId, targetAccountId: row.binding.targetAccountId },
      ])
      session = map.get(`${row.binding.targetId}:${row.binding.targetAccountId}`) ?? unavailableSession('unavailable')
    }
  }
  const found = toListItem(row, now, verify.get(credentialId) ?? null, session)
  const [version] = row.credential.currentVersionId
    ? await db.select().from(credentialVersions).where(eq(credentialVersions.id, row.credential.currentVersionId)).limit(1)
    : []
  return credentialDetailSchema.parse({
    ...found,
    capabilities: await accountCapabilities(db, actor.id, found.targetId!, permissions),
    notes: row.credential.notes ?? null,
    purpose: row.credential.purpose ?? null,
    tags: row.credential.tags ?? [],
    expiryReminderLeadDays: row.policy?.expiryReminderLeadDays ?? 14,
    policyRevision: row.policy?.revision ?? 1,
    currentVersion: version
      ? {
          id: version.id,
          materialStatus: version.materialStatus,
          identityRevision: version.identityRevision,
          identityUsername: version.identityUsername,
          registeredAt: version.registeredAt.toISOString(),
          revokedAt: iso(version.revokedAt),
        }
      : null,
    domainHref:
      found.type === 'target_password' && found.targetId
        ? `/targets/${found.targetId}`
        : found.type === 'service_key'
          ? '/services'
          : found.type === 'alert_webhook'
            ? '/monitoring'
            : '/platform-config',
    sessionHref:
      found.type === 'target_password' && found.targetId && found.targetAccountId
        ? `/sessions/${found.targetId}/${found.targetAccountId}`
        : null,
  })
}

export async function updateCredentialMetadata(
  db: Db,
  credentialId: string,
  body: CredentialMetadataBody,
  actor: AuditActor,
): Promise<CredentialDetail> {
  return atomic(db, async (tx) => {
    const binding = await assertCredentialAccess(tx, credentialId, actor.id, 'credential:write')
    const permissions = await actorPermissions(tx, actor.id)
    const { credentials, credentialMaintenancePolicies } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1)
    if (!current || !canReadCredentialType(permissions, current.type)) {
      throw notFound('CREDENTIAL_NOT_FOUND', '凭据不存在')
    }
    if (!canWriteCredentialType(permissions, current.type)) throw forbidden('FORBIDDEN', '无权修改该凭据')
    if (current.revision !== body.expectedRevision) {
      throw conflict('CREDENTIAL_REVISION_CONFLICT', '凭据已被他人更新', { currentRevision: current.revision })
    }
    if (current.type === 'service_key' && body.validity) {
      throw badRequest('CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '服务 Key 不能用维护有效期覆盖真实鉴权期限')
    }
    const now = await clockNow(tx)
    const [policy] = await tx
      .select()
      .from(credentialMaintenancePolicies)
      .where(eq(credentialMaintenancePolicies.credentialId, credentialId))
      .limit(1)
    const nameChanged = body.name !== undefined && body.name !== current.name
    if (nameChanged) {
      await assertTargetPermission(tx, actor.id, binding.targetId, 'target:write')
      const { targetAccounts } = schemaFor(tx)
      await tx.update(targetAccounts).set({ displayName: body.name, updatedAt: now }).where(eq(targetAccounts.id, binding.accountId))
    }
    if (body.ownerConsoleAccountId) {
      const { consoleAccounts } = schemaFor(tx)
      const [owner] = await tx.select({ id: consoleAccounts.id }).from(consoleAccounts).where(and(eq(consoleAccounts.id, body.ownerConsoleAccountId), eq(consoleAccounts.status, 'active')))
      if (!owner) throw badRequest('CREDENTIAL_OWNER_INVALID', '负责人不存在或已停用')
      await assertTargetPermission(tx, owner.id, binding.targetId, 'credential:read')
    }
    const ownerChanged = body.ownerConsoleAccountId !== undefined
    const notesChanged = body.notes !== undefined
    const tagsChanged = body.tags !== undefined
    const purposeChanged = body.purpose !== undefined
    const validityChanged = body.validity !== undefined || body.startedAt !== undefined
    if (validityChanged) {
      const next = body.validity ? policyFromWrite(body.validity) : policyOf(policy ?? { mode: 'unknown', amount: null, timeZone: null })
      const startedAt = body.startedAt
        ? new Date(body.startedAt)
        : policy?.validityStartedAt ?? null
      if (body.startedAt && new Date(body.startedAt).getTime() > now.getTime()) {
        throw badRequest('CREDENTIAL_VALIDITY_INVALID', '启用时间不能是未来时刻')
      }
      if ((next.mode === 'days' || next.mode === 'months') && !startedAt) {
        throw badRequest('CREDENTIAL_START_TIME_REQUIRED', '有限期限必须先补全启用时间')
      }
      await tx
        .update(credentialMaintenancePolicies)
        .set({
          mode: next.mode,
          amount: next.mode === 'permanent' || next.mode === 'unknown' ? null : next.amount,
          timeZone: next.mode === 'unknown' ? null : next.timeZone,
          validityStartedAt: startedAt,
          maintenanceDueAt: computeMaintenanceDueAt({ policy: next, startedAt }),
          expiryReminderLeadDays: body.expiryReminderLeadDays ?? policy?.expiryReminderLeadDays ?? 14,
          revision: (policy?.revision ?? 1) + 1,
          updatedAt: now,
        })
        .where(eq(credentialMaintenancePolicies.credentialId, credentialId))
      await invalidateReminders(tx, credentialId)
    } else if (body.expiryReminderLeadDays !== undefined && policy) {
      await tx
        .update(credentialMaintenancePolicies)
        .set({ expiryReminderLeadDays: body.expiryReminderLeadDays, updatedAt: now })
        .where(eq(credentialMaintenancePolicies.credentialId, credentialId))
    }
    const onlyCosmetic = !validityChanged && (nameChanged || ownerChanged || notesChanged || tagsChanged || purposeChanged)
    await tx
      .update(credentials)
      .set({
        name: body.name ?? current.name,
        ownerConsoleAccountId:
          body.ownerConsoleAccountId !== undefined ? body.ownerConsoleAccountId : current.ownerConsoleAccountId,
        notes: body.notes !== undefined ? body.notes : current.notes,
        purpose: body.purpose !== undefined ? body.purpose : current.purpose,
        tags: body.tags ?? current.tags,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(eq(credentials.id, credentialId))
    await recordAudit(
      tx,
      consoleActor(actor),
      'credential.metadata',
      'credential',
      credentialId,
      validityChanged ? '修改维护期限' : onlyCosmetic ? '修改维护信息' : '更新凭据',
    )
    return getCredential(tx, credentialId, actor)
  })
}

export async function setCredentialEnabled(
  db: Db,
  credentialId: string,
  body: CredentialRevisionBody,
  enabled: boolean,
  actor: AuditActor,
): Promise<CredentialDetail> {
  return atomic(db, async (tx) => {
    await assertCredentialAccess(tx, credentialId, actor.id, 'credential:write')
    const permissions = await actorPermissions(tx, actor.id)
    const { credentials } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1)
    if (!current || !canReadCredentialType(permissions, current.type)) throw notFound('CREDENTIAL_NOT_FOUND', '凭据不存在')
    if (!canWriteCredentialType(permissions, current.type)) throw forbidden('FORBIDDEN', '无权修改该凭据')
    if (current.type === 'service_key') {
      throw badRequest('CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '服务 Key 的停用与吊销走开放服务')
    }
    if (current.revision !== body.expectedRevision) {
      throw conflict('CREDENTIAL_REVISION_CONFLICT', '凭据已被他人更新', { currentRevision: current.revision })
    }
    const now = await clockNow(tx)
    await tx
      .update(credentials)
      .set({
        managementStatus: enabled ? 'active' : 'disabled',
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(eq(credentials.id, credentialId))
    await recordAudit(
      tx,
      consoleActor(actor),
      enabled ? 'credential.enable' : 'credential.disable',
      'credential',
      credentialId,
      enabled ? '恢复目录取用' : '暂停目录取用',
    )
    return getCredential(tx, credentialId, actor)
  })
}

export async function revokeCredentialVersion(
  db: Db,
  credentialId: string,
  versionId: string,
  body: CredentialRevisionBody,
  actor: AuditActor,
): Promise<CredentialDetail> {
  return atomic(db, async (tx) => {
    await assertCredentialAccess(tx, credentialId, actor.id, 'credential:write')
    const permissions = await actorPermissions(tx, actor.id)
    const { credentials, credentialVersions, targetAccounts } = schemaFor(tx)
    const [current] = await tx.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1)
    if (!current || !canReadCredentialType(permissions, current.type)) throw notFound('CREDENTIAL_NOT_FOUND', '凭据不存在')
    if (!canWriteCredentialType(permissions, current.type)) throw forbidden('FORBIDDEN', '无权修改该凭据')
    if (current.revision !== body.expectedRevision) {
      throw conflict('CREDENTIAL_REVISION_CONFLICT', '凭据已被他人更新', { currentRevision: current.revision })
    }
    const [version] = await tx
      .select()
      .from(credentialVersions)
      .where(and(eq(credentialVersions.id, versionId), eq(credentialVersions.credentialId, credentialId)))
      .limit(1)
    if (!version) throw notFound('CREDENTIAL_NOT_FOUND', '凭据版本不存在')
    const now = await clockNow(tx)
    if (current.currentVersionId === versionId) {
      await assertResourceIdle(tx, { targetAccountId: credentialId })
      await tx.update(targetAccounts).set({ secretId: null, secretProvider: null, updatedAt: now }).where(eq(targetAccounts.id, credentialId))
    }
    await tx
      .update(credentialVersions)
      .set({ materialStatus: 'revoked', revokedAt: now, revokeReason: 'revoked' })
      .where(eq(credentialVersions.id, versionId))
    await tx
      .update(credentials)
      .set({
        currentVersionId: current.currentVersionId === versionId ? null : current.currentVersionId,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(eq(credentials.id, credentialId))
    await invalidateReminders(tx, credentialId)
    await recordAudit(tx, consoleActor(actor), 'credential.version_revoke', 'credential', credentialId, `撤销版本 ${versionId}`)
    return getCredential(tx, credentialId, actor)
  })
}

export async function listCredentialUsages(db: Db, credentialId: string, actor: AuditActor) {
  const detail = await getCredential(db, credentialId, actor)
  const now = await clockNow(db)
  const { runs, schedules } = schemaFor(db)
  const runScope = await targetScopeFor(db, actor.id, 'run:read')
  const scheduleScope = await targetScopeFor(db, actor.id, 'schedule:read')
  const canSeeRuns = !!detail.targetId && (runScope.all || runScope.ids.includes(detail.targetId))
  const canSeeSchedules = !!detail.targetId && (scheduleScope.all || scheduleScope.ids.includes(detail.targetId))
  const items: Array<{
    kind: 'confirmed' | 'possible' | 'active'
    resource: 'run' | 'schedule' | 'session' | 'target_account' | 'model_config' | 'alert_channel' | 'service'
    id: string | null
    label: string | null
    href: string | null
  }> = []
  if (detail.targetAccountId) {
    items.push({
      kind: 'confirmed',
      resource: 'target_account',
      id: detail.targetAccountId,
      label: detail.safeIdentifier,
      href: detail.domainHref,
    })
    const active = canSeeRuns ? await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(eq(runs.targetAccountId, detail.targetAccountId), isNull(runs.deletedAt)))
      .limit(20) : []
    for (const run of active) {
      items.push({
        kind: run.status === 'RUNNING' || run.status === 'WAITING_FOR_AUTH' ? 'active' : 'confirmed',
        resource: 'run',
        id: run.id,
        label: run.status,
        href: `/runs/${run.id}`,
      })
    }
    if (schedules && canSeeSchedules) {
      try {
        const due = await db
          .select({ id: schedules.id })
          .from(schedules)
          .where(eq(schedules.targetAccountId, detail.targetAccountId))
          .limit(20)
        for (const row of due) {
          items.push({ kind: 'confirmed', resource: 'schedule', id: row.id, label: null, href: `/schedules/${row.id}` })
        }
      } catch {
        // 无调度表时忽略
      }
    }
    if (detail.session.sessionId) {
      items.push({
        kind: 'active',
        resource: 'session',
        id: detail.session.sessionId,
        label: detail.session.occupancy,
        href: detail.sessionHref,
      })
    }
  }
  return credentialUsageResponseSchema.parse({ asOf: now.toISOString(), items, withheld: !canSeeRuns || !canSeeSchedules })
}

export async function listCredentialHistory(
  db: Db,
  credentialId: string,
  query: CredentialHistoryQuery,
  actor: AuditActor,
) {
  await assertCredentialAccess(db, credentialId, actor.id, 'credential:read', true)
  const parsed = { limit: query.limit ?? 20, cursor: query.cursor }
  const { consoleAuditEvents, consoleAccounts } = schemaFor(db)
  const rows = await db
    .select({
      id: consoleAuditEvents.id,
      action: consoleAuditEvents.action,
      summary: consoleAuditEvents.summary,
      createdAt: consoleAuditEvents.createdAt,
      actorName: consoleAccounts.displayName,
    })
    .from(consoleAuditEvents)
    .leftJoin(consoleAccounts, eq(consoleAccounts.id, consoleAuditEvents.actorConsoleAccountId))
    .where(and(eq(consoleAuditEvents.resource, 'credential'), eq(consoleAuditEvents.resourceId, credentialId), cursorFilter(consoleAuditEvents.createdAt, consoleAuditEvents.id, parsed.cursor)))
    .orderBy(desc(consoleAuditEvents.createdAt), desc(consoleAuditEvents.id))
    .limit(parsed.limit + 1)
  const paginated = paginateResults(rows, parsed.limit)
  return credentialHistoryResponseSchema.parse({
    items: paginated.items.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      actorDisplayName: row.actorName,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: paginated.nextCursor,
  })
}

export async function loadAccountCredentialView(db: Db, accountId: string) {
  const { credentials, credentialMaintenancePolicies, credentialBindings, credentialVerifications } = schemaFor(db)
  const [credential] = await db.select().from(credentials).where(eq(credentials.id, accountId)).limit(1)
  if (!credential) return null
  const [policy] = await db
    .select()
    .from(credentialMaintenancePolicies)
    .where(eq(credentialMaintenancePolicies.credentialId, accountId))
    .limit(1)
  const [binding] = await db
    .select()
    .from(credentialBindings)
    .where(eq(credentialBindings.credentialId, accountId))
    .limit(1)
  const now = await clockNow(db)
  const validityPolicy = policy ? policyOf(policy) : { mode: 'unknown' as const, amount: null, timeZone: null }
  const dueAt = policy?.maintenanceDueAt ?? null
  const verify = await latestVerifications(db, [accountId])
  return {
    credentialId: credential.id,
    credentialRevision: credential.revision,
    validityPolicy,
    validityStartedAt: iso(policy?.validityStartedAt ?? null),
    maintenanceDueAt: iso(dueAt),
    maintenanceStatus: deriveMaintenanceStatus({
      policy: validityPolicy,
      dueAt,
      now,
      reminderLeadDays: policy?.expiryReminderLeadDays ?? 14,
    }),
    ownerConsoleAccountId: credential.ownerConsoleAccountId,
    ownerStatus: ownerStatus(credential.ownerConsoleAccountId, null),
    verificationStatus: (verify.get(accountId) ?? (credential.currentVersionId ? 'pending' : 'not_applicable')) as
      | 'pending'
      | 'verified'
      | 'failed'
      | 'inconclusive'
      | 'not_applicable',
    identityBindingStatus: binding?.identityConfirmStatus ?? 'confirmed',
    issuerExpiresAt: iso(policy?.issuerExpiresAt ?? null),
    issuerExpirySource: policy?.issuerExpirySource ?? 'unknown',
  }
}

export async function registerCredential(
  db: Db, body: CredentialRegisterBody, actor: AuditActor, sealed?: SealedSecret | null,
): Promise<CredentialDetail> {
  return atomic(db, async (tx) => {
    if (body.type !== 'target_password' || !body.targetAccountId) throw badRequest('CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '此处仅管理目标账号凭据')
    await lockConsoleAuthorization(tx, actor.id)
    const { targetAccounts } = schemaFor(tx)
    const [account] = await tx.select().from(targetAccounts).where(and(eq(targetAccounts.id, body.targetAccountId), isNull(targetAccounts.deletedAt))).for('update')
    if (!account) throw notFound('CREDENTIAL_NOT_FOUND', '账号不存在或无权访问')
    await assertTargetPermission(tx, actor.id, account.targetId, 'credential:write')
    await assertTargetPermission(tx, actor.id, account.targetId, 'credential:read')
    return registerCredentialImpl(tx, body, actor, sealed)
  })
}

async function registerCredentialImpl(
  db: Db,
  body: CredentialRegisterBody,
  actor: AuditActor,
  sealed?: SealedSecret | null,
): Promise<CredentialDetail> {
  const permissions = await actorPermissions(db, actor.id)
  if (!canWriteCredentialType(permissions, body.type)) throw forbidden('FORBIDDEN', '无权登记该凭据')
  if (body.type === 'target_password') {
    if (!body.targetAccountId) throw badRequest('CREDENTIAL_CONSUMER_REQUIRED', '必须选择已有账号')
    if (!sealed) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '登记目标密码必须提供秘密材料')
    const { targetAccounts } = schemaFor(db)
    const [account] = await db.select().from(targetAccounts).where(eq(targetAccounts.id, body.targetAccountId)).limit(1)
    if (!account || account.deletedAt) throw notFound('CREDENTIAL_NOT_FOUND', '目标账号不存在')
    await replaceTargetAccountSecret(db, {
      account: {
        id: account.id,
        targetId: account.targetId,
        displayName: body.name ?? account.displayName,
        username: account.username,
        configRevision: account.configRevision,
        secretId: sealed.id,
        secretProvider: sealed.provider,
      },
      sealed,
      validity: body.validity,
      actor,
    })
    if (
      body.ownerConsoleAccountId !== undefined ||
      body.notes !== undefined ||
      body.purpose !== undefined ||
      body.tags !== undefined ||
      body.name
    ) {
      const latest = await getCredential(db, account.id, actor)
      await updateCredentialMetadata(
        db,
        account.id,
        {
          expectedRevision: latest.revision,
          name: body.name,
          ownerConsoleAccountId: body.ownerConsoleAccountId,
          notes: body.notes,
          purpose: body.purpose,
          tags: body.tags,
        },
        actor,
      )
    }
    return getCredential(db, account.id, actor)
  }
  if (body.type === 'model_key') {
    if (!sealed) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '登记模型密钥必须提供材料')
    return getCredential(db, sealed.id, actor)
  }
  if (!body.alertChannelId || !sealed) throw badRequest('CREDENTIAL_CONSUMER_REQUIRED', '必须选择已有告警渠道')
  await replaceAlertWebhookSecret(db, {
    channelId: body.alertChannelId,
    channelName: body.name ?? 'Webhook',
    sealed,
    actor,
  })
  return getCredential(db, body.alertChannelId, actor)
}

export async function replaceCredentialMaterial(
  db: Db, credentialId: string, body: CredentialReplaceBody, actor: AuditActor, sealed?: SealedSecret | null,
): Promise<CredentialDetail> {
  return atomic(db, async (tx) => {
    await assertCredentialAccess(tx, credentialId, actor.id, 'credential:write')
    return replaceCredentialMaterialImpl(tx, credentialId, body, actor, sealed)
  })
}

async function replaceCredentialMaterialImpl(
  db: Db,
  credentialId: string,
  body: CredentialReplaceBody,
  actor: AuditActor,
  sealed?: SealedSecret | null,
): Promise<CredentialDetail> {
  const current = await getCredential(db, credentialId, actor)
  const permissions = await actorPermissions(db, actor.id)
  if (!canWriteCredentialType(permissions, current.type)) throw forbidden('FORBIDDEN', '无权修改该凭据')
  if (current.type === 'service_key') {
    throw badRequest('CREDENTIAL_TYPE_ACTION_UNSUPPORTED', '服务 Key 只能从开放服务轮换')
  }
  if (current.revision !== body.expectedRevision) {
    throw conflict('CREDENTIAL_REVISION_CONFLICT', '凭据已被他人更新', { currentRevision: current.revision })
  }
  if (!sealed) throw badRequest('CREDENTIAL_MATERIAL_UNAVAILABLE', '替换必须提供秘密材料')
  if (current.type === 'target_password') {
    if (!current.targetAccountId) throw badRequest('CREDENTIAL_BINDING_MISMATCH', '该凭据未绑定目标账号')
    const { targetAccounts } = schemaFor(db)
    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, current.targetAccountId))
      .limit(1)
    if (!account) throw notFound('CREDENTIAL_NOT_FOUND', '目标账号不存在')
    await replaceTargetAccountSecret(db, {
      account: {
        id: account.id,
        targetId: account.targetId,
        displayName: account.displayName,
        username: account.username,
        configRevision: account.configRevision,
        secretId: sealed.id,
        secretProvider: sealed.provider,
      },
      sealed,
      validity: body.validity,
      expectedRevision: body.expectedRevision,
      actor,
    })
    if (body.confirmIdentityMaterial) {
      const { confirmIdentityMaterial } = await import('./sync.js')
      await confirmIdentityMaterial(db, {
        account: {
          id: account.id,
          targetId: account.targetId,
          displayName: account.displayName,
          username: account.username,
          configRevision: account.configRevision,
          secretId: sealed.id,
          secretProvider: sealed.provider,
        },
        actor,
      })
    }
    return getCredential(db, credentialId, actor)
  }
  if (current.type === 'alert_webhook') {
    await replaceAlertWebhookSecret(db, {
      channelId: credentialId,
      channelName: current.name,
      sealed,
      actor,
    })
    return getCredential(db, credentialId, actor)
  }
  const { credentials, credentialVersions } = schemaFor(db)
  const now = await clockNow(db)
  await db
    .update(credentialVersions)
    .set({ materialStatus: 'superseded' })
    .where(and(eq(credentialVersions.credentialId, credentialId), eq(credentialVersions.materialStatus, 'current')))
  await db.insert(credentialVersions).values({
    id: sealed.id,
    credentialId,
    secretProvider: sealed.provider,
    secretId: sealed.id,
    materialStatus: 'current',
    registeredAt: now,
    createdAt: now,
  })
  await db
    .update(credentials)
    .set({ currentVersionId: sealed.id, revision: current.revision + 1, updatedAt: now })
    .where(eq(credentials.id, credentialId))
  await updateCredentialMetadata(
    db,
    credentialId,
    {
      expectedRevision: current.revision + 1,
      validity: body.validity,
      startedAt: body.validity.startedAt,
    },
    actor,
  )
  return getCredential(db, credentialId, actor)
}

export async function clearCredential(db: Db, id: string, body: CredentialRevisionBody, actor: AuditActor, remove = false) {
  return atomic(db, async (tx) => {
    await assertCredentialAccess(tx, id, actor.id, remove ? 'credential:delete' : 'credential:write')
    if (remove) await assertCredentialAccess(tx, id, actor.id, 'credential:write')
    const current = await getCredential(tx, id, actor)
    if (current.revision !== body.expectedRevision) throw conflict('CREDENTIAL_REVISION_CONFLICT', '账号凭据已变化，请重新核对')
    await assertResourceIdle(tx, { targetAccountId: id })
    const { credentials, runs } = schemaFor(tx)
    const [running] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.targetAccountId, id),
      inArray(runs.status, ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING', 'NEEDS_REVIEW']), isNull(runs.deletedAt))).limit(1)
    if (running) throw conflict('CREDENTIAL_BUSY', '账号仍有未完成运行，请先处理运行后再清除')
    await clearTargetAccountSecrets(tx, { accountId: id, actor })
    if (remove) {
      await tx.update(credentials).set({ deletedAt: await clockNow(tx) }).where(eq(credentials.id, id))
      await recordAudit(tx, consoleActor(actor), 'credential.metadata', 'credential', id, '删除凭据登记，保留目标账号及历史')
    }
    return { id, deleted: remove }
  })
}
