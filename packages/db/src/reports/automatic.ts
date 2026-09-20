import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../client.js'
import { atomic, locked, schemaFor } from '../native.js'
import { lockConsoleAuthorization } from '../console/target-authorization.js'
import { recordAudit } from '../audit/record.js'
import { appendSuiteEvents } from '../suites/runs.js'
import { createReport, enqueueReportExport } from './reports.js'

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
        await enqueueReportExport(tx, report.id, report.currentRevision!.id, ['docx', 'pdf'], actor, `auto-suite-export:${item.id}`)
        await tx.update(suiteReportTriggers).set({ status: 'created', reportId: report.id, updatedAt: new Date() }).where(eq(suiteReportTriggers.suiteRunId, item.id))
        await appendSuiteEvents(tx, item.id, [{ type: 'suite_run.report_changed', payload: { reportId: report.id, status: 'created' } }])
      })
    } catch (error) {
      // A rolled-back generation leaves no partially created report. Persist a separate delivery outcome.
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
