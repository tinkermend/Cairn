import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  FACTORY_PLATFORM_CONFIG,
  assertAuthScopeWithinTarget,
  assertFreshnessInRange,
  authObservationSchema,
  authProfileValidationSchema,
  authValidationOperationSchema,
  deriveAuthCapability,
  digestAuthPayload,
  originsFromTargetUrls,
  platformConfigDocumentSchema,
  requiredValidationSteps,
  resolveFreshnessSeconds,
  targetAuthProfileDefinitionSchema,
  targetAuthProfileViewSchema,
  validationStepComplete,
  type AuthObservation,
  type AuthValidationStep,
  type FrozenAuthVerification,
  type PlatformSessionAuth,
  type TargetAuthProfileDefinition,
  type TargetAuthProfileView,
} from '@cairn/shared'
import type { AuditActor } from '../audit/record.js'
import { recordAudit } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import type { SessionOperationRow } from '../records.js'
import { requestSessionOperation } from './occupancy.js'

type AuthKindParams = {
  revision: number
  requiredSteps: AuthValidationStep[]
  observations: Partial<Record<AuthValidationStep, AuthObservation>>
}

export async function readLiveSessionAuth(db: Db): Promise<{ sessionAuth: PlatformSessionAuth; revision: number }> {
  const { platformConfig } = schemaFor(db)
  const [row] = await db.select().from(platformConfig).limit(1)
  const document = platformConfigDocumentSchema.parse(row?.document ?? FACTORY_PLATFORM_CONFIG)
  return { sessionAuth: document.sessionAuth, revision: row?.revision ?? 1 }
}

export async function loadAuthProfileRevision(
  db: Db,
  targetId: string,
  revision: number,
): Promise<{
  revision: number
  definition: TargetAuthProfileDefinition
  digest: string
  validation: ReturnType<typeof authProfileValidationSchema.parse> | null
} | null> {
  const { targetAuthProfiles } = schemaFor(db)
  const [row] = await db
    .select()
    .from(targetAuthProfiles)
    .where(and(eq(targetAuthProfiles.targetId, targetId), eq(targetAuthProfiles.revision, revision)))
    .limit(1)
  if (!row) return null
  return {
    revision: row.revision,
    definition: targetAuthProfileDefinitionSchema.parse(row.definition),
    digest: row.digest,
    validation: row.validation ? authProfileValidationSchema.parse(row.validation) : null,
  }
}

export async function loadCurrentAuthProfile(
  db: Db,
  targetId: string,
): Promise<{
  revision: number
  definition: TargetAuthProfileDefinition
  digest: string
  validation: ReturnType<typeof authProfileValidationSchema.parse> | null
  createdAt: Date
  createdBy: string | null
} | null> {
  const { targets, targetAuthProfiles } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, targetId)).limit(1)
  if (!target || !target.currentAuthProfileRevision) return null
  const [row] = await db
    .select()
    .from(targetAuthProfiles)
    .where(
      and(
        eq(targetAuthProfiles.targetId, targetId),
        eq(targetAuthProfiles.revision, target.currentAuthProfileRevision),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    revision: row.revision,
    definition: targetAuthProfileDefinitionSchema.parse(row.definition),
    digest: row.digest,
    validation: row.validation ? authProfileValidationSchema.parse(row.validation) : null,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export async function freezeAuthVerificationForRun(
  db: Db,
  input: {
    targetId: string
    targetAccountId?: string | null
    loginFields: unknown
    platformRevision: number
    sessionAuth: PlatformSessionAuth
  },
): Promise<FrozenAuthVerification> {
  const profile = await loadCurrentAuthProfile(db, input.targetId)
  let expectedIdentity: string | null = null
  if (input.targetAccountId) {
    const { targetAccounts } = schemaFor(db)
    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, input.targetAccountId))
      .limit(1)
    expectedIdentity = account?.expectedIdentity ?? null
  }
  const capability = deriveAuthCapability({
    definition: profile?.definition ?? null,
    validation: profile?.validation ?? null,
    expectedIdentity,
  })
  return {
    profileRevision: profile?.revision ?? null,
    profileDigest: profile?.digest ?? null,
    loginFieldsDigest: await digestAuthPayload(input.loginFields ?? null),
    expectedIdentity,
    capability,
    freshnessSeconds: resolveFreshnessSeconds(profile?.definition ?? null, input.sessionAuth),
    verifyTimeoutMs: input.sessionAuth.verifyTimeoutMs,
    loginTimeoutMs: input.sessionAuth.loginTimeoutMs,
    verifyRetryBackoffSeconds: [...input.sessionAuth.verifyRetryBackoffSeconds],
    platformConfigRevision: input.platformRevision,
  }
}

export async function getTargetAuthProfileView(db: Db, targetId: string): Promise<TargetAuthProfileView> {
  const { targets, targetAccounts, targetAuthProfiles, targetAccountAuthBudget, browserSessions } = schemaFor(db)
  const [target] = await db.select().from(targets).where(and(eq(targets.id, targetId), isNull(targets.deletedAt))).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  const historyRows = await db
    .select()
    .from(targetAuthProfiles)
    .where(eq(targetAuthProfiles.targetId, targetId))
    .orderBy(desc(targetAuthProfiles.revision))
  const history = historyRows.map((row) => ({
    revision: row.revision,
    definition: targetAuthProfileDefinitionSchema.parse(row.definition),
    digest: row.digest,
    validation: row.validation ? authProfileValidationSchema.parse(row.validation) : null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  }))
  const current = history.find((item) => item.revision === target.currentAuthProfileRevision) ?? null
  const accounts = await db
    .select()
    .from(targetAccounts)
    .where(and(eq(targetAccounts.targetId, targetId), isNull(targetAccounts.deletedAt)))
  const accountIds = accounts.map((row) => row.id)
  const budgets =
    accountIds.length === 0
      ? []
      : await db
          .select()
          .from(targetAccountAuthBudget)
          .where(inArray(targetAccountAuthBudget.targetAccountId, accountIds))
  const sessions =
    accountIds.length === 0
      ? []
      : await db
          .select()
          .from(browserSessions)
          .where(inArray(browserSessions.targetAccountId, accountIds))
          .orderBy(desc(browserSessions.lastAuthCheckedAt), desc(browserSessions.updatedAt))
  const budgetByAccount = new Map(budgets.map((row) => [row.targetAccountId, row]))
  const sessionByAccount = new Map<string, (typeof sessions)[number]>()
  for (const session of sessions) {
    if (!sessionByAccount.has(session.targetAccountId)) sessionByAccount.set(session.targetAccountId, session)
  }
  return targetAuthProfileViewSchema.parse({
    current,
    history,
    accounts: accounts.map((account) => {
      const session = sessionByAccount.get(account.id)
      return {
        accountId: account.id,
        expectedIdentity: account.expectedIdentity,
        configRevision: account.configRevision,
        capability: deriveAuthCapability({
          definition: current?.definition ?? null,
          validation: current?.validation ?? null,
          expectedIdentity: account.expectedIdentity,
        }),
        lastAuthCheckedAt: session?.lastAuthCheckedAt?.toISOString() ?? null,
        lastAuthSuccessAt: session?.lastAuthSuccessAt?.toISOString() ?? null,
        lastAuthError: session?.lastAuthError ?? null,
        autoLoginPausedReason: budgetByAccount.get(account.id)?.pausedReason ?? null,
      }
    }),
  })
}

export async function publishTargetAuthProfile(
  db: Db,
  input: {
    targetId: string
    expectedRevision: number
    definition: TargetAuthProfileDefinition
    actor: AuditActor
  },
): Promise<TargetAuthProfileView> {
  const definition = targetAuthProfileDefinitionSchema.parse(input.definition)
  const { sessionAuth } = await readLiveSessionAuth(db)
  assertFreshnessInRange(definition.freshnessSeconds, sessionAuth)
  const { targets } = schemaFor(db)
  const [target] = await db.select().from(targets).where(and(eq(targets.id, input.targetId), isNull(targets.deletedAt))).limit(1)
  if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  assertAuthScopeWithinTarget(definition, originsFromTargetUrls(target.entryUrl, target.loginUrl))
  const digest = await digestAuthPayload({
    definition,
    loginFields: target.loginFields ?? null,
    authMethod: target.authMethod,
    captchaMode: target.captchaMode,
  })
  await atomic(db, async (tx) => {
    const lockedTarget = await lockTarget(tx, input.targetId)
    if (!lockedTarget || lockedTarget.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
    const current = lockedTarget.currentAuthProfileRevision ?? 0
    if (current !== input.expectedRevision) {
      throw conflict('AUTH_PROFILE_CONFLICT', '认证规则已被他人更新', { currentRevision: current })
    }
    const now = await clockNow(tx)
    const { targetAuthProfiles, targetAccounts, targetAccountAuthBudget } = schemaFor(tx)
    const revision = current + 1
    await insertRows(tx, targetAuthProfiles, {
      id: newId(),
      targetId: input.targetId,
      revision,
      definition,
      digest,
      validation: null,
      createdBy: input.actor.id,
      createdAt: now,
    })
    await updateRows(tx, targets, { currentAuthProfileRevision: revision, updatedAt: now }, eq(targets.id, input.targetId))
    const accountRows = await tx.select({ id: targetAccounts.id }).from(targetAccounts).where(eq(targetAccounts.targetId, input.targetId))
    if (accountRows.length > 0) {
      await tx
        .update(targetAccounts)
        .set({ configRevision: sql`${targetAccounts.configRevision} + 1`, updatedAt: now })
        .where(eq(targetAccounts.targetId, input.targetId))
      await tx
        .update(targetAccountAuthBudget)
        .set({
          consecutiveFailures: 0,
          pausedReason: null,
          nextAllowedAt: null,
          updatedAt: now,
        })
        .where(
          inArray(
            targetAccountAuthBudget.targetAccountId,
            accountRows.map((row) => row.id),
          ),
        )
    }
    await recordAudit(tx, input.actor, 'target.update', 'target', input.targetId, `发布登录核验规则 r${revision}`)
  })
  return getTargetAuthProfileView(db, input.targetId)
}

export async function updateTargetAccountIdentity(
  db: Db,
  input: {
    targetId: string
    accountId: string
    expectedRevision: number
    expectedIdentity: string | null
    actor: AuditActor
  },
) {
  const { targetAccounts, targetAccountAuthBudget } = schemaFor(db)
  await atomic(db, async (tx) => {
    const account = await lockAccount(tx, input.accountId)
    if (!account || account.deletedAt || account.targetId !== input.targetId) {
      throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在')
    }
    if (account.configRevision !== input.expectedRevision) {
      throw conflict('AUTH_IDENTITY_CONFLICT', '账号身份配置已被他人更新', { currentRevision: account.configRevision })
    }
    const now = await clockNow(tx)
    await updateRows(
      tx,
      targetAccounts,
      {
        expectedIdentity: input.expectedIdentity,
        configRevision: account.configRevision + 1,
        updatedAt: now,
      },
      eq(targetAccounts.id, input.accountId),
    )
    await tx
      .update(targetAccountAuthBudget)
      .set({
        consecutiveFailures: 0,
        pausedReason: null,
        nextAllowedAt: null,
        lastConfigRevision: account.configRevision + 1,
        updatedAt: now,
      })
      .where(eq(targetAccountAuthBudget.targetAccountId, input.accountId))
    await recordAudit(tx, input.actor, 'target_account.update', 'target_account', input.accountId, '更新期望登录身份')
  })
}

export async function resetAuthBudgetAfterCredentialChange(db: Db, accountId: string): Promise<void> {
  const { targetAccounts, targetAccountAuthBudget } = schemaFor(db)
  const now = new Date()
  const [account] = await updateRows(
    db,
    targetAccounts,
    { configRevision: sql`${targetAccounts.configRevision} + 1`, updatedAt: now },
    eq(targetAccounts.id, accountId),
    { id: targetAccounts.id, configRevision: targetAccounts.configRevision },
  )
  if (!account) return
  await txUpdateBudget(db, accountId, {
    consecutiveFailures: 0,
    pausedReason: null,
    nextAllowedAt: null,
    lastConfigRevision: account.configRevision,
    updatedAt: now,
  })
}

async function txUpdateBudget(
  db: Db,
  accountId: string,
  patch: {
    consecutiveFailures: number
    pausedReason: string | null
    nextAllowedAt: Date | null
    lastConfigRevision: number
    updatedAt: Date
  },
): Promise<void> {
  const { targetAccountAuthBudget } = schemaFor(db)
  const [existing] = await db
    .select()
    .from(targetAccountAuthBudget)
    .where(eq(targetAccountAuthBudget.targetAccountId, accountId))
    .limit(1)
  if (existing) {
    await updateRows(db, targetAccountAuthBudget, patch, eq(targetAccountAuthBudget.targetAccountId, accountId))
    return
  }
  await insertRows(db, targetAccountAuthBudget, {
    id: newId(),
    targetAccountId: accountId,
    windowStartedAt: patch.updatedAt,
    autoLoginCount: 0,
    ...patch,
  })
}

export async function occupyAutoLoginBudget(
  db: Db,
  input: { targetId: string; targetAccountId: string },
): Promise<{ ok: true; platformRevision: number } | { ok: false; code: string; message: string }> {
  const { sessionAuth, revision } = await readLiveSessionAuth(db)
  return atomic(db, async (tx) => {
    const { targets, targetAccounts, targetAccountAuthBudget } = schemaFor(tx)
    const [target] = await locked(tx, tx.select().from(targets).where(eq(targets.id, input.targetId)))
    const account = await lockAccount(tx, input.targetAccountId)
    if (!target || target.deletedAt || target.status === 'disabled' || !account || account.deletedAt || account.status === 'disabled') {
      return { ok: false as const, code: 'AUTH_CONFIGURATION_REVOKED', message: '目标或账号已停用' }
    }
    if (account.targetId !== input.targetId) {
      return { ok: false as const, code: 'AUTH_CONFIGURATION_REVOKED', message: '账号不属于该目标' }
    }
    const now = await clockNow(tx)
    const [budget] = await locked(
      tx,
      tx.select().from(targetAccountAuthBudget).where(eq(targetAccountAuthBudget.targetAccountId, input.targetAccountId)),
    )
    const windowMs = sessionAuth.autoLoginWindowSeconds * 1000
    const configChanged = !budget || budget.lastConfigRevision !== account.configRevision
    const windowExpired = !budget || now.getTime() - budget.windowStartedAt.getTime() >= windowMs
    const resetWindow = configChanged || windowExpired
    const paused = Boolean(budget?.pausedReason) && !configChanged
    if (paused) {
      return { ok: false as const, code: 'AUTH_AUTO_LOGIN_PAUSED', message: budget!.pausedReason ?? '自动登录已暂停' }
    }
    const count = resetWindow ? 0 : budget!.autoLoginCount
    if (count >= sessionAuth.autoLoginMaxPerWindow) {
      return { ok: false as const, code: 'AUTH_AUTO_LOGIN_PAUSED', message: '本窗口自动登录次数已用尽' }
    }
    const next = {
      windowStartedAt: resetWindow ? now : budget!.windowStartedAt,
      autoLoginCount: count + 1,
      consecutiveFailures: configChanged ? 0 : (budget?.consecutiveFailures ?? 0),
      pausedReason: configChanged ? null : (budget?.pausedReason ?? null),
      nextAllowedAt: configChanged ? null : (budget?.nextAllowedAt ?? null),
      lastConfigRevision: account.configRevision,
      updatedAt: now,
    }
    if (budget) {
      await updateRows(tx, targetAccountAuthBudget, next, eq(targetAccountAuthBudget.id, budget.id))
    } else {
      await insertRows(tx, targetAccountAuthBudget, {
        id: newId(),
        targetAccountId: input.targetAccountId,
        ...next,
      })
    }
    return { ok: true as const, platformRevision: revision }
  })
}

export async function recordAutoLoginOutcome(
  db: Db,
  input: {
    targetAccountId: string
    result: 'success' | 'credential' | 'verify_failed'
    sessionAuth: PlatformSessionAuth
  },
): Promise<void> {
  const { targetAccountAuthBudget } = schemaFor(db)
  const now = new Date()
  const [budget] = await db
    .select()
    .from(targetAccountAuthBudget)
    .where(eq(targetAccountAuthBudget.targetAccountId, input.targetAccountId))
    .limit(1)
  if (!budget) return
  if (input.result === 'success') {
    await updateRows(
      db,
      targetAccountAuthBudget,
      { consecutiveFailures: 0, pausedReason: null, nextAllowedAt: null, updatedAt: now },
      eq(targetAccountAuthBudget.id, budget.id),
    )
    return
  }
  if (input.result === 'credential') {
    await updateRows(
      db,
      targetAccountAuthBudget,
      { pausedReason: 'credential_or_challenge', nextAllowedAt: now, updatedAt: now },
      eq(targetAccountAuthBudget.id, budget.id),
    )
    return
  }
  const failures = budget.consecutiveFailures + 1
  const paused = failures >= input.sessionAuth.autoLoginPauseAfterFailures
  await updateRows(
    db,
    targetAccountAuthBudget,
    {
      consecutiveFailures: failures,
      pausedReason: paused ? 'consecutive_verify_failures' : budget.pausedReason,
      nextAllowedAt: paused ? now : budget.nextAllowedAt,
      updatedAt: now,
    },
    eq(targetAccountAuthBudget.id, budget.id),
  )
}

export async function startAuthProfileValidation(
  db: Db,
  input: {
    targetId: string
    targetAccountId: string
    expectedRevision: number
    idempotencyKey: string
    actor: AuditActor
  },
) {
  const profile = await loadCurrentAuthProfile(db, input.targetId)
  if (!profile) throw badRequest('AUTH_PROFILE_REQUIRED', '尚未发布登录核验规则')
  if (profile.revision !== input.expectedRevision) {
    throw conflict('AUTH_PROFILE_CONFLICT', '认证规则修订已变化', { currentRevision: profile.revision })
  }
  const { targetAccounts } = schemaFor(db)
  const [account] = await db
    .select()
    .from(targetAccounts)
    .where(and(eq(targetAccounts.id, input.targetAccountId), eq(targetAccounts.targetId, input.targetId)))
    .limit(1)
  if (!account || account.deletedAt) throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在')
  const kindParams: AuthKindParams = {
    revision: profile.revision,
    requiredSteps: requiredValidationSteps(profile.definition),
    observations: {},
  }
  const requested = await requestSessionOperation(db, {
    key: { targetId: input.targetId, targetAccountId: input.targetAccountId },
    kind: 'VALIDATE_AUTH_PROFILE',
    kindParams,
    origin: 'USER',
    idempotencyKey: input.idempotencyKey,
  })
  await recordAudit(
    db,
    input.actor,
    'target.update',
    'target',
    input.targetId,
    `提交登录核验验收 ${requested.operation.id}`,
  )
  return { operation: toValidationOperation(requested.operation, null), created: requested.created }
}

export async function getAuthProfileValidation(db: Db, input: { targetId: string; operationId: string }) {
  const { sessionOperations, sessionLeases } = schemaFor(db)
  const [operation] = await db
    .select()
    .from(sessionOperations)
    .where(and(eq(sessionOperations.id, input.operationId), eq(sessionOperations.targetId, input.targetId)))
    .limit(1)
  if (!operation || operation.kind !== 'VALIDATE_AUTH_PROFILE') {
    throw notFound('AUTH_VALIDATION_NOT_FOUND', '验收操作不存在')
  }
  const [lease] = await db
    .select()
    .from(sessionLeases)
    .where(and(eq(sessionLeases.operationId, operation.id), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  return toValidationOperation(operation, lease?.sessionId ?? operation.expectedSessionId)
}

export async function observeAuthProfileValidation(
  db: Db,
  input: {
    targetId: string
    operationId: string
    step: AuthValidationStep
    observation: AuthObservation
    actor: AuditActor
  },
) {
  const observation = authObservationSchema.parse(input.observation)
  assertProducedObservation(observation)
  if (!validationStepComplete(input.step, observation)) {
    throw badRequest('AUTH_VALIDATION_INCOMPLETE', '该步核验结论尚未满足')
  }
  return atomic(db, async (tx) => {
    const { sessionOperations, targetAuthProfiles, sessionLeases } = schemaFor(tx)
    const [operation] = await locked(tx, tx.select().from(sessionOperations).where(eq(sessionOperations.id, input.operationId)))
    if (!operation || operation.targetId !== input.targetId || operation.kind !== 'VALIDATE_AUTH_PROFILE') {
      throw notFound('AUTH_VALIDATION_NOT_FOUND', '验收操作不存在')
    }
    if (!['RUNNING', 'WAITING_FOR_AUTH'].includes(operation.status)) {
      throw conflict('AUTH_VALIDATION_NOT_OPEN', '验收操作已结束')
    }
    const params = parseKindParams(operation.kindParams)
    if (!params.requiredSteps.includes(input.step)) {
      throw badRequest('AUTH_VALIDATION_INCOMPLETE', '该修订不需要此验收步')
    }
    params.observations[input.step] = observation
    const now = await clockNow(tx)
    const complete = params.requiredSteps.every((step) => {
      const item = params.observations[step]
      return item ? validationStepComplete(step, item) : false
    })
    await updateRows(
      tx,
      sessionOperations,
      { kindParams: params, updatedAt: now, ...(complete ? { status: 'SUCCEEDED', finishedAt: now } : {}) },
      eq(sessionOperations.id, operation.id),
    )
    if (complete) {
      const recorded = authProfileValidationSchema.parse({
        recordedAt: now.toISOString(),
        actorId: input.actor.id,
        operationId: operation.id,
        steps: params.observations,
      })
      await updateRows(
        tx,
        targetAuthProfiles,
        { validation: recorded },
        and(eq(targetAuthProfiles.targetId, input.targetId), eq(targetAuthProfiles.revision, params.revision)),
      )
      const [lease] = await tx
        .select()
        .from(sessionLeases)
        .where(and(eq(sessionLeases.operationId, operation.id), eq(sessionLeases.status, 'ACTIVE')))
        .limit(1)
      if (lease) {
        await updateRows(
          tx,
          sessionLeases,
          { status: 'RELEASED', releasedAt: now, releaseReason: 'operation_succeeded' },
          eq(sessionLeases.id, lease.id),
        )
      }
    }
    const [next] = await tx.select().from(sessionOperations).where(eq(sessionOperations.id, operation.id)).limit(1)
    return toValidationOperation(next!, null)
  })
}

export async function listTargetsOutsideFreshnessRange(
  db: Db,
  sessionAuth: PlatformSessionAuth,
): Promise<{ id: string; code: string }[]> {
  const { targets, targetAuthProfiles } = schemaFor(db)
  const rows = await db
    .select({
      id: targets.id,
      code: targets.code,
      definition: targetAuthProfiles.definition,
      revision: targets.currentAuthProfileRevision,
      profileRevision: targetAuthProfiles.revision,
    })
    .from(targets)
    .innerJoin(
      targetAuthProfiles,
      and(eq(targetAuthProfiles.targetId, targets.id), eq(targetAuthProfiles.revision, targets.currentAuthProfileRevision)),
    )
    .where(isNull(targets.deletedAt))
  return rows
    .filter((row) => {
      const definition = targetAuthProfileDefinitionSchema.parse(row.definition)
      const freshness = definition.freshnessSeconds
      if (freshness == null) return false
      return freshness < sessionAuth.freshnessSecondsMin || freshness > sessionAuth.freshnessSecondsMax
    })
    .map((row) => ({ id: row.id, code: row.code }))
}

export async function loadAccountAuthDisplay(
  db: Db,
  accountIds: string[],
): Promise<
  Map<
    string,
    {
      lastAuthCheckedAt: string | null
      lastAuthSuccessAt: string | null
      lastAuthError: string | null
      autoLoginPausedReason: string | null
    }
  >
> {
  const extras = new Map<
    string,
    {
      lastAuthCheckedAt: string | null
      lastAuthSuccessAt: string | null
      lastAuthError: string | null
      autoLoginPausedReason: string | null
    }
  >()
  if (accountIds.length === 0) return extras
  const { browserSessions, targetAccountAuthBudget } = schemaFor(db)
  const sessions = await db
    .select()
    .from(browserSessions)
    .where(inArray(browserSessions.targetAccountId, accountIds))
    .orderBy(desc(browserSessions.lastAuthCheckedAt), desc(browserSessions.updatedAt))
  for (const session of sessions) {
    if (extras.has(session.targetAccountId)) continue
    extras.set(session.targetAccountId, {
      lastAuthCheckedAt: session.lastAuthCheckedAt?.toISOString() ?? null,
      lastAuthSuccessAt: session.lastAuthSuccessAt?.toISOString() ?? null,
      lastAuthError: session.lastAuthError ?? null,
      autoLoginPausedReason: null,
    })
  }
  const budgets = await db
    .select()
    .from(targetAccountAuthBudget)
    .where(inArray(targetAccountAuthBudget.targetAccountId, accountIds))
  for (const budget of budgets) {
    const current = extras.get(budget.targetAccountId) ?? {
      lastAuthCheckedAt: null,
      lastAuthSuccessAt: null,
      lastAuthError: null,
      autoLoginPausedReason: null,
    }
    extras.set(budget.targetAccountId, { ...current, autoLoginPausedReason: budget.pausedReason })
  }
  return extras
}

export async function assertLiveAuthConfiguration(
  db: Db,
  input: { targetId: string; targetAccountId: string },
): Promise<{ ok: true } | { ok: false; code: 'AUTH_CONFIGURATION_REVOKED'; message: string }> {
  const { targets, targetAccounts } = schemaFor(db)
  const [target] = await db.select().from(targets).where(eq(targets.id, input.targetId)).limit(1)
  const [account] = await db.select().from(targetAccounts).where(eq(targetAccounts.id, input.targetAccountId)).limit(1)
  if (!target || target.deletedAt || target.status === 'disabled') {
    return { ok: false, code: 'AUTH_CONFIGURATION_REVOKED', message: '目标系统已停用或撤销' }
  }
  if (!account || account.deletedAt || account.status === 'disabled' || account.targetId !== input.targetId) {
    return { ok: false, code: 'AUTH_CONFIGURATION_REVOKED', message: '目标账号已停用或撤销' }
  }
  return { ok: true }
}

function parseKindParams(value: unknown): AuthKindParams {
  const raw = (value ?? {}) as AuthKindParams
  return {
    revision: Number(raw.revision),
    requiredSteps: Array.isArray(raw.requiredSteps) ? raw.requiredSteps : [],
    observations: raw.observations ?? {},
  }
}

function currentStep(params: AuthKindParams): AuthValidationStep | null {
  return params.requiredSteps.find((step) => {
    const item = params.observations[step]
    return !item || !validationStepComplete(step, item)
  }) ?? null
}

function toValidationOperation(operation: SessionOperationRow, sessionId: string | null) {
  const params = parseKindParams(operation.kindParams)
  return authValidationOperationSchema.parse({
    id: operation.id,
    targetId: operation.targetId,
    targetAccountId: operation.targetAccountId,
    status: operation.status,
    revision: params.revision,
    requiredSteps: params.requiredSteps,
    observations: params.observations,
    currentStep: currentStep(params),
    sessionId,
    ownerWorkerId: operation.ownerWorkerId,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    finishedAt: operation.finishedAt?.toISOString() ?? null,
    errorCode: operation.errorCode,
  })
}

function assertProducedObservation(observation: AuthObservation): void {
  if (observation.authState === 'UNKNOWN') {
    if (!observation.unknownClass) {
      throw badRequest('AUTH_VALIDATION_INCOMPLETE', 'UNKNOWN 必须带 unknownClass')
    }
    return
  }
  if (observation.diagnosticCode !== 'verified') {
    throw badRequest('AUTH_VALIDATION_INCOMPLETE', '观察必须来自核验端口，不能手写成功结论')
  }
}

async function lockTarget(tx: Db, targetId: string) {
  const { targets } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(targets).where(eq(targets.id, targetId)))
  return row ?? null
}

async function lockAccount(tx: Db, accountId: string) {
  const { targetAccounts } = schemaFor(tx)
  const [row] = await locked(tx, tx.select().from(targetAccounts).where(eq(targetAccounts.id, accountId)))
  return row ?? null
}
