import type { Target, TargetAccount } from '../records.js'
import { schemaFor, locked } from '../native.js'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  consoleAuditEvents,
  recordingDrafts,
  runLeases,
  runs,
  scenarios,
  secrets,
  sessionLeases,
  storedObjects,
  targetAccounts,
  targets,
} from '../schema/index.js'
import { newId } from '../id.js'
import type { Db } from '../client.js'
import { connection, type Database } from '../database.js'
import {
  failure,
  isUniqueViolation,
  isForeignKeyViolation,
  constraintName,
  mapRestriction,
} from '../runs/errors.js'
import {
  activeRunBlockers,
  assertExpectedCounts,
  assertResourceIdle,
  closeOpenBindings,
  deletedOccupancyMessage,
  pendingWriteBlockers,
  exclusiveSecretIds,
  requestSessionClose,
  revokeAccountGrants,
  revokeExternalEvidence,
  revokeTargetGrants,
  snapshotDeletedBy,
  toDeleteResult,
} from '../lifecycle.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import {
  ACTIVE_RUN_STATUSES,
  LOCAL_SECRET_PROVIDER,
  deriveAuthCapability,
  cleanupStatusResponseSchema,
  compactLoginFields,
  deletePreviewResponseSchema,
  targetAccountListQuerySchema,
  targetAccountListResponseSchema,
  targetAccountSchema,
  targetListQuerySchema,
  targetListResponseSchema,
  targetSchema,
  type AuditAction,
  type CleanupStatus,
  type CleanupStatusResponse,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type DeletePreviewResponse,
  type DeleteResourceBody,
  type DeleteResourceResult,
  type TargetAccountDto,
  type TargetAccountListQuery,
  type TargetAccountListResponse,
  type TargetDto,
  type TargetListQuery,
  type TargetListResponse,
  type TargetLoginFields,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
} from '@cairn/shared'
import type { PersistenceActor as RequestAccount } from './actor.js'
import { loadAccountAuthDisplay, loadCurrentAuthProfile, resetAuthBudgetAfterCredentialChange } from '../sessions/auth-profile.js'

function iso(value: Date): string {
  return value.toISOString()
}

async function rethrowUnique(
  db: Db,
  error: unknown,
  kind: 'target' | 'account',
  lookup: { code?: string; targetId?: string; username?: string },
): Promise<never> {
  if (isUniqueViolation(error)) {
    const name = constraintName(error)
    const accountConflict = name?.includes('target_accounts') || kind === 'account'
    if (!accountConflict || name?.includes('targets_code')) {
      const occupied = await deletedOccupancyMessage(db, 'target_code', { code: lookup.code })
      throw failure('conflict', {
        code: 'TARGET_CODE_CONFLICT',
        message: occupied ?? '目标系统编码已存在',
      })
    }
    const occupied = await deletedOccupancyMessage(db, 'account_username', {
      targetId: lookup.targetId,
      username: lookup.username,
    })
    throw failure('conflict', {
      code: 'TARGET_ACCOUNT_CONFLICT',
      message: occupied ?? '该目标系统下登录名已存在',
    })
  }
  throw error
}

export class TargetsStore {
  constructor(
    private readonly database: Database,
    private readonly encrypt: (id: string, password: string) => Buffer,
  ) {}

  private get db(): Db {
    return connection(this.database)
  }

  async listTargets(query: TargetListQuery = {}): Promise<TargetListResponse> {
    const parsed = targetListQuerySchema.parse(query)
    const { targets } = schemaFor(this.db)
    const limit = parsed.limit
    const filters: (SQL | undefined)[] = [
      isNull(targets.deletedAt),
      parsed.status ? eq(targets.status, parsed.status) : undefined,
      parsed.authMethod ? eq(targets.authMethod, parsed.authMethod) : undefined,
      parsed.search
        ? or(
            sql`lower(${targets.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
            sql`lower(${targets.code}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          )
        : undefined,
      cursorFilter(targets.createdAt, targets.id, parsed.cursor),
    ]
    const rows = await this.db
      .select()
      .from(targets)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(targets.createdAt), desc(targets.id))
      .limit(limit + 1)
    const counts = await this.accountCounts()
    const paginated = paginateResults(rows, limit)
    return targetListResponseSchema.parse({
      items: paginated.items.map((row) => this.toTarget(row, counts.get(row.id) ?? 0)),
      nextCursor: paginated.nextCursor,
      hasMore: paginated.hasMore,
    })
  }

  async getTarget(id: string): Promise<TargetDto> {
    const row = await this.loadTarget(id)
    const counts = await this.accountCounts(id)
    return this.toTarget(row, counts.get(id) ?? 0)
  }

  async createTarget(body: CreateTargetBody, actor: RequestAccount): Promise<TargetDto> {
    const { targets } = schemaFor(this.db)
    const id = newId()
    const now = new Date()
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(targets).values({
          id,
          code: body.code,
          name: body.name,
          entryUrl: body.entryUrl,
          loginUrl: body.loginUrl ?? null,
          authMethod: body.authMethod,
          captchaMode: body.captchaMode,
          status: body.status,
          loginFields: body.loginFields,
          createdAt: now,
          updatedAt: now,
        })
        await this.writeAudit(
          tx,
          actor,
          'target.create',
          'target',
          id,
          `${body.name}（${body.code}）`,
        )
        if (body.account) {
          await this.insertAccount(tx, id, body.account, actor, now)
        }
      })
    } catch (error) {
      await rethrowUnique(this.db, error, 'target', { code: body.code })
    }
    return this.getTarget(id)
  }

  async updateTarget(
    id: string,
    body: UpdateTargetBody,
    actor: RequestAccount,
  ): Promise<TargetDto> {
    const { targets } = schemaFor(this.db)
    const current = await this.loadTarget(id)
    const now = new Date()
    const loginOnly =
      body.loginFields !== undefined &&
      body.name === undefined &&
      body.entryUrl === undefined &&
      body.loginUrl === undefined &&
      body.authMethod === undefined &&
      body.captchaMode === undefined &&
      body.status === undefined
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(targets)
          .set({
            name: body.name ?? current.name,
            entryUrl: body.entryUrl ?? current.entryUrl,
            loginUrl: body.loginUrl === undefined ? current.loginUrl : body.loginUrl,
            authMethod: body.authMethod ?? current.authMethod,
            captchaMode: body.captchaMode ?? current.captchaMode,
            status: body.status ?? current.status,
            loginFields: body.loginFields === undefined ? current.loginFields : body.loginFields,
            updatedAt: now,
          })
          .where(eq(targets.id, id))
        await this.writeAudit(
          tx,
          actor,
          'target.update',
          'target',
          id,
          loginOnly ? '更新了登录框定位' : `${body.name ?? current.name}（${current.code}）`,
        )
      })
    } catch (error) {
      await rethrowUnique(this.db, error, 'target', { code: current.code })
    }
    return this.getTarget(id)
  }

  async previewDeleteTarget(id: string): Promise<DeletePreviewResponse> {
    const {
      targets,
      targetAccounts,
      scenarios,
      recordingDrafts,
      runs,
      storedObjects,
      runLeases,
      sessionLeases,
      browserSessions,
    } = schemaFor(this.db)
    const [target] = await this.db
      .select()
      .from(targets)
      .where(and(eq(targets.id, id), isNull(targets.deletedAt)))
      .limit(1)
    if (!target) {
      throw failure('not_found', { code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
    }

    const targetRunRows = await this.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(eq(runs.targetId, id), isNull(runs.deletedAt)))

    const activeRuns = targetRunRows.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status as any))
    const runIds = targetRunRows.map((r) => r.id)
    const activeRunLeases =
      runIds.length > 0
        ? await this.db
            .select({ id: runLeases.id })
            .from(runLeases)
            .where(and(inArray(runLeases.runId, runIds), eq(runLeases.status, 'ACTIVE')))
        : []

    const now = new Date()
    const sessions = await this.db
      .select({
        id: browserSessions.id,
        authHoldExpiresAt: browserSessions.authHoldExpiresAt,
        authControlExpiresAt: browserSessions.authControlExpiresAt,
      })
      .from(browserSessions)
      .where(eq(browserSessions.targetId, id))
    const sessionIds = sessions.map((row) => row.id)
    const activeSessionLeases =
      sessionIds.length > 0
        ? await this.db
            .select({ id: sessionLeases.id })
            .from(sessionLeases)
            .where(
              and(inArray(sessionLeases.sessionId, sessionIds), eq(sessionLeases.status, 'ACTIVE')),
            )
        : []
    const authHeld = sessions.some(
      (row) =>
        (row.authHoldExpiresAt && row.authHoldExpiresAt > now) ||
        (row.authControlExpiresAt && row.authControlExpiresAt > now),
    )

    const activeBlockers: { id: string; code: string; message: string }[] = [
      ...activeRunBlockers(activeRuns),
    ]
    if (activeRunLeases.length > 0 || activeSessionLeases.length > 0 || authHeld) {
      activeBlockers.push({
        id: 'resource_busy',
        code: 'RESOURCE_BUSY',
        message: '目标系统仍有活跃租约或认证占用，无法删除',
      })
    }
    activeBlockers.push(...(await pendingWriteBlockers(this.db, runIds)))

    const accounts = await this.db
      .select({ id: targetAccounts.id })
      .from(targetAccounts)
      .where(and(eq(targetAccounts.targetId, id), isNull(targetAccounts.deletedAt)))

    const scenarioRows = await this.db
      .select({ id: scenarios.id })
      .from(scenarios)
      .where(and(eq(scenarios.targetId, id), isNull(scenarios.deletedAt)))

    const recordingRows = await this.db
      .select({ id: recordingDrafts.id })
      .from(recordingDrafts)
      .where(and(eq(recordingDrafts.targetId, id), isNull(recordingDrafts.deletedAt)))

    const objects =
      runIds.length > 0
        ? await this.db
            .select({ id: storedObjects.id, byteSize: storedObjects.byteSize })
            .from(storedObjects)
            .where(and(inArray(storedObjects.runId, runIds), isNull(storedObjects.purgedAt)))
        : []
    const totalBytes = objects.reduce((sum, o) => sum + (o.byteSize ?? 0), 0)

    return deletePreviewResponseSchema.parse({
      previewToken: newId(),
      counts: {
        targetAccounts: accounts.length,
        scenarios: scenarioRows.length,
        recordings: recordingRows.length,
        runs: targetRunRows.length,
        storedObjects: objects.length,
        totalBytes,
      },
      blockers: activeBlockers,
    })
  }

  async deleteTarget(
    id: string,
    actor: RequestAccount,
    body?: DeleteResourceBody,
  ): Promise<CleanupStatusResponse> {
    const { targets, targetAccounts, actionModules, scenarios, recordingDrafts, runs, storedObjects } = schemaFor(
      this.db,
    )

    try {
      await this.db.transaction(async (tx) => {
        const [current] = await locked(tx, tx.select().from(targets).where(eq(targets.id, id)))
        if (!current) {
          throw failure('not_found', { code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
        }
        if (current.deletedAt) return

        const targetRunRows = await tx
          .select({ id: runs.id, status: runs.status })
          .from(runs)
          .where(and(eq(runs.targetId, id), isNull(runs.deletedAt)))

        const activeRuns = targetRunRows.filter((r) =>
          ACTIVE_RUN_STATUSES.includes(r.status as any),
        )
        if (activeRuns.length > 0) {
          throw failure('conflict', {
            code: 'RUN_NOT_TERMINAL',
            message: `目标系统存在 ${activeRuns.length} 个进行中的运行任务，无法删除`,
          })
        }

        const runIds = targetRunRows.map((r) => r.id)
        await assertResourceIdle(tx as unknown as Db, {
          runIds,
          targetId: id,
          checkPendingWrites: true,
        })

        const accounts = await tx
          .select({ id: targetAccounts.id })
          .from(targetAccounts)
          .where(and(eq(targetAccounts.targetId, id), isNull(targetAccounts.deletedAt)))

        const scenarioRows = await tx
          .select({ id: scenarios.id })
          .from(scenarios)
          .where(and(eq(scenarios.targetId, id), isNull(scenarios.deletedAt)))

        const recordingRows = await tx
          .select({ id: recordingDrafts.id })
          .from(recordingDrafts)
          .where(and(eq(recordingDrafts.targetId, id), isNull(recordingDrafts.deletedAt)))

        assertExpectedCounts(
          {
            targetAccounts: accounts.length,
            scenarios: scenarioRows.length,
            recordings: recordingRows.length,
            runs: targetRunRows.length,
          },
          body?.expectedCounts,
        )

        const now = new Date()
        const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)

        await tx
          .update(targets)
          .set({ deletedAt: now, deletedBy, updatedAt: now })
          .where(eq(targets.id, id))

        await tx.update(actionModules).set({ deletedAt: now, deletedBy, updatedAt: now })
          .where(and(eq(actionModules.targetId, id), isNull(actionModules.deletedAt)))

        if (accounts.length > 0) {
          const accountsWithSecrets = await tx
            .select({ id: targetAccounts.id, secretId: targetAccounts.secretId })
            .from(targetAccounts)
            .where(and(eq(targetAccounts.targetId, id), isNotNull(targetAccounts.secretId)))
          const secretIds = accountsWithSecrets
            .map((a) => a.secretId)
            .filter((s): s is string => s !== null)
          const exclusive = await exclusiveSecretIds(
            tx as unknown as Db,
            secretIds,
            accounts.map((row) => row.id),
          )

          await tx
            .update(targetAccounts)
            .set({ deletedAt: now, deletedBy, secretId: null, secretProvider: null, updatedAt: now })
            .where(and(eq(targetAccounts.targetId, id), isNull(targetAccounts.deletedAt)))

          if (exclusive.length > 0) {
            await tx.delete(secrets).where(inArray(secrets.id, exclusive))
          }
        }

        await closeOpenBindings(tx as unknown as Db, { targetId: id }, now)
        await revokeTargetGrants(tx as unknown as Db, id)
        await requestSessionClose(tx as unknown as Db, { targetId: id }, now)

        if (scenarioRows.length > 0) {
          await tx
            .update(scenarios)
            .set({ deletedAt: now, deletedBy, updatedAt: now })
            .where(and(eq(scenarios.targetId, id), isNull(scenarios.deletedAt)))
        }

        if (recordingRows.length > 0) {
          await tx
            .update(recordingDrafts)
            .set({ deletedAt: now, deletedBy, updatedAt: now })
            .where(and(eq(recordingDrafts.targetId, id), isNull(recordingDrafts.deletedAt)))
        }

        if (targetRunRows.length > 0) {
          await tx
            .update(runs)
            .set({ deletedAt: now, deletedBy, updatedAt: now })
            .where(and(eq(runs.targetId, id), isNull(runs.deletedAt)))
        }

        if (runIds.length > 0) {
          await revokeExternalEvidence(tx as unknown as Db, runIds)
          await tx
            .update(storedObjects)
            .set({ deleteRequestedAt: now })
            .where(
              and(
                inArray(storedObjects.runId, runIds),
                isNull(storedObjects.deleteRequestedAt),
                isNull(storedObjects.purgedAt),
              ),
            )
        }

        const [objectRow] = runIds.length
          ? await tx
              .select({
                n: sql<number>`count(*)`,
                bytes: sql<number>`coalesce(sum(${storedObjects.byteSize}), 0)`,
              })
              .from(storedObjects)
              .where(inArray(storedObjects.runId, runIds))
          : [{ n: 0, bytes: 0 }]
        await this.writeAudit(
          tx,
          actor,
          'target.delete',
          'target',
          id,
          `删除目标 ${current.name}（${current.code}）：账号 ${accounts.length}、场景 ${scenarioRows.length}、录制 ${recordingRows.length}、运行 ${targetRunRows.length}、对象 ${Number(objectRow?.n ?? 0)}、${Number(objectRow?.bytes ?? 0)} 字节`,
        )
      })
    } catch (error) {
      throw mapRestriction(error) ?? error
    }

    return this.getTargetCleanupStatus(id)
  }

  async getTargetCleanupStatus(id: string): Promise<CleanupStatusResponse> {
    const { runs, storedObjects, targets } = schemaFor(this.db)
    const [target] = await this.db.select({ id: targets.id }).from(targets).where(eq(targets.id, id)).limit(1)
    if (!target) {
      throw failure('not_found', { code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
    }
    const targetRunRows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.targetId, id))
    const targetRunIds = targetRunRows.map((r) => r.id)

    if (targetRunIds.length === 0) {
      return cleanupStatusResponseSchema.parse({
        resourceId: id,
        resourceType: 'target',
        status: 'completed',
        totalObjects: 0,
        purgedObjects: 0,
        failedObjects: 0,
        totalBytes: 0,
        purgedBytes: 0,
        lastError: null,
        completedAt: new Date().toISOString(),
      })
    }

    const objects = await this.db
      .select({
        status: storedObjects.status,
        byteSize: storedObjects.byteSize,
        purgeAttempts: storedObjects.purgeAttempts,
        lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
      })
      .from(storedObjects)
      .where(inArray(storedObjects.runId, targetRunIds))

    const total = objects.length
    const purged = objects.filter((o) => o.status === 'purged').length
    const failed = objects.filter(
      (o) => o.status !== 'purged' && (o.purgeAttempts >= 5 || o.lastPurgeErrorAt !== null),
    ).length
    const totalBytes = objects.reduce((sum, o) => sum + (o.byteSize ?? 0), 0)
    const purgedBytes = objects
      .filter((o) => o.status === 'purged')
      .reduce((sum, o) => sum + (o.byteSize ?? 0), 0)

    const status: CleanupStatus =
      failed > 0
        ? 'failed'
        : total === purged || total === 0
          ? 'completed'
          : purged > 0
            ? 'in_progress'
            : 'pending'

    return cleanupStatusResponseSchema.parse({
      resourceId: id,
      resourceType: 'target',
      status,
      totalObjects: total,
      purgedObjects: purged,
      failedObjects: failed,
      totalBytes,
      purgedBytes,
      lastError: failed > 0 ? '部分对象文件清理失败，请重试' : null,
      completedAt: status === 'completed' ? new Date().toISOString() : null,
    })
  }

  async retryTargetCleanup(id: string, actor: RequestAccount): Promise<CleanupStatusResponse> {
    await this.getTargetCleanupStatus(id)
    const { runs, storedObjects } = schemaFor(this.db)
    const targetRunRows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.targetId, id))
    const targetRunIds = targetRunRows.map((r) => r.id)
    if (targetRunIds.length > 0) {
      await this.db
        .update(storedObjects)
        .set({ purgeAttempts: 0, lastPurgeErrorAt: null })
        .where(
          and(inArray(storedObjects.runId, targetRunIds), ne(storedObjects.status, 'purged')),
        )
      await this.writeAudit(this.db, actor, 'target.cleanup_retry', 'target', id, '重试对象清理')
    }
    return this.getTargetCleanupStatus(id)
  }

  async listAccounts(
    targetId: string,
    query: TargetAccountListQuery = {},
  ): Promise<TargetAccountListResponse> {
    await this.loadTarget(targetId)
    const parsed = targetAccountListQuerySchema.parse(query)
    const { targetAccounts } = schemaFor(this.db)
    const limit = parsed.limit
    const filters: (SQL | undefined)[] = [
      eq(targetAccounts.targetId, targetId),
      isNull(targetAccounts.deletedAt),
      parsed.status ? eq(targetAccounts.status, parsed.status) : undefined,
      parsed.search
        ? or(
            sql`lower(${targetAccounts.displayName}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
            sql`lower(${targetAccounts.username}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          )
        : undefined,
      cursorFilter(targetAccounts.createdAt, targetAccounts.id, parsed.cursor),
    ]
    const rows = await this.db
      .select()
      .from(targetAccounts)
      .where(and(...filters.filter((f): f is SQL => f !== undefined)))
      .orderBy(desc(targetAccounts.createdAt), desc(targetAccounts.id))
      .limit(limit + 1)
    const paginated = paginateResults(rows, limit)
    const profile = await loadCurrentAuthProfile(this.db, targetId)
    const extras = await loadAccountAuthDisplay(
      this.db,
      paginated.items.map((row) => row.id),
    )
    return targetAccountListResponseSchema.parse({
      items: paginated.items.map((row) => this.toAccount(row, profile, extras.get(row.id))),
      nextCursor: paginated.nextCursor,
      hasMore: paginated.hasMore,
    })
  }

  async createAccount(
    targetId: string,
    body: CreateTargetAccountBody,
    actor: RequestAccount,
  ): Promise<TargetAccountDto> {
    await this.loadTarget(targetId)
    const now = new Date()
    let id = ''
    try {
      await this.db.transaction(async (tx) => {
        id = await this.insertAccount(tx, targetId, body, actor, now)
      })
    } catch (error) {
      await rethrowUnique(this.db, error, 'account', {
        targetId,
        username: body.username,
      })
    }
    return this.getAccount(targetId, id)
  }

  async updateAccount(
    targetId: string,
    accountId: string,
    body: UpdateTargetAccountBody,
    actor: RequestAccount,
  ): Promise<TargetAccountDto> {
    const { secrets, targetAccounts } = schemaFor(this.db)
    const current = await this.loadAccount(targetId, accountId)
    const now = new Date()
    const nextSecret = body.password ? this.seal(body.password) : undefined
    try {
      await this.db.transaction(async (tx) => {
        if (nextSecret) {
          await tx.insert(secrets).values({
            id: nextSecret.id,
            provider: LOCAL_SECRET_PROVIDER,
            ciphertext: nextSecret.ciphertext,
            createdAt: now,
            updatedAt: now,
          })
        }
        await tx
          .update(targetAccounts)
          .set({
            displayName: body.displayName ?? current.displayName,
            username: body.username ?? current.username,
            status: body.status ?? current.status,
            secretProvider: body.clearPassword
              ? null
              : nextSecret
                ? LOCAL_SECRET_PROVIDER
                : current.secretProvider,
            secretId: body.clearPassword ? null : nextSecret ? nextSecret.id : current.secretId,
            updatedAt: now,
          })
          .where(eq(targetAccounts.id, accountId))
        if ((nextSecret || body.clearPassword) && current.secretId) {
          await tx.delete(secrets).where(eq(secrets.id, current.secretId))
        }
        const changedMeta =
          body.displayName !== undefined || body.username !== undefined || body.status !== undefined
        if (changedMeta) {
          await this.writeAudit(
            tx,
            actor,
            'target_account.update',
            'target_account',
            accountId,
            `${body.displayName ?? current.displayName}（${body.username ?? current.username}）`,
          )
        }
        if (nextSecret || body.clearPassword) {
          await resetAuthBudgetAfterCredentialChange(tx, accountId)
          await this.writeAudit(
            tx,
            actor,
            'target_account.password',
            'target_account',
            accountId,
            body.username ?? current.username,
          )
        }
      })
    } catch (error) {
      await rethrowUnique(this.db, error, 'account', {
        targetId,
        username: body.username ?? current.username,
      })
    }
    return this.getAccount(targetId, accountId)
  }

  async deleteAccount(
    targetId: string,
    accountId: string,
    actor: RequestAccount,
  ): Promise<DeleteResourceResult> {
    const { secrets, targetAccounts, runs } = schemaFor(this.db)
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await locked(
          tx,
          tx
            .select()
            .from(targetAccounts)
            .where(and(eq(targetAccounts.id, accountId), eq(targetAccounts.targetId, targetId))),
        )
        if (!current) {
          throw failure('not_found', { code: 'TARGET_ACCOUNT_NOT_FOUND', message: '目标账号不存在' })
        }
        if (current.deletedAt && current.deletedBy) {
          return toDeleteResult({
            id: accountId,
            deletedAt: current.deletedAt,
            deletedBy: current.deletedBy,
          })
        }

        const activeRuns = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.targetAccountId, accountId),
              inArray(runs.status, ACTIVE_RUN_STATUSES as any),
              isNull(runs.deletedAt),
            ),
          )
          .limit(1)
        if (activeRuns.length > 0) {
          throw failure('conflict', {
            code: 'TARGET_ACCOUNT_BUSY',
            message: '目标账号有进行中的运行，无法删除',
          })
        }
        await assertResourceIdle(tx as unknown as Db, { targetAccountId: accountId })
        const now = new Date()
        const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
        await requestSessionClose(tx as unknown as Db, { targetAccountId: accountId }, now)
        await tx
          .update(targetAccounts)
          .set({ deletedAt: now, deletedBy, secretId: null, secretProvider: null, updatedAt: now })
          .where(eq(targetAccounts.id, accountId))

        if (current.secretId) {
          const exclusive = await exclusiveSecretIds(tx as unknown as Db, [current.secretId], [
            accountId,
          ])
          if (exclusive.length > 0) {
            await tx.delete(secrets).where(eq(secrets.id, current.secretId))
          }
        }
        await revokeAccountGrants(tx as unknown as Db, accountId)

        await this.writeAudit(
          tx,
          actor,
          'target_account.delete',
          'target_account',
          accountId,
          `${current.displayName}（${current.username}）`,
        )
        return toDeleteResult({ id: accountId, deletedAt: now, deletedBy })
      })
    } catch (error) {
      const mapped = mapRestriction(error, 'target_account')
      if (mapped) {
        throw failure('conflict', { code: mapped.code, message: mapped.message })
      }
      throw error
    }
  }

  async getAccount(targetId: string, accountId: string): Promise<TargetAccountDto> {
    const row = await this.loadAccount(targetId, accountId)
    const profile = await loadCurrentAuthProfile(this.db, targetId)
    const extras = await loadAccountAuthDisplay(this.db, [accountId])
    return this.toAccount(row, profile, extras.get(accountId))
  }

  private async loadTarget(id: string) {
    const { targets } = schemaFor(this.db)
    const [row] = await this.db
      .select()
      .from(targets)
      .where(and(eq(targets.id, id), isNull(targets.deletedAt)))
      .limit(1)
    if (!row) {
      throw failure('not_found', { code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
    }
    return row
  }

  private async loadAccount(targetId: string, accountId: string) {
    const { targetAccounts } = schemaFor(this.db)
    await this.loadTarget(targetId)
    const [row] = await this.db
      .select()
      .from(targetAccounts)
      .where(
        and(
          eq(targetAccounts.id, accountId),
          eq(targetAccounts.targetId, targetId),
          isNull(targetAccounts.deletedAt),
        ),
      )
      .limit(1)
    if (!row) {
      throw failure('not_found', { code: 'TARGET_ACCOUNT_NOT_FOUND', message: '目标账号不存在' })
    }
    return row
  }

  private async accountCounts(targetId?: string): Promise<Map<string, number>> {
    const { targetAccounts } = schemaFor(this.db)
    const condition = targetId
      ? and(eq(targetAccounts.targetId, targetId), isNull(targetAccounts.deletedAt))
      : isNull(targetAccounts.deletedAt)
    const rows = await this.db
      .select({
        targetId: targetAccounts.targetId,
        n: sql<number>`count(*)`.as('n'),
      })
      .from(targetAccounts)
      .where(condition)
      .groupBy(targetAccounts.targetId)
    return new Map(rows.map((row: { targetId: string; n: unknown }) => [row.targetId, Number(row.n)]))
  }

  private seal(password: string): { id: string; ciphertext: Buffer } {
    const id = newId()
    try {
      return { id, ciphertext: this.encrypt(id, password) }
    } catch {
      throw failure('unavailable', '凭据服务不可用')
    }
  }

  private async insertAccount(
    tx: Db,
    targetId: string,
    body: CreateTargetAccountBody,
    actor: RequestAccount,
    now: Date,
  ): Promise<string> {
    const { secrets, targetAccounts } = schemaFor(tx)
    const id = newId()
    const secret = body.password ? this.seal(body.password) : undefined
    if (secret) {
      await tx.insert(secrets).values({
        id: secret.id,
        provider: LOCAL_SECRET_PROVIDER,
        ciphertext: secret.ciphertext,
        createdAt: now,
        updatedAt: now,
      })
    }
    await tx.insert(targetAccounts).values({
      id,
      targetId,
      displayName: body.displayName,
      username: body.username,
      secretProvider: secret ? LOCAL_SECRET_PROVIDER : null,
      secretId: secret?.id ?? null,
      status: body.status,
      createdAt: now,
      updatedAt: now,
    })
    await this.writeAudit(
      tx,
      actor,
      'target_account.create',
      'target_account',
      id,
      `${body.displayName}（${body.username}）`,
    )
    if (secret) {
      await this.writeAudit(
        tx,
        actor,
        'target_account.password',
        'target_account',
        id,
        body.username,
      )
    }
    return id
  }

  private toTarget(row: Target, accountCount: number): TargetDto {
    return targetSchema.parse({
      id: row.id,
      code: row.code,
      name: row.name,
      entryUrl: row.entryUrl,
      loginUrl: row.loginUrl,
      authMethod: row.authMethod,
      captchaMode: row.captchaMode,
      status: row.status,
      loginFields: compactLoginFields((row.loginFields as TargetLoginFields | null) ?? null),
      accountCount,
      currentAuthProfileRevision: row.currentAuthProfileRevision,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })
  }

  private toAccount(
    row: TargetAccount,
    profile: Awaited<ReturnType<typeof loadCurrentAuthProfile>>,
    extras?: {
      lastAuthCheckedAt: string | null
      lastAuthSuccessAt: string | null
      lastAuthError: string | null
      autoLoginPausedReason: string | null
    },
  ): TargetAccountDto {
    return targetAccountSchema.parse({
      id: row.id,
      targetId: row.targetId,
      displayName: row.displayName,
      username: row.username,
      hasPassword: Boolean(row.secretId),
      status: row.status,
      expectedIdentity: row.expectedIdentity,
      configRevision: row.configRevision,
      authCapability: deriveAuthCapability({
        definition: profile?.definition ?? null,
        validation: profile?.validation ?? null,
        expectedIdentity: row.expectedIdentity,
      }),
      lastAuthCheckedAt: extras?.lastAuthCheckedAt ?? null,
      lastAuthSuccessAt: extras?.lastAuthSuccessAt ?? null,
      lastAuthError: extras?.lastAuthError ?? null,
      autoLoginPausedReason: extras?.autoLoginPausedReason ?? null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })
  }

  private async writeAudit(
    tx: Db,
    actor: RequestAccount,
    action: AuditAction,
    resource: string,
    resourceId: string,
    summary: string,
  ): Promise<void> {
    const { consoleAuditEvents } = schemaFor(tx)
    await tx.insert(consoleAuditEvents).values({
      id: newId(),
      actorConsoleAccountId: actor.id,
      action,
      resource,
      resourceId,
      summary,
      createdAt: new Date(),
    })
  }
}
