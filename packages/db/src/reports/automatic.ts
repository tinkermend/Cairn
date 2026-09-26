import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, locked, schemaFor } from '../native.js'
import { lockConsoleAuthorization } from '../console/target-authorization.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { appendSuiteEvents } from '../suites/runs.js'
import { appendRunEvents } from '../observe/events.js'
import { createReport, enqueueReportExport } from './reports.js'

export async function generateDueReports(db: Db, limit = 8) {
  const { reportTriggers, runs, suiteRuns, suiteReportTriggers } = schemaFor(db)
  const now = new Date()
  const timeoutThreshold = new Date(now.getTime() - 60_000)

  // 1. 证据超时强制收尾：若运行终态但证据卡在 PENDING 超过 60s，强制收尾为 INCOMPLETE
  const timedOutRuns = await db.select({ id: runs.id })
    .from(runs)
    .where(and(
      inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
      eq(runs.evidenceStatus, 'PENDING'),
      lt(runs.finishedAt, timeoutThreshold),
    ))
    .limit(32)

  for (const item of timedOutRuns) {
    try {
      await atomic(db, async (tx) => {
        const { runs: txRuns } = schemaFor(tx)
        const [targetRun] = await locked(tx, tx.select().from(txRuns).where(eq(txRuns.id, item.id)))
        if (!targetRun || targetRun.evidenceStatus !== 'PENDING') return
        await tx.update(txRuns).set({ evidenceStatus: 'INCOMPLETE', updatedAt: new Date() }).where(eq(txRuns.id, item.id))
        await appendRunEvents(tx, item.id, [{ type: 'run.status_changed', payload: { evidenceStatus: 'INCOMPLETE' } }])
      })
    } catch {
      // 容错继续
    }
  }

  // 2. 扫描通用 report_triggers
  const runCandidates = await db.select({
    triggerId: reportTriggers.id,
    subjectKind: reportTriggers.subjectKind,
    subjectId: reportTriggers.subjectId,
    idempotencyKey: reportTriggers.idempotencyKey,
    actorId: runs.createdByConsoleAccountId,
    serviceCallerId: runs.serviceCallerId,
  })
    .from(reportTriggers)
    .innerJoin(runs, eq(runs.id, reportTriggers.subjectId))
    .where(and(
      eq(reportTriggers.status, 'pending'),
      eq(reportTriggers.subjectKind, 'RUN'),
      inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
      ne(runs.evidenceStatus, 'PENDING'),
    ))
    .orderBy(asc(reportTriggers.updatedAt))
    .limit(Math.min(limit, 32))

  for (const item of runCandidates) {
    try {
      await atomic(db, async (tx) => {
        const { reportTriggers: txTriggers, suiteRunItems: txSuiteItems } = schemaFor(tx)
        const [trigger] = await locked(tx, tx.select().from(txTriggers).where(eq(txTriggers.id, item.triggerId)))
        if (trigger?.status !== 'pending') return

        // 检查跳过的场景集成员：不自动出单场景报告
        if (item.subjectKind === 'RUN') {
          const [memberItem] = await tx.select({ admissionStatus: txSuiteItems.admissionStatus })
            .from(txSuiteItems)
            .where(eq(txSuiteItems.childRunId, item.subjectId))
            .limit(1)
          if (memberItem?.admissionStatus === 'SKIPPED') {
            await tx.update(txTriggers).set({ status: 'skipped', reason: 'member_skipped', updatedAt: new Date() }).where(eq(txTriggers.id, item.triggerId))
            return
          }
        }

        const actor: AuditActor = item.actorId
          ? { kind: 'console', id: item.actorId }
          : item.serviceCallerId
            ? { kind: 'service', id: item.serviceCallerId }
            : { kind: 'console', id: '00000000-0000-0000-0000-000000000000' }
        if (actor.kind === 'console') {
          await lockConsoleAuthorization(tx, actor.id)
        }
        const report = await createReport(tx, { subject: { kind: 'RUN', runId: item.subjectId }, stage: 'final', scope: 'run', idempotencyKey: trigger.idempotencyKey }, actor)
        await enqueueReportExport(tx, report.id, report.currentRevision!.id, ['html'], actor, `auto-run-export:${item.subjectId}`)
        await tx.update(txTriggers).set({ status: 'created', reportId: report.id, updatedAt: new Date() }).where(eq(txTriggers.id, item.triggerId))
        await appendRunEvents(tx, item.subjectId, [{ type: 'run.report_changed', payload: { reportId: report.id, status: 'created' } }])
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 256) : '自动生成失败'
      await atomic(db, async (tx) => {
        const { reportTriggers: txTriggers } = schemaFor(tx)
        const [trigger] = await locked(tx, tx.select().from(txTriggers).where(eq(txTriggers.id, item.triggerId)))
        if (trigger?.status !== 'pending') return
        await tx.update(txTriggers).set({ status: 'failed', reason, updatedAt: new Date() }).where(eq(txTriggers.id, item.triggerId))
        await appendRunEvents(tx, item.subjectId, [{ type: 'run.report_changed', payload: { status: 'failed', reason } }])
        const actor: AuditActor = item.actorId
          ? { kind: 'console', id: item.actorId }
          : item.serviceCallerId
            ? { kind: 'service', id: item.serviceCallerId }
            : { kind: 'console', id: '00000000-0000-0000-0000-000000000000' }
        await recordAudit(tx, actor, 'report.auto.skipped', 'run', item.subjectId, '自动报告未交付，业务运行结论不变')
      })
    }
  }

  // 3. 场景集总报告（兼容原 suiteReportTriggers）
  const suiteCount = await generateDueSuiteReports(db, limit)
  return runCandidates.length + suiteCount
}

export async function generateDueSuiteReports(db: Db, limit = 8) {
  const { suiteReportTriggers, suiteRuns } = schemaFor(db)
  const candidates = await db.select({ id: suiteRuns.id, actorId: suiteRuns.createdByConsoleAccountId }).from(suiteReportTriggers).innerJoin(suiteRuns, eq(suiteRuns.id, suiteReportTriggers.suiteRunId))
    .where(and(eq(suiteReportTriggers.status, 'pending'), inArray(suiteRuns.status, ['COMPLETED', 'CANCELLED', 'FAILED']), ne(suiteRuns.evidenceStatus, 'PENDING'))).orderBy(asc(suiteReportTriggers.updatedAt)).limit(Math.min(limit, 32))
  for (const item of candidates) {
    try {
      await atomic(db, async (tx) => {
        await lockConsoleAuthorization(tx, item.actorId)
        const [trigger] = await locked(tx, tx.select().from(suiteReportTriggers).where(eq(suiteReportTriggers.suiteRunId, item.id)))
        if (trigger?.status !== 'pending') return
        const actor = { kind: 'console' as const, id: item.actorId }
        const report = await createReport(tx, { subject: { kind: 'SUITE_RUN', suiteRunId: item.id }, stage: 'final', scope: 'suite_summary', idempotencyKey: `auto-suite-report:${item.id}` }, actor)
        await enqueueReportExport(tx, report.id, report.currentRevision!.id, ['html'], actor, `auto-suite-export:${item.id}`)
        await tx.update(suiteReportTriggers).set({ status: 'created', reportId: report.id, updatedAt: new Date() }).where(eq(suiteReportTriggers.suiteRunId, item.id))
        await appendSuiteEvents(tx, item.id, [{ type: 'suite_run.report_changed', payload: { reportId: report.id, status: 'created' } }])
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 256) : '自动生成失败'
      await atomic(db, async (tx) => {
        const [trigger] = await locked(tx, tx.select().from(suiteReportTriggers).where(eq(suiteReportTriggers.suiteRunId, item.id)))
        if (trigger?.status !== 'pending') return
        await tx.update(suiteReportTriggers).set({ status: 'failed', reason, updatedAt: new Date() }).where(eq(suiteReportTriggers.suiteRunId, item.id))
        await appendSuiteEvents(tx, item.id, [{ type: 'suite_run.report_changed', payload: { status: 'failed', reason } }])
        await recordAudit(tx, { kind: 'console', id: item.actorId }, 'report.auto.skipped', 'suite_run', item.id, '自动报告未交付，业务运行结论不变')
      })
    }
  }
  return candidates.length
}
