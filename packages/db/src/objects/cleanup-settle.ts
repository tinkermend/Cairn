import { and, eq, inArray, isNotNull, desc } from 'drizzle-orm'
import {
  formatByteSize,
  isCleanupFailed,
  tallyKnownBytes,
  type ExecutionActor,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { recordAudit } from '../audit/record.js'
import { targetCleanupObjectFilter, runCleanupObjectScope } from '../reports/cleanup.js'

export async function settleTargetCleanups(
  db: Db,
  now = new Date(),
): Promise<{ settled: number }> {
  const { targets, consoleAuditEvents, storedObjects } = schemaFor(db)

  // 1. 获取最近软删除的目标系统列表（最多 50 个）
  const deletedTargets = await db
    .select({
      id: targets.id,
      name: targets.name,
      code: targets.code,
      deletedAt: targets.deletedAt,
      deletedBy: targets.deletedBy,
    })
    .from(targets)
    .where(isNotNull(targets.deletedAt))
    .orderBy(desc(targets.deletedAt))
    .limit(50)

  if (deletedTargets.length === 0) {
    return { settled: 0 }
  }

  const targetIds = deletedTargets.map((t) => t.id)

  // 2. 检查哪些目标已经写入过 target.cleanup 审计日志
  const existingAudits = await db
    .select({ resourceId: consoleAuditEvents.resourceId })
    .from(consoleAuditEvents)
    .where(
      and(
        eq(consoleAuditEvents.action, 'target.cleanup'),
        eq(consoleAuditEvents.resource, 'target'),
        inArray(consoleAuditEvents.resourceId, targetIds),
      ),
    )

  const auditedSet = new Set(
    existingAudits
      .map((a) => a.resourceId)
      .filter((id): id is string => id !== null),
  )

  const pendingTargets = deletedTargets.filter((t) => !auditedSet.has(t.id))
  if (pendingTargets.length === 0) {
    return { settled: 0 }
  }

  let settled = 0

  for (const target of pendingTargets) {
    const objects = await db
      .select({
        status: storedObjects.status,
        byteSize: storedObjects.byteSize,
        purgeAttempts: storedObjects.purgeAttempts,
        lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
      })
      .from(storedObjects)
      .where(targetCleanupObjectFilter(db, target.id))

    const total = objects.length
    const purged = objects.filter((o) => o.status === 'purged').length
    const failed = objects.filter((o) => isCleanupFailed(o)).length

    // 若尚未全部进入终态（既非 purged 也非已达重试上限的 failed），则本轮仍处于清理中，暂不结算
    if (total > 0 && purged + failed < total) {
      continue
    }

    const byteTally = tallyKnownBytes(objects.map((o) => o.byteSize))
    const purgedBytes = tallyKnownBytes(
      objects.filter((o) => o.status === 'purged').map((o) => o.byteSize),
    ).knownBytes

    let summary: string
    if (total === 0) {
      if (target.deletedAt && now.getTime() - target.deletedAt.getTime() > 24 * 60 * 60 * 1000) {
        continue
      }
      summary = `目标附件清理完成 ${target.name}（${target.code}）：无关联附件需清理`
    } else if (failed > 0) {
      summary = `目标附件清理部分失败 ${target.name}（${target.code}）：已清理 ${purged}/${total} 个对象（共 ${formatByteSize(purgedBytes)}），${failed} 个对象清理失败`
    } else {
      summary = `目标附件清理完成 ${target.name}（${target.code}）：已清理 ${purged} 个附件对象，共 ${formatByteSize(purgedBytes)}`
    }

    const actorId = target.deletedBy?.id
    const actor: ExecutionActor = actorId
      ? target.deletedBy?.kind === 'service'
        ? { kind: 'service', id: actorId, credentialId: actorId, scopes: [] }
        : { kind: 'console', id: actorId }
      : { kind: 'console', id: target.id }

    await recordAudit(db, actor, 'target.cleanup', 'target', target.id, summary)
    settled += 1
  }

  return { settled }
}

export async function settleRunCleanups(
  db: Db,
  now = new Date(),
): Promise<{ settled: number }> {
  const { runs, consoleAuditEvents, storedObjects } = schemaFor(db)

  const deletedRuns = await db
    .select({
      id: runs.id,
      deletedAt: runs.deletedAt,
      deletedBy: runs.deletedBy,
    })
    .from(runs)
    .where(isNotNull(runs.deletedAt))
    .orderBy(desc(runs.deletedAt))
    .limit(50)

  if (deletedRuns.length === 0) {
    return { settled: 0 }
  }

  const runIds = deletedRuns.map((r) => r.id)

  const existingAudits = await db
    .select({ resourceId: consoleAuditEvents.resourceId })
    .from(consoleAuditEvents)
    .where(
      and(
        eq(consoleAuditEvents.action, 'run.cleanup'),
        eq(consoleAuditEvents.resource, 'run'),
        inArray(consoleAuditEvents.resourceId, runIds),
      ),
    )

  const auditedSet = new Set(
    existingAudits
      .map((a) => a.resourceId)
      .filter((id): id is string => id !== null),
  )

  const pendingRuns = deletedRuns.filter((r) => !auditedSet.has(r.id))
  if (pendingRuns.length === 0) {
    return { settled: 0 }
  }

  let settled = 0

  for (const run of pendingRuns) {
    const scope = await runCleanupObjectScope(db, run.id)
    const objects = await db
      .select({
        status: storedObjects.status,
        byteSize: storedObjects.byteSize,
        purgeAttempts: storedObjects.purgeAttempts,
        lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
      })
      .from(storedObjects)
      .where(scope.filter)

    const total = objects.length
    const purged = objects.filter((o) => o.status === 'purged').length
    const failed = objects.filter((o) => isCleanupFailed(o)).length

    if (total > 0 && purged + failed < total) {
      continue
    }

    const byteTally = tallyKnownBytes(objects.map((o) => o.byteSize))
    const purgedBytes = tallyKnownBytes(
      objects.filter((o) => o.status === 'purged').map((o) => o.byteSize),
    ).knownBytes

    let summary: string
    if (total === 0) {
      if (run.deletedAt && now.getTime() - run.deletedAt.getTime() > 24 * 60 * 60 * 1000) {
        continue
      }
      summary = `运行附件清理完成 ${run.id.slice(0, 8)}：无关联附件需清理`
    } else if (failed > 0) {
      summary = `运行附件清理部分失败 ${run.id.slice(0, 8)}：已清理 ${purged}/${total} 个对象（共 ${formatByteSize(purgedBytes)}），${failed} 个对象清理失败`
    } else {
      summary = `运行附件清理完成 ${run.id.slice(0, 8)}：已清理 ${purged} 个附件对象，共 ${formatByteSize(purgedBytes)}`
    }

    const actorId = run.deletedBy?.id
    const actor: ExecutionActor = actorId
      ? run.deletedBy?.kind === 'service'
        ? { kind: 'service', id: actorId, credentialId: actorId, scopes: [] }
        : { kind: 'console', id: actorId }
      : { kind: 'console', id: run.id }

    await recordAudit(db, actor, 'run.cleanup', 'run', run.id, summary)
    settled += 1
  }

  return { settled }
}
