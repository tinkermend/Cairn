import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createReport,
  createRunWithSnapshot,
  createScenarioWithVersion,
  enqueueReportExport,
  listReports,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 报告快照', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `rpt_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'report',
      email: `report-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `rpt-${targetId}`,
      name: '报告夹具',
      entryUrl: 'https://shop.example/home',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('未结束的运行不能出终稿；结束后冻结来源并可排队导出', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '报告场景',
      steps: [
        {
          id: '00000000-0000-4000-8000-0000000000d1',
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    await expect(
      createReport(
        handle.db,
        {
          subject: { kind: 'RUN', runId: run.detail.id },
          stage: 'final',
          scope: 'run',
          idempotencyKey: `rpt-early-${run.detail.id}`,
        },
        { kind: 'console', id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'REPORT_NOT_READY' })

    const { runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date(), updatedAt: new Date(), outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE' })
      .where(eq(runs.id, run.detail.id))

    const report = await createReport(
      handle.db,
      {
        subject: { kind: 'RUN', runId: run.detail.id },
        stage: 'final',
        scope: 'run',
        idempotencyKey: `rpt-ok-${run.detail.id}`,
      },
      { kind: 'console', id: actorId },
    )
    expect(report.currentRevision?.title).toContain('报告夹具')
    expect(report.currentRevision?.sealedAt).toBeTruthy()

    const listed = await listReports(handle.db, { runId: run.detail.id }, actorId)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.id).toBe(report.id)
    expect(listed.items[0]?.createdAt).toBe(report.createdAt)
    expect(typeof listed.items[0]?.createdAt).toBe('string')

    const job = await enqueueReportExport(
      handle.db,
      report.id,
      report.currentRevision!.id,
      ['docx', 'pdf'],
      { kind: 'console', id: actorId },
      `exp-${report.id}`,
    )
    expect(job.status).toBe('queued')
    const again = await enqueueReportExport(
      handle.db,
      report.id,
      report.currentRevision!.id,
      ['docx', 'pdf'],
      { kind: 'console', id: actorId },
      `exp-${report.id}`,
    )
    expect(again.id).toBe(job.id)
  })
})
