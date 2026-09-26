import { createHash } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { canonicalJson } from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, clockNow, databaseNow, schemaFor } from '../native.js'
import type { SessionKey } from './sessions.js'

export const MAX_SNAPSHOT_BYTE_SIZE = 2 * 1024 * 1024 // 2 MB

export type WriteSessionSnapshotAuthority =
  | { kind: 'lease'; leaseId: string; workerId: string }
  | { kind: 'owner'; workerId: string; instanceId?: string }

export type WriteSessionSnapshotInput = {
  targetId: string
  targetAccountId: string
  accountSlot?: number
  state: Record<string, unknown>
  formatVersion?: number
  cookieCount?: number
  originCount?: number
  hasIndexedDb?: boolean
  earliestCookieExpiry?: Date | null
  identity?: string | null
  sessionId: string
  sessionGeneration: number
  sessionFencingToken?: number
  authority: WriteSessionSnapshotAuthority
  maxByteSize?: number
}

export type WriteSessionSnapshotResult =
  | { ok: true; action: 'written' | 'deduplicated'; byteSize: number }
  | {
      ok: false
      code: 'stale_holder' | 'cleared' | 'resource_deleted' | 'too_large'
      message: string
    }

export type SessionSnapshotSummary = {
  hasSnapshot: boolean
  targetId: string
  targetAccountId: string
  accountSlot: number
  formatVersion: number | null
  byteSize: number | null
  cookieCount: number | null
  originCount: number | null
  hasIndexedDb: boolean | null
  earliestCookieExpiry: Date | null
  identity: string | null
  stale: boolean
  clearedAt: Date | null
  capturedAt: Date | null
  verifiedAt: Date | null
  updatedAt: Date | null
}

export type SessionSnapshotContent = SessionSnapshotSummary & {
  state: Record<string, unknown> | null
  sessionId: string | null
  sessionGeneration: number | null
  sessionFencingToken: number | null
  contentDigest: string | null
}

export async function writeSessionStateSnapshot(
  db: Db,
  input: WriteSessionSnapshotInput,
): Promise<WriteSessionSnapshotResult> {
  const accountSlot = input.accountSlot ?? 1
  return atomic(db, async (tx) => {
    const { targets, targetAccounts, browserSessions, sessionLeases, sessionStateSnapshots } =
      schemaFor(tx)

    // 1. 目标与账号仍存在且未删除
    const [target] = await tx
      .select({ id: targets.id })
      .from(targets)
      .where(and(eq(targets.id, input.targetId), isNull(targets.deletedAt)))
      .limit(1)
    const [account] = await tx
      .select({ id: targetAccounts.id })
      .from(targetAccounts)
      .where(and(eq(targetAccounts.id, input.targetAccountId), isNull(targetAccounts.deletedAt)))
      .limit(1)
    if (!target || !account) {
      return { ok: false, code: 'resource_deleted', message: '目标或账号不存在或已被删除' }
    }

    // 2. 权限校验二选一
    const [session] = await tx
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, input.sessionId))
      .limit(1)
    if (!session) {
      return { ok: false, code: 'stale_holder', message: '会话不存在' }
    }

    const now = await clockNow(tx as unknown as Db)

    if (input.authority.kind === 'lease') {
      const [lease] = await tx
        .select()
        .from(sessionLeases)
        .where(eq(sessionLeases.id, input.authority.leaseId))
        .limit(1)
      if (
        !lease ||
        lease.status !== 'ACTIVE' ||
        lease.expiresAt.getTime() <= now.getTime() ||
        lease.holderWorkerId !== input.authority.workerId ||
        lease.sessionId !== input.sessionId ||
        lease.sessionGeneration !== input.sessionGeneration
      ) {
        return { ok: false, code: 'stale_holder', message: '租约不是当前持有者或已失效' }
      }
      if (
        input.sessionFencingToken !== undefined &&
        lease.sessionFencingToken !== input.sessionFencingToken
      ) {
        return { ok: false, code: 'stale_holder', message: '击剑令牌不一致' }
      }
    } else {
      // authority = owner: 会话所有者实例与调用方一致，会话状态为 OPEN 或 CLOSING，且没有 ACTIVE 租约
      if (session.ownerWorkerId !== input.authority.workerId) {
        return { ok: false, code: 'stale_holder', message: '非会话所有者 Worker' }
      }
      if (
        input.authority.instanceId &&
        session.ownerWorkerInstanceId &&
        session.ownerWorkerInstanceId !== input.authority.instanceId
      ) {
        return { ok: false, code: 'stale_holder', message: '非会话所有者 Worker 实例' }
      }
      if (session.status !== 'OPEN' && session.status !== 'CLOSING') {
        return { ok: false, code: 'stale_holder', message: `会话状态为 ${session.status}，不可写入快照` }
      }
      // 检查没有 ACTIVE 租约
      const [activeLease] = await tx
        .select({ id: sessionLeases.id })
        .from(sessionLeases)
        .where(
          and(
            eq(sessionLeases.sessionId, input.sessionId),
            eq(sessionLeases.status, 'ACTIVE'),
            sql`${sessionLeases.expiresAt} > ${now}`,
          ),
        )
        .limit(1)
      if (activeLease) {
        return { ok: false, code: 'stale_holder', message: '会话存在活跃执行租约，所有者不可抢写' }
      }
    }

    // 3. 检查现有快照行
    const [existing] = await tx
      .select()
      .from(sessionStateSnapshots)
      .where(
        and(
          eq(sessionStateSnapshots.targetId, input.targetId),
          eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
          eq(sessionStateSnapshots.accountSlot, accountSlot),
        ),
      )
      .limit(1)

    if (existing) {
      // cleared_at 墓碑检查：会话创建时间必须晚于 cleared_at
      if (existing.clearedAt && session.createdAt.getTime() <= existing.clearedAt.getTime()) {
        return { ok: false, code: 'cleared', message: '会话创建于快照清除之前，已拒绝写入' }
      }

      // (generation, fencingToken) 不小于已存快照的来源值
      const existingGen = existing.sessionGeneration ?? 0
      const existingToken = existing.sessionFencingToken ?? 0
      const inputToken = input.sessionFencingToken ?? 0
      if (
        input.sessionGeneration < existingGen ||
        (input.sessionGeneration === existingGen && inputToken < existingToken)
      ) {
        return { ok: false, code: 'stale_holder', message: '快照已有更高代次的来源记录' }
      }
    }

    // 4. 序列化与大小检查
    const serialized = canonicalJson(input.state)
    const byteSize = Buffer.byteLength(serialized, 'utf8')
    const maxLimit = input.maxByteSize ?? MAX_SNAPSHOT_BYTE_SIZE
    if (byteSize > maxLimit) {
      return { ok: false, code: 'too_large', message: `快照大小 ${byteSize} 字节超出上限 ${maxLimit}` }
    }

    // 5. 内容摘要去重
    const digest = createHash('sha256').update(serialized).digest('hex')
    if (existing && existing.contentDigest === digest && !existing.stale && existing.state != null) {
      await tx
        .update(sessionStateSnapshots)
        .set({
          verifiedAt: now,
          updatedAt: now,
          identity: input.identity ?? existing.identity,
          earliestCookieExpiry: input.earliestCookieExpiry ?? existing.earliestCookieExpiry,
        })
        .where(
          and(
            eq(sessionStateSnapshots.targetId, input.targetId),
            eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
            eq(sessionStateSnapshots.accountSlot, accountSlot),
          ),
        )
      return { ok: true, action: 'deduplicated', byteSize }
    }

    // 6. 覆盖写入（upsert）
    if (existing) {
      await tx
        .update(sessionStateSnapshots)
        .set({
          state: input.state,
          formatVersion: input.formatVersion ?? 1,
          byteSize,
          cookieCount: input.cookieCount ?? 0,
          originCount: input.originCount ?? 0,
          hasIndexedDb: input.hasIndexedDb ?? false,
          earliestCookieExpiry: input.earliestCookieExpiry ?? null,
          sessionId: input.sessionId,
          sessionGeneration: input.sessionGeneration,
          sessionFencingToken: input.sessionFencingToken ?? 0,
          identity: input.identity ?? null,
          stale: false,
          contentDigest: digest,
          clearedAt: null,
          capturedAt: now,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(sessionStateSnapshots.targetId, input.targetId),
            eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
            eq(sessionStateSnapshots.accountSlot, accountSlot),
          ),
        )
    } else {
      await tx.insert(sessionStateSnapshots).values({
        targetId: input.targetId,
        targetAccountId: input.targetAccountId,
        accountSlot,
        state: input.state,
        formatVersion: input.formatVersion ?? 1,
        byteSize,
        cookieCount: input.cookieCount ?? 0,
        originCount: input.originCount ?? 0,
        hasIndexedDb: input.hasIndexedDb ?? false,
        earliestCookieExpiry: input.earliestCookieExpiry ?? null,
        sessionId: input.sessionId,
        sessionGeneration: input.sessionGeneration,
        sessionFencingToken: input.sessionFencingToken ?? 0,
        identity: input.identity ?? null,
        stale: false,
        contentDigest: digest,
        clearedAt: null,
        capturedAt: now,
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
    }

    return { ok: true, action: 'written', byteSize }
  })
}

export async function markSessionStateSnapshotStale(
  db: Db,
  input: { targetId: string; targetAccountId: string; accountSlot?: number },
): Promise<void> {
  const accountSlot = input.accountSlot ?? 1
  const { sessionStateSnapshots } = schemaFor(db)
  await db
    .update(sessionStateSnapshots)
    .set({ stale: true, updatedAt: databaseNow(db) })
    .where(
      and(
        eq(sessionStateSnapshots.targetId, input.targetId),
        eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
        eq(sessionStateSnapshots.accountSlot, accountSlot),
      ),
    )
}

/**
 * 控制台安全查询：不读 state 原文字段
 */
export async function readSessionStateSnapshotSummary(
  db: Db,
  input: { targetId: string; targetAccountId: string; accountSlot?: number },
): Promise<SessionSnapshotSummary> {
  const accountSlot = input.accountSlot ?? 1
  const { sessionStateSnapshots } = schemaFor(db)
  const [row] = await db
    .select({
      targetId: sessionStateSnapshots.targetId,
      targetAccountId: sessionStateSnapshots.targetAccountId,
      accountSlot: sessionStateSnapshots.accountSlot,
      formatVersion: sessionStateSnapshots.formatVersion,
      byteSize: sessionStateSnapshots.byteSize,
      cookieCount: sessionStateSnapshots.cookieCount,
      originCount: sessionStateSnapshots.originCount,
      hasIndexedDb: sessionStateSnapshots.hasIndexedDb,
      earliestCookieExpiry: sessionStateSnapshots.earliestCookieExpiry,
      identity: sessionStateSnapshots.identity,
      stale: sessionStateSnapshots.stale,
      clearedAt: sessionStateSnapshots.clearedAt,
      capturedAt: sessionStateSnapshots.capturedAt,
      verifiedAt: sessionStateSnapshots.verifiedAt,
      updatedAt: sessionStateSnapshots.updatedAt,
      hasState: sql<boolean>`${sessionStateSnapshots.state} IS NOT NULL`,
    })
    .from(sessionStateSnapshots)
    .where(
      and(
        eq(sessionStateSnapshots.targetId, input.targetId),
        eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
        eq(sessionStateSnapshots.accountSlot, accountSlot),
      ),
    )
    .limit(1)

  if (!row || !row.hasState) {
    return {
      hasSnapshot: false,
      targetId: input.targetId,
      targetAccountId: input.targetAccountId,
      accountSlot,
      formatVersion: null,
      byteSize: null,
      cookieCount: null,
      originCount: null,
      hasIndexedDb: null,
      earliestCookieExpiry: null,
      identity: null,
      stale: false,
      clearedAt: row?.clearedAt ?? null,
      capturedAt: null,
      verifiedAt: null,
      updatedAt: row?.updatedAt ?? null,
    }
  }

  return {
    hasSnapshot: true,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    accountSlot: row.accountSlot,
    formatVersion: row.formatVersion,
    byteSize: row.byteSize,
    cookieCount: row.cookieCount,
    originCount: row.originCount,
    hasIndexedDb: row.hasIndexedDb,
    earliestCookieExpiry: row.earliestCookieExpiry,
    identity: row.identity,
    stale: row.stale,
    clearedAt: row.clearedAt,
    capturedAt: row.capturedAt,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * 批量读取多个账号的槽位1快照摘要
 */
export async function readSessionStateSnapshotSummaries(
  db: Db,
  input: { targetId: string; targetAccountIds: string[] },
): Promise<Map<string, SessionSnapshotSummary>> {
  if (input.targetAccountIds.length === 0) return new Map()
  const { sessionStateSnapshots } = schemaFor(db)
  const rows = await db
    .select({
      targetId: sessionStateSnapshots.targetId,
      targetAccountId: sessionStateSnapshots.targetAccountId,
      accountSlot: sessionStateSnapshots.accountSlot,
      formatVersion: sessionStateSnapshots.formatVersion,
      byteSize: sessionStateSnapshots.byteSize,
      cookieCount: sessionStateSnapshots.cookieCount,
      originCount: sessionStateSnapshots.originCount,
      hasIndexedDb: sessionStateSnapshots.hasIndexedDb,
      earliestCookieExpiry: sessionStateSnapshots.earliestCookieExpiry,
      identity: sessionStateSnapshots.identity,
      stale: sessionStateSnapshots.stale,
      clearedAt: sessionStateSnapshots.clearedAt,
      capturedAt: sessionStateSnapshots.capturedAt,
      verifiedAt: sessionStateSnapshots.verifiedAt,
      updatedAt: sessionStateSnapshots.updatedAt,
      hasState: sql<boolean>`${sessionStateSnapshots.state} IS NOT NULL`,
    })
    .from(sessionStateSnapshots)
    .where(
      and(
        eq(sessionStateSnapshots.targetId, input.targetId),
        inArray(sessionStateSnapshots.targetAccountId, input.targetAccountIds),
        eq(sessionStateSnapshots.accountSlot, 1),
      ),
    )

  const map = new Map<string, SessionSnapshotSummary>()
  for (const row of rows) {
    if (!row.hasState) {
      map.set(row.targetAccountId, {
        hasSnapshot: false,
        targetId: input.targetId,
        targetAccountId: row.targetAccountId,
        accountSlot: row.accountSlot,
        formatVersion: null,
        byteSize: null,
        cookieCount: null,
        originCount: null,
        hasIndexedDb: null,
        earliestCookieExpiry: null,
        identity: null,
        stale: false,
        clearedAt: row.clearedAt ?? null,
        capturedAt: null,
        verifiedAt: null,
        updatedAt: row.updatedAt ?? null,
      })
    } else {
      map.set(row.targetAccountId, {
        hasSnapshot: true,
        targetId: row.targetId,
        targetAccountId: row.targetAccountId,
        accountSlot: row.accountSlot,
        formatVersion: row.formatVersion,
        byteSize: row.byteSize,
        cookieCount: row.cookieCount,
        originCount: row.originCount,
        hasIndexedDb: row.hasIndexedDb,
        earliestCookieExpiry: row.earliestCookieExpiry,
        identity: row.identity,
        stale: row.stale,
        clearedAt: row.clearedAt,
        capturedAt: row.capturedAt,
        verifiedAt: row.verifiedAt,
        updatedAt: row.updatedAt,
      })
    }
  }
  return map
}

/**
 * 仅 Worker 使用：读取快照原文
 */
export async function readSessionStateSnapshotContent(
  db: Db,
  input: { targetId: string; targetAccountId: string; accountSlot?: number },
): Promise<SessionSnapshotContent | null> {
  const accountSlot = input.accountSlot ?? 1
  const { sessionStateSnapshots } = schemaFor(db)
  const [row] = await db
    .select()
    .from(sessionStateSnapshots)
    .where(
      and(
        eq(sessionStateSnapshots.targetId, input.targetId),
        eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
        eq(sessionStateSnapshots.accountSlot, accountSlot),
      ),
    )
    .limit(1)

  if (!row || row.state == null) return null

  return {
    hasSnapshot: true,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    accountSlot: row.accountSlot,
    formatVersion: row.formatVersion,
    byteSize: row.byteSize,
    cookieCount: row.cookieCount,
    originCount: row.originCount,
    hasIndexedDb: row.hasIndexedDb,
    earliestCookieExpiry: row.earliestCookieExpiry,
    identity: row.identity,
    stale: row.stale,
    clearedAt: row.clearedAt,
    capturedAt: row.capturedAt,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
    state: row.state as Record<string, unknown>,
    sessionId: row.sessionId,
    sessionGeneration: row.sessionGeneration,
    sessionFencingToken: row.sessionFencingToken,
    contentDigest: row.contentDigest,
  }
}

/**
 * 清除快照登录态：
 * 置空 state，写入 cleared_at 墓碑，标记 stale，并请求关闭该账号当前活会话
 */
export async function clearSessionStateSnapshot(
  db: Db,
  input: { targetId: string; targetAccountId: string; accountSlot?: number },
): Promise<{ clearedSlots: number; closedSessions: number }> {
  return atomic(db, async (tx) => {
    const { sessionStateSnapshots, browserSessions } = schemaFor(tx)
    const now = await clockNow(tx as unknown as Db)

    const conditions = [
      eq(sessionStateSnapshots.targetId, input.targetId),
      eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
    ]
    if (input.accountSlot !== undefined) {
      conditions.push(eq(sessionStateSnapshots.accountSlot, input.accountSlot))
    }

    // 1. 查询涉及的所有槽位行，若不存在则插一条墓碑
    const existing = await tx
      .select({ accountSlot: sessionStateSnapshots.accountSlot })
      .from(sessionStateSnapshots)
      .where(and(...conditions))

    let clearedSlots = 0
    if (existing.length > 0) {
      await tx
        .update(sessionStateSnapshots)
        .set({
          state: null,
          clearedAt: now,
          stale: true,
          byteSize: 0,
          cookieCount: 0,
          originCount: 0,
          hasIndexedDb: false,
          contentDigest: null,
          updatedAt: now,
        })
        .where(and(...conditions))
      clearedSlots = existing.length
    } else {
      // 插入一条墓碑
      const slot = input.accountSlot ?? 1
      await tx.insert(sessionStateSnapshots).values({
        targetId: input.targetId,
        targetAccountId: input.targetAccountId,
        accountSlot: slot,
        state: null,
        clearedAt: now,
        stale: true,
        createdAt: now,
        updatedAt: now,
      })
      clearedSlots = 1
    }

    // 2. 请求关闭该账号涉及的活会话
    const sessionConditions = [
      eq(browserSessions.targetId, input.targetId),
      eq(browserSessions.targetAccountId, input.targetAccountId),
      sql`${browserSessions.status} IN ('CREATING', 'OPEN')`,
    ]
    if (input.accountSlot !== undefined) {
      sessionConditions.push(eq(browserSessions.accountSlot, input.accountSlot))
    }

    const liveSessions = await tx
      .select({ id: browserSessions.id, version: browserSessions.version })
      .from(browserSessions)
      .where(and(...sessionConditions))

    let closedSessions = 0
    for (const sess of liveSessions) {
      const updated = await tx
        .update(browserSessions)
        .set({
          status: 'CLOSING',
          closeReason: 'snapshot_cleared',
          version: sess.version + 1,
          updatedAt: now,
        })
        .where(and(eq(browserSessions.id, sess.id), eq(browserSessions.version, sess.version)))
      if (updated) closedSessions += 1
    }

    return { clearedSlots, closedSessions }
  })
}

/**
 * 账号并发上限调低后，清理超出上限的槽位快照行
 */
export async function pruneSnapshotsExceedingCap(
  db: Db,
  input: { targetId: string; targetAccountId: string; effectiveCap?: number; maxSlots?: number },
): Promise<number> {
  const cap = input.effectiveCap ?? input.maxSlots ?? 1
  const { sessionStateSnapshots } = schemaFor(db)
  const deleted = await db
    .delete(sessionStateSnapshots)
    .where(
      and(
        eq(sessionStateSnapshots.targetId, input.targetId),
        eq(sessionStateSnapshots.targetAccountId, input.targetAccountId),
        gt(sessionStateSnapshots.accountSlot, cap),
      ),
    )
  return (deleted as { rowCount?: number }).rowCount ?? 0
}
