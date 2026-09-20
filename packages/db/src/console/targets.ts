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
import { assertTargetPermission, lockConsoleAuthorization, targetScopeFor, targetScopeFilter } from './target-authorization.js'
import { updateCredentialMetadata } from '../credentials/catalog.js'
import { targetCleanupObjectFilter } from '../reports/cleanup.js'
import {
  ACTIVE_RUN_STATUSES,
  LOCAL_SECRET_PROVIDER,
  activeDetectionReady,
  deriveAuthCapability,
  cleanupStatusResponseSchema,
  isCleanupFailed,
  tallyKnownBytes,
  compactLoginFields,
  DEFAULT_ACCOUNT_USAGE,
  deletePreviewResponseSchema,
  mapUsageGuardFor,
  targetAccountListQuerySchema,
  targetAccountListResponseSchema,
  targetAccountSchema,
  targetListQuerySchema,
  targetListResponseSchema,
  targetSchema,
  applyTargetSessionPolicyPatch,
  FACTORY_PLATFORM_CONFIG,
  platformConfigDocumentSchema,
  resolveSessionPolicyLayers,
  sessionPolicyFromPlatform,
  type AuditAction,
  type TargetSessionPolicyPatch,
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
import { loadAccountAuthDisplay, loadCurrentAuthProfile } from '../sessions/auth-profile.js'
import {
  clearTargetAccountSecrets,
  confirmIdentityMaterial,
  ensureTargetAccountCredential,
  loadAccountCredentialView,
  markIdentityReconfirm,
  replaceTargetAccountSecret,
} from '../credentials/index.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { parseTargetSessionPolicyOverride } from '../sessions/session-policy.js'
import { retireSchedulesForOwner } from '../schedules/schedules.js'
import { softDeleteSuitesForTarget } from '../suites/suites.js'

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
    if (name?.includes('map_usage')) {
      throw failure('conflict', {
        code: 'TARGET_ACCOUNT_MAP_USAGE_CONFLICT',
        message: '该目标系统已有采集账号，每个目标只能有一个',
      })
    }
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

  private async platformSessionDefaults() {
    const platform = await getPlatformConfig(this.db)
    const document = platform
      ? platformConfigDocumentSchema.parse(platform.document)
      : FACTORY_PLATFORM_CONFIG
    return sessionPolicyFromPlatform(document.session)
  }

  async listTargets(query: TargetListQuery = {}, actor?: RequestAccount): Promise<TargetListResponse> {
    const parsed = targetListQuerySchema.parse(query)
    const { targets } = schemaFor(this.db)
    const limit = parsed.limit
    const filters: (SQL | undefined)[] = [
      isNull(targets.deletedAt),
      actor ? targetScopeFilter(targets.id, await targetScopeFor(this.db, actor.id, 'target:read')) : undefined,
      actor && parsed.credentialAction ? targetScopeFilter(targets.id, await targetScopeFor(this.db, actor.id, 'credential:read')) : undefined,
      actor && parsed.credentialAction && parsed.credentialAction !== 'read' ? targetScopeFilter(targets.id, await targetScopeFor(this.db, actor.id, 'credential:write')) : undefined,
      actor && parsed.credentialAction === 'import' ? targetScopeFilter(targets.id, await targetScopeFor(this.db, actor.id, 'credential:import')) : undefined,
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
    const sessionPolicy = parseTargetSessionPolicyOverride(row.sessionPolicy)
    return this.toTarget(row, counts.get(id) ?? 0, {
      sessionPolicy,
      effectiveSessionPolicy: resolveSessionPolicyLayers({
        platformDefault: await this.platformSessionDefaults(),
        targetOverride: sessionPolicy,
      }),
    })
  }

  async updateSessionPolicy(
    id: string,
    patch: TargetSessionPolicyPatch,
    actor: RequestAccount,
  ): Promise<TargetDto> {
    const { targets } = schemaFor(this.db)
    const current = await this.loadTarget(id)
    const nextOverride = applyTargetSessionPolicyPatch(
      parseTargetSessionPolicyOverride(current.sessionPolicy),
      patch,
    )
    let resolved
    try {
      resolved = resolveSessionPolicyLayers({
        platformDefault: await this.platformSessionDefaults(),
        targetOverride: nextOverride,
      })
    } catch (error) {
      throw failure('conflict', {
        code: 'SESSION_POLICY_INVALID',
        message: error instanceof Error ? error.message : '目标会话策略非法',
      })
    }
    if (resolved.reclaim === 'AUTH_DRIVEN') {
      const profile = await loadCurrentAuthProfile(this.db, id)
      if (
        !activeDetectionReady({
          definition: profile?.definition ?? null,
          validation: profile?.validation ?? null,
        })
      ) {
        throw failure('conflict', {
          code: 'AUTH_PROFILE_REQUIRED',
          message: '认证保活需要已发布并通过验收的主动检测规则',
        })
      }
    }
    const now = new Date()
    await this.db.transaction(async (tx) => {
      await tx
        .update(targets)
        .set({ sessionPolicy: nextOverride, updatedAt: now })
        .where(eq(targets.id, id))
      await this.writeAudit(tx, actor, 'target.update', 'target', id, '更新了会话策略')
    })
    return this.getTarget(id)
  }

  async createTarget(body: CreateTargetBody, actor: RequestAccount): Promise<TargetDto> {
    const { targets } = schemaFor(this.db)
    const id = newId()
    const now = new Date()
    try {
      await this.db.transaction(async (tx) => {
        await lockConsoleAuthorization(tx, actor.id)
        if (!(await targetScopeFor(tx, actor.id, 'target:write')).all || !(await targetScopeFor(tx, actor.id, 'target:read')).all) throw failure('forbidden', '创建目标系统需要全部目标的管理范围')
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
          captcha: body.captcha ?? null,
          sensitiveSelectors: body.sensitiveSelectors ?? [],
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
      body.status === undefined &&
      body.sensitiveSelectors === undefined
    const authSurfaceTouched =
      body.loginFields !== undefined ||
      body.loginUrl !== undefined ||
      body.entryUrl !== undefined ||
      body.authMethod !== undefined ||
      body.captchaMode !== undefined ||
      body.captcha !== undefined
    try {
      await this.db.transaction(async (tx) => {
        await lockConsoleAuthorization(tx, actor.id)
        await assertTargetPermission(tx, actor.id, id, 'target:write')
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
            captcha: body.captcha === undefined ? current.captcha : body.captcha,
            sensitiveSelectors:
              body.sensitiveSelectors === undefined
                ? current.sensitiveSelectors
                : body.sensitiveSelectors,
            updatedAt: now,
          })
          .where(eq(targets.id, id))
        if (authSurfaceTouched) {
          await tx
            .update(targetAccounts)
            .set({
              configRevision: sql`${targetAccounts.configRevision} + 1`,
              updatedAt: now,
            })
            .where(and(eq(targetAccounts.targetId, id), isNull(targetAccounts.deletedAt)))
        }
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
      reports,
      scenarioSuites,
      schedules,
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
    const authHeld = sessions.some((row) => row.authControlExpiresAt && row.authControlExpiresAt > now)

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

    const suiteRows = await this.db
      .select({ id: scenarioSuites.id })
      .from(scenarioSuites)
      .where(and(eq(scenarioSuites.targetId, id), isNull(scenarioSuites.deletedAt)))

    const scheduleRows = await this.db
      .select({ id: schedules.id })
      .from(schedules)
      .where(eq(schedules.targetId, id))

    const objects = await this.db
      .select({ id: storedObjects.id, byteSize: storedObjects.byteSize })
      .from(storedObjects)
      .where(and(targetCleanupObjectFilter(this.db, id), isNull(storedObjects.purgedAt)))
    const totalBytes = objects.reduce((sum, o) => sum + (o.byteSize ?? 0), 0)
    const [reportCount] = await this.db.select({ count: sql<number>`count(*)` }).from(reports)
      .where(and(eq(reports.targetId, id), isNull(reports.deletedAt)))

    return deletePreviewResponseSchema.parse({
      previewToken: newId(),
      counts: {
        targetAccounts: accounts.length,
        scenarios: scenarioRows.length,
        suites: suiteRows.length,
        recordings: recordingRows.length,
        runs: targetRunRows.length,
        schedules: scheduleRows.length,
        reports: Number(reportCount?.count ?? 0),
        storedObjects: objects.length,
        totalBytes,
        unknownByteObjects: objects.filter((object) => object.byteSize === null).length,
      },
      blockers: activeBlockers,
    })
  }

  async deleteTarget(
    id: string,
    actor: RequestAccount,
    body?: DeleteResourceBody,
  ): Promise<CleanupStatusResponse> {
    const { targets, targetAccounts, actionModules, scenarios, recordingDrafts, runs, storedObjects, scenarioSuites, schedules } = schemaFor(
      this.db,
    )

    try {
      await this.db.transaction(async (tx) => {
        await lockConsoleAuthorization(tx, actor.id)
        await assertTargetPermission(tx, actor.id, id, 'target:delete')
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

        const suiteRows = await tx
          .select({ id: scenarioSuites.id })
          .from(scenarioSuites)
          .where(and(eq(scenarioSuites.targetId, id), isNull(scenarioSuites.deletedAt)))

        const scheduleRows = await tx
          .select({ id: schedules.id })
          .from(schedules)
          .where(eq(schedules.targetId, id))

        assertExpectedCounts(
          {
            targetAccounts: accounts.length,
            scenarios: scenarioRows.length,
            suites: suiteRows.length,
            recordings: recordingRows.length,
            runs: targetRunRows.length,
            schedules: scheduleRows.length,
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
            .set({
              deletedAt: now,
              deletedBy,
              secretId: null,
              secretProvider: null,
              mapUsageGuard: null,
              updatedAt: now,
            })
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

        await softDeleteSuitesForTarget(tx as unknown as Db, id, deletedBy, now)
        await retireSchedulesForOwner(
          tx as unknown as Db,
          { targetId: id },
          now,
          { kind: 'console', id: actor.id },
        )

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
        }
        await tx.update(storedObjects).set({ deleteRequestedAt: now }).where(and(
          targetCleanupObjectFilter(tx as unknown as Db, id),
          isNull(storedObjects.deleteRequestedAt), isNull(storedObjects.purgedAt),
        ))

        const [objectRow] = await tx
              .select({
                n: sql<number>`count(*)`,
                bytes: sql<number>`coalesce(sum(${storedObjects.byteSize}), 0)`,
              })
              .from(storedObjects)
              .where(targetCleanupObjectFilter(tx as unknown as Db, id))
        await this.writeAudit(
          tx,
          actor,
          'target.delete',
          'target',
          id,
          `删除目标 ${current.name}（${current.code}）：账号 ${accounts.length}、场景 ${scenarioRows.length}、场景集 ${suiteRows.length}、录制 ${recordingRows.length}、运行 ${targetRunRows.length}、调度 ${scheduleRows.length}、对象 ${Number(objectRow?.n ?? 0)}、${Number(objectRow?.bytes ?? 0)} 字节`,
        )
      })
    } catch (error) {
      throw mapRestriction(error) ?? error
    }

    return this.getTargetCleanupStatus(id)
  }

  async getTargetCleanupStatus(id: string): Promise<CleanupStatusResponse> {
    const { storedObjects, targets } = schemaFor(this.db)
    const [target] = await this.db
      .select({ id: targets.id, deletedAt: targets.deletedAt })
      .from(targets)
      .where(eq(targets.id, id))
      .limit(1)
    if (!target) {
      throw failure('not_found', { code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
    }
    if (!target.deletedAt) {
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
      .where(targetCleanupObjectFilter(this.db, id))

    const total = objects.length
    const purged = objects.filter((o) => o.status === 'purged').length
    const failed = objects.filter((o) => isCleanupFailed(o)).length
    const byteTally = tallyKnownBytes(objects.map((o) => o.byteSize))
    const totalBytes = byteTally.knownBytes
    const purgedBytes = tallyKnownBytes(
      objects.filter((o) => o.status === 'purged').map((o) => o.byteSize),
    ).knownBytes

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
      unknownByteObjects: byteTally.unknownCount,
    })
  }

  async retryTargetCleanup(id: string, actor: RequestAccount): Promise<CleanupStatusResponse> {
    await this.getTargetCleanupStatus(id)
    const { storedObjects } = schemaFor(this.db)
    await this.db.update(storedObjects).set({ purgeAttempts: 0, lastPurgeErrorAt: null })
      .where(and(targetCleanupObjectFilter(this.db, id), ne(storedObjects.status, 'purged')))
    await this.writeAudit(this.db, actor, 'target.cleanup_retry', 'target', id, '重试对象清理')
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
    const credentialViews = new Map(
      await Promise.all(
        paginated.items.map(async (row) => [row.id, await loadAccountCredentialView(this.db, row.id)] as const),
      ),
    )
    return targetAccountListResponseSchema.parse({
      items: paginated.items.map((row) => this.toAccount(row, profile, extras.get(row.id), credentialViews.get(row.id))),
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
        await lockConsoleAuthorization(tx, actor.id)
        await assertTargetPermission(tx, actor.id, targetId, 'target:write')
        if (body.password || body.validity || body.ownerConsoleAccountId) {
          await assertTargetPermission(tx, actor.id, targetId, 'credential:read')
          await assertTargetPermission(tx, actor.id, targetId, 'credential:write')
        }
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
    const { secrets, targetAccounts, targets, runs } = schemaFor(this.db)
    let current = await this.loadAccount(targetId, accountId)
    const now = new Date()
    let nextUsage = body.usage ?? current.usage ?? DEFAULT_ACCOUNT_USAGE
    const nextSecret = body.password ? this.seal(body.password) : undefined
    let usernameChanged = body.username !== undefined && body.username !== current.username
    try {
      await this.db.transaction(async (tx) => {
        await lockConsoleAuthorization(tx, actor.id)
        await assertTargetPermission(tx, actor.id, targetId)
        const [liveTarget] = await tx.select({ id: targets.id }).from(targets).where(and(eq(targets.id, targetId), isNull(targets.deletedAt))).for('share')
        if (!liveTarget) throw failure('not_found', '目标系统不存在')
        const [lockedAccount] = await tx.select().from(targetAccounts).where(and(eq(targetAccounts.id, accountId), eq(targetAccounts.targetId, targetId), isNull(targetAccounts.deletedAt))).for('update')
        if (!lockedAccount) throw failure('not_found', '目标账号不存在')
        current = lockedAccount
        nextUsage = body.usage ?? current.usage ?? DEFAULT_ACCOUNT_USAGE
        usernameChanged = body.username !== undefined && body.username !== current.username
        const editsIdentity = body.displayName !== undefined || body.username !== undefined || body.status !== undefined || body.usage !== undefined
        if (editsIdentity) await assertTargetPermission(tx, actor.id, targetId, 'target:write')
        if (nextSecret || body.clearPassword || body.validity || body.ownerConsoleAccountId !== undefined || body.confirmIdentityMaterial) {
          await assertTargetPermission(tx, actor.id, targetId, 'credential:write')
          await assertTargetPermission(tx, actor.id, targetId, 'credential:read')
        }
        const { credentials } = schemaFor(tx)
        const [catalog] = await tx.select().from(credentials).where(eq(credentials.id, accountId)).for('update')
        if (body.expectedRevision !== undefined && catalog?.revision !== body.expectedRevision) throw failure('conflict', { code: 'CREDENTIAL_REVISION_CONFLICT', message: '账号已被他人更新，请重新核对' })
        if (body.clearPassword || usernameChanged) await assertResourceIdle(tx as unknown as Db, { targetAccountId: accountId })
        if (body.clearPassword) {
          const [activeRun] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.targetAccountId, accountId), inArray(runs.status, ACTIVE_RUN_STATUSES), isNull(runs.deletedAt))).limit(1)
          if (activeRun) throw failure('conflict', '账号仍有未完成运行，请先处理后再清除密码')
        }
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
            usage: nextUsage,
            mapUsageGuard: mapUsageGuardFor(nextUsage),
            configRevision: usernameChanged ? current.configRevision + 1 : current.configRevision,
            updatedAt: now,
          })
          .where(eq(targetAccounts.id, accountId))
        if (nextSecret) {
          await replaceTargetAccountSecret(tx, {
            account: {
              id: accountId,
              targetId,
              displayName: body.displayName ?? current.displayName,
              username: body.username ?? current.username,
              configRevision: usernameChanged ? current.configRevision + 1 : current.configRevision,
              secretId: nextSecret.id,
              secretProvider: LOCAL_SECRET_PROVIDER,
            },
            sealed: { id: nextSecret.id, provider: LOCAL_SECRET_PROVIDER },
            validity: body.validity,
            expectedRevision: body.expectedRevision,
            actor,
          })
        } else if (body.clearPassword) {
          await clearTargetAccountSecrets(tx, { accountId, actor })
        } else if (usernameChanged && !body.confirmIdentityMaterial) {
          await markIdentityReconfirm(tx, {
            accountId,
            username: body.username ?? current.username,
            identityRevision: current.configRevision + 1,
          })
        } else if (body.confirmIdentityMaterial) {
          await confirmIdentityMaterial(tx, {
            account: {
              id: accountId,
              targetId,
              displayName: body.displayName ?? current.displayName,
              username: body.username ?? current.username,
              configRevision: usernameChanged ? current.configRevision + 1 : current.configRevision,
              secretId: current.secretId,
              secretProvider: current.secretProvider,
            },
            actor,
          })
        }
        if ((!nextSecret && body.validity) || body.ownerConsoleAccountId !== undefined) {
          const [latest] = await tx.select().from(credentials).where(eq(credentials.id, accountId))
          if (!latest || latest.deletedAt) throw failure('conflict', '凭据登记已删除，请先保存新的密码重新登记')
          await updateCredentialMetadata(tx, accountId, { expectedRevision: latest.revision,
            validity: !nextSecret ? body.validity : undefined, startedAt: !nextSecret ? body.validity?.startedAt : undefined,
            ownerConsoleAccountId: body.ownerConsoleAccountId }, actor)
        }
        const changedMeta =
          body.displayName !== undefined ||
          body.username !== undefined ||
          body.status !== undefined ||
          body.usage !== undefined
        if (changedMeta) {
          await tx.update(credentials).set({ name: body.displayName ?? current.displayName, revision: sql`${credentials.revision} + 1`, updatedAt: now }).where(eq(credentials.id, accountId))
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
        await lockConsoleAuthorization(tx, actor.id)
        await assertTargetPermission(tx, actor.id, targetId, 'target:delete')
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
          .set({
            deletedAt: now,
            deletedBy,
            secretId: null,
            secretProvider: null,
            mapUsageGuard: null,
            updatedAt: now,
          })
          .where(eq(targetAccounts.id, accountId))

        await clearTargetAccountSecrets(tx, { accountId, actor })
        if (current.secretId) {
          const exclusive = await exclusiveSecretIds(tx as unknown as Db, [current.secretId], [
            accountId,
          ])
          if (exclusive.length > 0) {
            await tx.delete(secrets).where(eq(secrets.id, current.secretId))
          }
        }
        await revokeAccountGrants(tx as unknown as Db, accountId)
        await retireSchedulesForOwner(
          tx as unknown as Db,
          { targetAccountId: accountId },
          now,
          { kind: 'console', id: actor.id },
        )

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
    return this.toAccount(row, profile, extras.get(accountId), await loadAccountCredentialView(this.db, accountId))
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
    const { secrets, targetAccounts, targets } = schemaFor(tx)
    const [liveTarget] = await tx.select({ id: targets.id }).from(targets).where(and(eq(targets.id, targetId), isNull(targets.deletedAt))).for('share')
    if (!liveTarget) throw failure('not_found', '目标系统不存在')
    if (body.password || body.validity || body.ownerConsoleAccountId) {
      await assertTargetPermission(tx, actor.id, targetId, 'credential:read')
      await assertTargetPermission(tx, actor.id, targetId, 'credential:write')
    }
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
      usage: body.usage ?? DEFAULT_ACCOUNT_USAGE,
      mapUsageGuard: mapUsageGuardFor(body.usage ?? DEFAULT_ACCOUNT_USAGE),
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
    await ensureTargetAccountCredential(tx, {
      account: {
        id,
        targetId,
        displayName: body.displayName,
        username: body.username,
        configRevision: 1,
        secretId: secret?.id ?? null,
        secretProvider: secret ? LOCAL_SECRET_PROVIDER : null,
      },
      sealed: secret ? { id: secret.id, provider: LOCAL_SECRET_PROVIDER } : null,
      validity: body.validity,
      ownerConsoleAccountId: body.ownerConsoleAccountId,
      actor,
      now,
    })
    return id
  }

  private toTarget(
    row: Target,
    accountCount: number,
    extras?: {
      sessionPolicy?: TargetDto['sessionPolicy']
      effectiveSessionPolicy?: TargetDto['effectiveSessionPolicy']
    },
  ): TargetDto {
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
      captcha: row.captcha ?? null,
      sensitiveSelectors: row.sensitiveSelectors ?? [],
      accountCount,
      currentAuthProfileRevision: row.currentAuthProfileRevision,
      ...(extras?.sessionPolicy !== undefined ? { sessionPolicy: extras.sessionPolicy } : {}),
      ...(extras?.effectiveSessionPolicy
        ? { effectiveSessionPolicy: extras.effectiveSessionPolicy }
        : {}),
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
    credential?: Awaited<ReturnType<typeof loadAccountCredentialView>>,
  ): TargetAccountDto {
    return targetAccountSchema.parse({
      id: row.id,
      targetId: row.targetId,
      displayName: row.displayName,
      username: row.username,
      hasPassword: Boolean(row.secretId),
      status: row.status,
      expectedIdentity: row.expectedIdentity,
      usage: row.usage ?? DEFAULT_ACCOUNT_USAGE,
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
      ...(credential
        ? {
            credentialId: credential.credentialId,
            credentialRevision: credential.credentialRevision,
            validityPolicy: credential.validityPolicy,
            validityStartedAt: credential.validityStartedAt,
            maintenanceDueAt: credential.maintenanceDueAt,
            maintenanceStatus: credential.maintenanceStatus,
            ownerConsoleAccountId: credential.ownerConsoleAccountId,
            ownerStatus: credential.ownerStatus,
            verificationStatus: credential.verificationStatus,
            identityBindingStatus: credential.identityBindingStatus,
            issuerExpiresAt: credential.issuerExpiresAt,
            issuerExpirySource: credential.issuerExpirySource,
          }
        : {}),
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
