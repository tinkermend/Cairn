import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  DEFAULT_REPORT_CONFIG,
  EXPORT_ARTIFACTS_PROTOCOL,
  REPORT_RENDER_VERSION,
  REPORT_TEMPLATE_VERSION,
  REPORT_LIMITS,
  createReportBodySchema,
  createReportRevisionBodySchema,
  exportJobDtoSchema,
  exportReportBodySchema,
  reportConfigSchema,
  reportDtoSchema,
  reportDocumentSchema,
  reportListQuerySchema,
  reportListResponseSchema,
  reportPreviewResponseSchema,
  substituteReportTitle,
  type CreateReportBody,
  type CreateReportRevisionBody,
  type ExportJobDto,
  type JsonValue,
  type ReportConfig,
  type ReportDocument,
  type ReportDto,
  type ReportListQuery,
  type ReportPreviewResponse,
  type ReportRevisionDto,
  type ReportSubject,
  type ReportTitleVariable,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import { newId } from '../id.js'
import { atomic, locked, schemaFor, updateRows } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { getRun } from '../runs/runs.js'
import { getSuiteRunObservation } from '../suites/runs.js'
import { snapshotDeletedBy } from '../lifecycle.js'
import { prepareReportMaterials, sealReportMaterials } from './materials.js'
import { validateReportConfigAssets } from './profiles.js'
import { revokeReportTrees } from './cleanup.js'
import { assertReportDeploymentReady } from './protocol.js'

function subjectOf(row: { subjectKind: 'RUN' | 'SUITE_RUN'; runId: string | null; suiteRunId: string | null }): ReportSubject {
  return row.subjectKind === 'RUN'
    ? { kind: 'RUN', runId: row.runId! }
    : { kind: 'SUITE_RUN', suiteRunId: row.suiteRunId! }
}

export function toRevision(row: {
  id: string
  revisionNo: number
  stage: ReportRevisionDto['stage']
  scope: ReportRevisionDto['scope']
  title: string
  config: ReportConfig
  templateVersion: string
  renderVersion: string
  sourceSnapshotId: string
  parentReportRevisionId: string | null
  contentCompleteness: string
  sealedAt: Date | null
  createdAt: Date
  preparationError?: string | null
}): ReportRevisionDto {
  return {
    id: row.id,
    revisionNo: row.revisionNo,
    stage: row.stage,
    scope: row.scope,
    title: row.title,
    config: row.config,
    templateVersion: row.templateVersion,
    renderVersion: row.renderVersion,
    sourceSnapshotId: row.sourceSnapshotId,
    parentReportRevisionId: row.parentReportRevisionId,
    contentCompleteness: row.contentCompleteness === 'partial' ? 'partial' : 'complete',
    sealedAt: row.sealedAt?.toISOString() ?? null,
    preparationError: row.preparationError ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function loadReportDto(db: Db, reportId: string, revisionId?: string): Promise<ReportDto> {
  const { reports, reportRevisions, exportJobs } = schemaFor(db)
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1)
  if (!report || report.deletedAt) throw notFound('REPORT_NOT_FOUND', '报告不存在或已删除')
  const [revision] = await db
    .select()
    .from(reportRevisions)
    .where(and(eq(reportRevisions.reportId, reportId), revisionId ? eq(reportRevisions.id, revisionId) : undefined))
    .orderBy(desc(reportRevisions.revisionNo))
    .limit(1)
  const [materialJob] = revision ? await db.select({ id: exportJobs.id }).from(exportJobs).where(and(eq(exportJobs.reportRevisionId, revision.id), eq(exportJobs.kind, 'report_materialize'))).orderBy(desc(exportJobs.createdAt)).limit(1) : []
  return reportDtoSchema.parse({
    id: report.id,
    targetId: report.targetId,
    subject: subjectOf(report),
    currentRevision: revision ? { ...toRevision(revision), materialJobId: materialJob?.id ?? null } : null,
    createdAt: report.createdAt.toISOString(),
  })
}

export async function getReport(db: Db, reportId: string, actorId?: string) {
  const dto = await loadReportDto(db, reportId)
  if (actorId) await assertTargetPermission(db, actorId, dto.targetId, 'report:read')
  await assertReportSourceReadable(db, dto.subject, actorId)
  if (dto.currentRevision?.parentReportRevisionId) {
    const { reportRevisions } = schemaFor(db)
    const [parent] = await db.select({ reportId: reportRevisions.reportId }).from(reportRevisions).where(eq(reportRevisions.id, dto.currentRevision.parentReportRevisionId)).limit(1)
    if (!parent) throw notFound('REPORT_SOURCE_NOT_FOUND', '父报告不存在')
    await getReport(db, parent.reportId, actorId)
  }
  return dto
}

export async function assertReportSourceReadable(db: Db, subject: ReportSubject, actorId?: string) {
  const { runs, suiteRuns, suiteRunItems, targets } = schemaFor(db)
  let targetId: string
  if (subject.kind === 'RUN') {
    const [run] = await db.select().from(runs).where(and(eq(runs.id, subject.runId), isNull(runs.deletedAt))).limit(1)
    if (!run) throw notFound('REPORT_SOURCE_NOT_FOUND', '报告来源已删除或不可访问')
    targetId = run.targetId
  } else {
    const [suite] = await db.select().from(suiteRuns).where(eq(suiteRuns.id, subject.suiteRunId)).limit(1)
    if (!suite) throw notFound('REPORT_SOURCE_NOT_FOUND', '报告来源不可访问')
    targetId = suite.targetId
    const children = await db.select({ deletedAt: runs.deletedAt, targetId: runs.targetId }).from(suiteRunItems)
      .innerJoin(runs, eq(runs.id, suiteRunItems.childRunId)).where(eq(suiteRunItems.suiteRunId, suite.id))
    if (!children.length || children.some((child) => child.deletedAt || child.targetId !== targetId)) {
      throw notFound('REPORT_SOURCE_NOT_FOUND', '集合的报告来源已删除或不可访问')
    }
    if (actorId) await assertTargetPermission(db, actorId, targetId, 'suite:read')
  }
  const [target] = await db.select({ id: targets.id }).from(targets).where(and(eq(targets.id, targetId), isNull(targets.deletedAt))).limit(1)
  if (!target) throw notFound('REPORT_SOURCE_NOT_FOUND', '报告来源已删除或不可访问')
  if (actorId) await assertTargetPermission(db, actorId, targetId, 'run:read')
  return targetId
}

export async function listReports(db: Db, query: Partial<ReportListQuery> = {}, actorId?: string) {
  const parsed = reportListQuerySchema.parse(query)
  const { reports, reportRevisions, runs, suiteRunItems, suiteRuns, targets } = schemaFor(db)
  const suiteScope = await scopedTargetFilter(db, actorId, reports.targetId, 'suite:read')
  const filters: (SQL | undefined)[] = [
    await scopedTargetFilter(db, actorId, reports.targetId, 'report:read'),
    await scopedTargetFilter(db, actorId, reports.targetId, 'run:read'),
    suiteScope ? or(eq(reports.subjectKind, 'RUN'), suiteScope) : undefined,
    isNull(reports.deletedAt),
    sql`EXISTS (SELECT 1 FROM ${targets} t WHERE t.id = ${reports.targetId} AND t.deleted_at IS NULL)`,
    sql`((${reports.subjectKind} = 'RUN' AND EXISTS (SELECT 1 FROM ${runs} r WHERE r.id = ${reports.runId} AND r.deleted_at IS NULL))
      OR (${reports.subjectKind} = 'SUITE_RUN' AND NOT EXISTS (SELECT 1 FROM ${suiteRunItems} i INNER JOIN ${runs} r ON r.id = i.child_run_id WHERE i.suite_run_id = ${reports.suiteRunId} AND r.deleted_at IS NOT NULL)))`,
    parsed.scope ? sql`EXISTS (SELECT 1 FROM ${reportRevisions} rev WHERE rev.report_id = ${reports.id} AND rev.scope = ${parsed.scope})` : undefined,
    parsed.targetId ? eq(reports.targetId, parsed.targetId) : undefined,
    parsed.runId ? eq(reports.runId, parsed.runId) : undefined,
    parsed.suiteRunId ? or(eq(reports.suiteRunId, parsed.suiteRunId), sql`EXISTS (SELECT 1 FROM ${runs} r WHERE r.id = ${reports.runId} AND r.suite_run_id = ${parsed.suiteRunId})`) : undefined,
    parsed.suiteId ? sql`EXISTS (SELECT 1 FROM ${suiteRuns} s WHERE s.suite_id = ${parsed.suiteId} AND (s.id = ${reports.suiteRunId} OR EXISTS (SELECT 1 FROM ${runs} r WHERE r.id = ${reports.runId} AND r.suite_run_id = s.id)))` : undefined,
    cursorFilter(reports.createdAt, reports.id, parsed.cursor),
  ]
  const rows = await db
    .select()
    .from(reports)
    .where(and(...filters.filter((item): item is SQL => item !== undefined)))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(parsed.limit + 1)
  const page = paginateResults(
    rows.map((row) => ({ id: row.id, createdAt: row.createdAt })),
    parsed.limit,
  )
  const items = await Promise.all(page.items.map((row) => loadReportDto(db, row.id)))
  return reportListResponseSchema.parse({
    items,
    nextCursor: page.nextCursor,
  })
}

type CapturedSource = { targetId: string; defaults: ReportConfig; payload: Record<string, JsonValue>; terminal: boolean; evidencePending: boolean; titleVars: Partial<Record<ReportTitleVariable, string>> }
export async function captureSource(db: Db, subject: ReportSubject, actorId?: string): Promise<CapturedSource> {
  await assertReportSourceReadable(db, subject, actorId)
  if (subject.kind === 'RUN') {
    const { runs, evidences, runReportContexts } = schemaFor(db)
    const [row] = await locked(db, db.select().from(runs).where(eq(runs.id, subject.runId)))
    const run = await getRun(db, subject.runId)
    const [context] = await db.select().from(runReportContexts).where(eq(runReportContexts.runId, run.id)).limit(1)
    const evidence = await db.select().from(evidences).where(eq(evidences.runId, run.id)).limit(20_001)
    if (evidence.length > 20_000) throw badRequest('REPORT_SOURCE_LIMIT', '来源证据索引超过 20000 项，请缩小报告来源范围')
    const captured: CapturedSource = {
      targetId: run.targetId,
      defaults: context?.reportConfig ?? DEFAULT_REPORT_CONFIG,
      payload: {
        kind: 'RUN',
        runId: run.id,
        scenarioVersionId: row!.scenarioVersionId,
        snapshotDigest: row!.snapshotDigest,
        eventSeq: row!.eventSeq,
        status: run.status,
        outcomeStatus: run.outcomeStatus,
        evidenceStatus: run.evidenceStatus,
        scenarioName: context?.displayName ?? row!.snapshot.notificationPolicy?.scenarioName ?? run.scenarioName,
        targetName: context?.targetName ?? row!.snapshot.notificationPolicy?.targetName ?? run.targetName,
        reportDefaults: context?.reportConfig ?? DEFAULT_REPORT_CONFIG,
        reportConfigSources: context?.configSources ?? null,
        namesSource: context || row!.snapshot.notificationPolicy ? 'run_snapshot' : 'generation_time',
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        targetAccountName: run.targetAccountName,
        accountNameSource: 'generation_time',
        outcomeResults: run.outcomeResults.map((result) => ({ stepRunId: result.stepRunId, attemptId: result.attemptId, meaning: result.meaning, verdict: result.verdict, severity: result.severity, evidenceId: result.evidenceId ?? null })),
        evidence: evidence.map((item) => ({ evidenceId: item.id, type: item.type, status: item.status,
          stepRunId: item.stepRunId, attemptId: item.attemptId, digest: item.digest, missingReason: item.missingReason })),
        stepRuns: run.stepRuns.map((step) => ({
          id: step.id,
          name: step.name,
          status: step.status,
          outcomeStatus: step.outcomeStatus,
          attempts: step.attempts.map((attempt) => ({ id: attempt.id, status: attempt.status,
            error: attempt.error ? { code: attempt.error.code, message: attempt.error.safeMessage } : null })),
        })),
      } as Record<string, JsonValue>,
      terminal: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status),
      evidencePending: run.evidenceStatus === 'PENDING',
      titleVars: {
        systemName: context?.targetName ?? row!.snapshot.notificationPolicy?.targetName ?? run.targetName,
        scenarioName: context?.displayName ?? row!.snapshot.notificationPolicy?.scenarioName ?? run.scenarioName,
        executedDate: run.createdAt.slice(0, 10),
        runNumber: run.id.slice(0, 8),
      },
    }
    if (Buffer.byteLength(JSON.stringify(captured.payload)) > 16 * 1024 * 1024) throw badRequest('REPORT_SOURCE_LIMIT', '报告来源快照超过 16 MiB，请调整范围')
    return captured
  }
  const { suiteRuns, scenarioSuites, targets, runs } = schemaFor(db)
  const [parent] = await locked(db, db.select().from(suiteRuns).where(eq(suiteRuns.id, subject.suiteRunId)))
  await locked(db, db.select({ id: runs.id }).from(runs).where(eq(runs.suiteRunId, subject.suiteRunId)).orderBy(asc(runs.id)))
  const suite = await getSuiteRunObservation(db, subject.suiteRunId)
  const [meta] = await db
    .select({ suiteName: scenarioSuites.name, targetName: targets.name })
    .from(scenarioSuites)
    .innerJoin(targets, eq(targets.id, scenarioSuites.targetId))
    .where(eq(scenarioSuites.id, suite.suiteId))
    .limit(1)
  const items = []
  let snapshotBytes = 0
  for (const item of suite.items) {
    const child = await captureSource(db, { kind: 'RUN', runId: item.childRunId })
    snapshotBytes += Buffer.byteLength(JSON.stringify(child.payload))
    if (snapshotBytes > 16 * 1024 * 1024) throw badRequest('REPORT_SOURCE_LIMIT', '报告来源快照超过 16 MiB，请调整范围')
    items.push({ ...item, run: child.payload })
  }
  const evidenceStatus = items.some((item) => item.run.evidenceStatus === 'PENDING') ? 'PENDING'
    : items.some((item) => item.run.evidenceStatus === 'INCOMPLETE') ? 'INCOMPLETE' : 'COMPLETE'
  const frozenTargetName = items[0]?.run.targetName
  const targetName = typeof frozenTargetName === 'string' ? frozenTargetName : meta?.targetName ?? '目标系统'
  const frozenDocument = parent!.snapshot.document
  const groups = frozenDocument && typeof frozenDocument === 'object' && !Array.isArray(frozenDocument) ? frozenDocument.groups ?? [] : []
  return {
    targetId: suite.targetId,
    defaults: reportConfigSchema.parse(parent!.snapshot.reportConfig ?? DEFAULT_REPORT_CONFIG),
    payload: {
      kind: 'SUITE_RUN',
      suiteRunId: suite.id,
      suiteVersionId: suite.suiteVersionId,
      snapshotDigest: parent!.snapshotDigest,
      eventSeq: parent!.eventSeq,
      suiteName: parent!.snapshot.suiteName ?? meta?.suiteName ?? null,
      targetName,
      createdAt: suite.createdAt,
      startedAt: suite.startedAt,
      finishedAt: suite.finishedAt,
      wallClockMs: suite.wallClockMs,
      childDurationMs: suite.childDurationMs,
      status: suite.status,
      verdict: suite.verdict,
      evidenceStatus,
      counts: suite.counts,
      groups,
      items,
    } as Record<string, JsonValue>,
    terminal: ['COMPLETED', 'CANCELLED', 'FAILED'].includes(suite.status),
    evidencePending: evidenceStatus === 'PENDING',
    titleVars: {
      systemName: targetName,
      suiteName: typeof parent!.snapshot.suiteName === 'string' ? parent!.snapshot.suiteName : meta?.suiteName ?? '场景集',
      executedDate: suite.createdAt.slice(0, 10),
      executedRange: suite.createdAt.slice(0, 10),
      runNumber: suite.id.slice(0, 8),
    },
  }
}

export function buildDocument(input: {
  stage: ReportDocument['stage']
  title: string
  config: ReportConfig
  source: Record<string, JsonValue>
  gaps: string[]
}): ReportDocument {
  const gaps = [...input.gaps]
  if (input.source.namesSource === 'generation_time') gaps.push('历史运行未冻结名称，本报告使用生成时可获得的名称')
  const asOf = new Date().toISOString()
  return {
    stage: input.stage,
    title: input.title,
    subtitle: input.config.subtitle,
    organization: input.config.organization,
    authorDisplayName: input.config.authorDisplayName,
    timeZone: input.config.timeZone,
    generatedAt: asOf,
    asOf,
    source: input.source,
    summary: {
      status: input.source.status ?? null,
      outcomeStatus: input.source.outcomeStatus ?? null,
      verdict: input.source.verdict ?? null,
    },
    sections: [
      {
        id: 'overview',
        title: '概述',
        required: true,
        blocks: [{ type: 'summary', data: input.source }],
      },
      {
        id: 'result',
        title: '结果',
        required: true,
        blocks: [{ type: 'result', data: input.source, detailLevel: input.config.detailLevel, includeSuccessDetails: input.config.includeSuccessDetails, includeEvidenceIndex: input.config.includeEvidenceIndex, includeAttemptHistory: input.config.includeAttemptHistory }],
      },
    ],
    gaps,
    verdict: typeof input.source.verdict === 'string' ? (input.source.verdict as ReportDocument['verdict']) : null,
    outcomeStatus:
      typeof input.source.outcomeStatus === 'string'
        ? (input.source.outcomeStatus as ReportDocument['outcomeStatus'])
        : null,
    evidenceStatus:
      typeof input.source.evidenceStatus === 'string'
        ? (input.source.evidenceStatus as ReportDocument['evidenceStatus'])
        : null,
  }
}

export async function previewReport(db: Db, body: CreateReportBody, actorId?: string): Promise<ReportPreviewResponse> {
  const input = createReportBodySchema.parse(body)
  if (input.scope === 'suite_bundle') throw badRequest('REPORT_SCOPE_UNSUPPORTED', '请先创建集合总报告，再从固定修订生成报告包')
  if ((input.subject.kind === 'RUN') !== (input.scope === 'run')) throw badRequest('REPORT_SCOPE_MISMATCH', '报告范围与来源类型不匹配')
  return atomic(db, async (tx) => previewReportTx(tx, input, actorId))
}

async function previewReportTx(db: Db, input: CreateReportBody, actorId?: string): Promise<ReportPreviewResponse> {
  await assertReportSourceReadable(db, input.subject, actorId)
  const captured = await captureSource(db, input.subject)
  if (actorId) await assertTargetPermission(db, actorId, captured.targetId, 'report:read')
  const config = reportConfigSchema.parse({ ...captured.defaults, ...input.config })
  await validateReportConfigAssets(db, captured.targetId, config)
  const title = reportTitle(config, captured)
  const issues: string[] = []
  if (!captured.terminal && input.stage === 'final') issues.push('来源尚未结束，不能生成终稿')
  if (captured.evidencePending) issues.push('证据仍在收集，报告内容可能不完整')
  if (captured.payload.evidenceStatus === 'INCOMPLETE') issues.push('必要证据不完整，请结合缺项核查结论')
  if (!captured.terminal && input.stage === 'phase') issues.push('阶段性结果：来源尚未结束')
  return reportPreviewResponseSchema.parse({
    subject: input.subject,
    stage: input.stage,
    scope: input.scope,
    title,
    canGenerateFinal: captured.terminal && !captured.evidencePending,
    evidencePending: captured.evidencePending,
    issues,
  })
}

export function reportTitle(config: ReportConfig, captured: CapturedSource) {
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const started = new Date(String(captured.payload.startedAt ?? captured.payload.createdAt))
    const executedDate = format.format(started)
    const end = captured.payload.finishedAt ? format.format(new Date(String(captured.payload.finishedAt))) : executedDate
    const vars = { ...captured.titleVars, executedDate, executedRange: executedDate === end ? executedDate : `${executedDate} 至 ${end}` }
    if ([...config.title.matchAll(/\{([A-Za-z]+)\}/g)].some((match) => vars[match[1] as ReportTitleVariable] === undefined)) throw new Error('标题包含当前来源不可用的变量，请检查场景名称或场景集名称')
    return substituteReportTitle(config.title, vars)
  }
  catch (error) { throw badRequest('REPORT_TITLE_INVALID', error instanceof Error ? error.message : '报告标题无效') }
}

function sourceEvidence(source: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  if (source.kind === 'RUN') return (source.evidence ?? []) as Array<Record<string, JsonValue>>
  return ((source.items ?? []) as Array<{ run: Record<string, JsonValue> }>).flatMap((item) => sourceEvidence(item.run))
}

export async function createReport(db: Db, body: CreateReportBody, actor: AuditActor) {
  const input = createReportBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { reports } = schemaFor(tx)
    const digest = sha256Hex(input)
    const [existing] = await tx.select().from(reports).where(and(eq(reports.createdByConsoleAccountId, actor.id), eq(reports.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('REPORT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同报告请求')
      return getReport(tx, existing.id, actor.id)
    }
    return createReportTx(tx, input, actor, digest)
  })
}

async function createReportTx(db: Db, input: CreateReportBody, actor: AuditActor, digest: string) {
  await assertReportDeploymentReady(db)
  const preview = await previewReport(db, input, actor.id)
  if (input.stage === 'final' && !preview.canGenerateFinal) {
    throw badRequest('REPORT_NOT_READY', preview.issues[0] ?? '来源尚未结束')
  }
  const captured = await captureSource(db, input.subject)
  await assertTargetPermission(db, actor.id, captured.targetId, 'report:export')
  const config = reportConfigSchema.parse({ ...captured.defaults, ...input.config })
  const title = reportTitle(config, captured)
  const reportId = newId()
  await atomic(db, async (tx) => {
    const { reports, reportSourceSnapshots, reportRevisions } = schemaFor(tx)
    await tx.insert(reports).values({
      id: reportId,
      targetId: captured.targetId,
      subjectKind: input.subject.kind,
      runId: input.subject.kind === 'RUN' ? input.subject.runId : null,
      suiteRunId: input.subject.kind === 'SUITE_RUN' ? input.subject.suiteRunId : null,
      createdByConsoleAccountId: actor.id,
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
    })
    const snapshotId = newId()
    await tx.insert(reportSourceSnapshots).values({
      id: snapshotId,
      reportId,
      payload: captured.payload,
      digest: sha256Hex(captured.payload),
      capturedAt: new Date(),
    })
    const gaps = preview.issues
    const document = buildDocument({ stage: input.stage, title, config, source: captured.payload, gaps })
    const revisionId = newId()
    await tx.insert(reportRevisions).values({
      id: revisionId,
      reportId,
      revisionNo: 1,
      stage: input.stage,
      scope: input.scope,
      title,
      config,
      templateVersion: REPORT_TEMPLATE_VERSION,
      renderVersion: REPORT_RENDER_VERSION,
      sourceSnapshotId: snapshotId,
      contentCompleteness: document.gaps.length ? 'partial' : 'complete',
      document,
      sealedAt: null,
    })
    await prepareReportMaterials(tx, { reportId, revisionId, targetId: captured.targetId, source: captured.payload, config, actorId: actor.id })
    await recordAudit(tx, actor, 'report.create', 'report', reportId, `创建报告「${title}」`)
  })
  return getReport(db, reportId)
}

export async function createReportRevision(db: Db, reportId: string, body: CreateReportRevisionBody, actor: AuditActor) {
  const input = createReportRevisionBodySchema.parse(body)
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { reports, reportRevisions } = schemaFor(tx)
    await locked(tx, tx.select({ id: reports.id }).from(reports).where(eq(reports.id, reportId)))
    const digest = sha256Hex({ reportId, ...input })
    const [existing] = await tx.select().from(reportRevisions).where(and(eq(reportRevisions.createdByConsoleAccountId, actor.id), eq(reportRevisions.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      await getReport(tx, reportId, actor.id)
      if (existing.requestDigest !== digest) throw conflict('REPORT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同修订请求')
      return loadReportDto(tx, reportId, existing.id)
    }
    return createReportRevisionTx(tx, reportId, input, actor, digest)
  })
}

async function createReportRevisionTx(db: Db, reportId: string, input: CreateReportRevisionBody, actor: AuditActor, digest: string) {
  await assertReportDeploymentReady(db)
  const current = await getReport(db, reportId, actor.id)
  await assertTargetPermission(db, actor.id, current.targetId, 'report:export')
  const captured = await captureSource(db, current.subject)
  const config = reportConfigSchema.parse({ ...captured.defaults, ...current.currentRevision?.config, ...input.config })
  await validateReportConfigAssets(db, captured.targetId, config)
  const stage = input.stage ?? current.currentRevision?.stage ?? 'final'
  if (stage === 'final' && (!captured.terminal || captured.evidencePending)) throw badRequest('REPORT_NOT_READY', '来源尚未结束或证据仍在收集，请生成阶段报告')
  const title = reportTitle(config, captured)
  const preview = await previewReport(db, { subject: current.subject, stage, scope: current.currentRevision?.scope ?? 'run', config, idempotencyKey: input.idempotencyKey }, actor.id)
  const document = buildDocument({ stage, title, config, source: captured.payload, gaps: preview.issues })
  await atomic(db, async (tx) => {
    const { reportSourceSnapshots, reportRevisions } = schemaFor(tx)
    const snapshotId = newId()
    await tx.insert(reportSourceSnapshots).values({
      id: snapshotId,
      reportId,
      payload: captured.payload,
      digest: sha256Hex(captured.payload),
      capturedAt: new Date(),
    })
    const nextNo = (current.currentRevision?.revisionNo ?? 0) + 1
    const revisionId = newId()
    await tx.insert(reportRevisions).values({
      id: revisionId,
      reportId,
      revisionNo: nextNo,
      createdByConsoleAccountId: actor.id,
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
      stage: input.stage ?? current.currentRevision?.stage ?? 'final',
      scope: current.currentRevision?.scope ?? (current.subject.kind === 'RUN' ? 'run' : 'suite_summary'),
      title,
      config,
      templateVersion: REPORT_TEMPLATE_VERSION,
      renderVersion: REPORT_RENDER_VERSION,
      sourceSnapshotId: snapshotId,
      parentReportRevisionId: null,
      contentCompleteness: document.gaps.length ? 'partial' : 'complete',
      document,
      sealedAt: null,
    })
    await prepareReportMaterials(tx, { reportId, revisionId, targetId: current.targetId, source: captured.payload, config, actorId: actor.id })
    await recordAudit(tx, actor, 'report.create', 'report', reportId, `新增报告修订 ${nextNo}：${input.reason}`)
  })
  return getReport(db, reportId)
}

export async function enqueueReportExport(
  db: Db,
  reportId: string,
  revisionId: string,
  formats: Array<'docx' | 'pdf'>,
  actor: AuditActor,
  idempotencyKey: string,
): Promise<ExportJobDto> {
  const input = exportReportBodySchema.parse({ formats, idempotencyKey })
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    return enqueueReportExportTx(tx, reportId, revisionId, [...new Set(input.formats)].sort(), actor, input.idempotencyKey)
  })
}

async function enqueueReportExportTx(db: Db, reportId: string, revisionId: string, formats: Array<'docx' | 'pdf'>, actor: AuditActor, idempotencyKey: string): Promise<ExportJobDto> {
  await assertReportDeploymentReady(db)
  const report = await getReport(db, reportId, actor.id)
  await assertTargetPermission(db, actor.id, report.targetId, 'report:export')
  if (!report.currentRevision || report.currentRevision.id !== revisionId) {
    const { reportRevisions } = schemaFor(db)
    const [revision] = await db.select().from(reportRevisions).where(eq(reportRevisions.id, revisionId)).limit(1)
    if (!revision || revision.reportId !== reportId) throw notFound('REPORT_NOT_FOUND', '报告修订不存在')
  }
  const digest = sha256Hex({ reportId, revisionId, formats })
  const jobId = newId()
  await atomic(db, async (tx) => {
    const { exportJobs } = schemaFor(tx)
    const [existing] = await tx
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.createdByConsoleAccountId, actor.id), eq(exportJobs.idempotencyKey, idempotencyKey)))
      .limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('EXPORT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同导出请求')
      return
    }
    await tx.insert(exportJobs).values({
      id: jobId,
      kind: 'report_render',
      targetId: report.targetId,
      reportId,
      reportRevisionId: revisionId,
      createdByConsoleAccountId: actor.id,
      status: 'queued',
      sourceManifest: { formats },
      requestDigest: digest,
      idempotencyKey,
    })
    await recordAudit(tx, actor, 'report.export', 'report', reportId, `导出 ${formats.join(',')}`)
  })
  const { exportJobs, exportJobArtifacts } = schemaFor(db)
  const [job] = await db
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.createdByConsoleAccountId, actor.id), eq(exportJobs.idempotencyKey, idempotencyKey)))
    .limit(1)
  if (!job) throw conflict('EXPORT_JOB_CONFLICT', '导出任务创建失败')
  const artifacts = await db.select().from(exportJobArtifacts).where(eq(exportJobArtifacts.jobId, job.id))
  return exportJobDtoSchema.parse({
    id: job.id,
    kind: job.kind,
    status: job.status,
    contentCompleteness: job.contentCompleteness === 'partial' ? 'partial' : job.contentCompleteness === 'complete' ? 'complete' : null,
    progress: job.progress,
    error: job.error,
    artifactIds: artifacts.map((row) => row.artifactId),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  })
}

export async function getExportJob(db: Db, jobId: string, actorId?: string): Promise<ExportJobDto> {
  const { exportJobs, exportJobArtifacts } = schemaFor(db)
  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1)
  if (!job) throw notFound('EXPORT_JOB_NOT_FOUND', '导出任务不存在')
  if (actorId) await assertTargetPermission(db, actorId, job.targetId, 'report:read')
  if (job.reportId) await getReport(db, job.reportId, actorId)
  const artifacts = await db.select().from(exportJobArtifacts).where(eq(exportJobArtifacts.jobId, job.id))
  const { getArtifact } = await import('../objects/artifacts.js')
  const metadata = await Promise.all(artifacts.map((row) => getArtifact(db, row.artifactId, actorId)))
  return exportJobDtoSchema.parse({
    id: job.id,
    kind: job.kind,
    status: job.status,
    contentCompleteness: job.contentCompleteness === 'partial' ? 'partial' : job.contentCompleteness === 'complete' ? 'complete' : null,
    progress: job.progress,
    error: job.error,
    artifactIds: artifacts.map((row) => row.artifactId),
    artifacts: metadata,
    reportId: job.reportId,
    reportRevisionId: job.reportRevisionId,
    retryCount: job.retryCount,
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  })
}

export async function claimExportJobs(
  db: Db,
  input: { workerId: string; instanceId: string; limit?: number; leaseMs?: number },
) {
  return atomic(db, async (tx) => claimExportJobsTx(tx, input))
}

async function claimExportJobsTx(db: Db, input: { workerId: string; instanceId: string; limit?: number; leaseMs?: number }) {
  const { exportJobs, workers, reportRevisions } = schemaFor(db)
  const now = new Date()
  // A stable registry row serializes admission, while rendering runs outside this transaction.
  await locked(db, db.select({ id: workers.id }).from(workers).orderBy(asc(workers.id)).limit(1))
  const [worker] = await db.select().from(workers).where(and(eq(workers.id, input.workerId), eq(workers.instanceId, input.instanceId))).limit(1)
  if (!worker || worker.status !== 'READY' || !worker.protocolCapabilities.includes(EXPORT_ARTIFACTS_PROTOCOL) || (worker.heartbeatExpiresAt && worker.heartbeatExpiresAt <= now)) return []
  const active = await db.select({ workerId: exportJobs.holderWorkerId }).from(exportJobs).where(and(eq(exportJobs.status, 'running'), sql`${exportJobs.leaseUntil} > ${now}`))
  if (active.length >= 4 || active.some((job) => job.workerId === input.workerId)) return []
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 60_000))
  const claimable = or(eq(exportJobs.status, 'queued'), and(eq(exportJobs.status, 'running'), sql`${exportJobs.leaseUntil} < ${now}`))
  const rows = await locked(db, db
    .select()
    .from(exportJobs)
    .where(claimable)
    .orderBy(sql`CASE WHEN ${exportJobs.status} = 'running' THEN 0 ELSE 1 END`, exportJobs.updatedAt, exportJobs.id)
    .limit(32), true)
  const claimed = []
  for (const row of rows) {
    if (claimed.length >= Math.min(input.limit ?? 1, 1, 4 - active.length)) break
    const [revision] = row.reportRevisionId ? await db.select().from(reportRevisions).where(eq(reportRevisions.id, row.reportRevisionId)).limit(1) : []
    let failure: string | null = row.deadlineAt && row.deadlineAt <= now ? '导出超过 10 分钟期限' : row.retryCount >= REPORT_LIMITS.retries && row.status === 'running' ? '导出恢复次数达到上限' : null
    if (!revision) failure = '报告修订不存在'
    if (revision?.preparationError) failure = revision.preparationError
    if (failure) {
      await db.update(exportJobs).set({ status: 'failed', error: failure, leaseUntil: null, updatedAt: now }).where(eq(exportJobs.id, row.id))
      await cleanupUnusedJobArtifacts(db, row.id)
      if (row.kind === 'report_materialize' && revision && !revision.sealedAt) await db.update(reportRevisions).set({ preparationError: failure }).where(eq(reportRevisions.id, revision.id))
      continue
    }
    if (row.kind === 'report_render' && !revision?.sealedAt) { await db.update(exportJobs).set({ updatedAt: now }).where(eq(exportJobs.id, row.id)); continue }
    if (row.kind === 'report_bundle') {
      const dependencyIds = row.sourceManifest.jobIds
      if (!Array.isArray(dependencyIds) || dependencyIds.some((id) => typeof id !== 'string')) {
        await db.update(exportJobs).set({ status: 'failed', error: '报告包依赖清单无效', updatedAt: now }).where(eq(exportJobs.id, row.id))
        continue
      }
      const dependencies = dependencyIds.length ? await db.select({ status: exportJobs.status }).from(exportJobs).where(inArray(exportJobs.id, dependencyIds as string[])) : []
      if (dependencies.length !== dependencyIds.length || dependencies.some((item) => ['queued', 'running'].includes(item.status))) { await db.update(exportJobs).set({ updatedAt: now }).where(eq(exportJobs.id, row.id)); continue }
    }
    const updated = await updateRows(
      db,
      exportJobs,
      {
        status: 'running',
        holderWorkerId: input.workerId,
        holderInstanceId: input.instanceId,
        claimEpoch: row.claimEpoch + 1,
        retryCount: row.retryCount + (row.status === 'running' ? 1 : 0),
        leaseUntil,
        deadlineAt: row.deadlineAt ?? new Date(now.getTime() + REPORT_LIMITS.taskMs),
        updatedAt: now,
      },
      and(eq(exportJobs.id, row.id), eq(exportJobs.claimEpoch, row.claimEpoch), claimable),
      { id: exportJobs.id },
    )
    if (updated.length === 0) continue
    claimed.push({ ...row, holderWorkerId: input.workerId, holderInstanceId: input.instanceId, claimEpoch: row.claimEpoch + 1, leaseUntil, deadlineAt: row.deadlineAt ?? new Date(now.getTime() + REPORT_LIMITS.taskMs) })
  }
  return claimed
}

export type ExportGrant = { jobId: string; workerId: string; instanceId: string; claimEpoch: number }

export async function guardExportJob(db: Db, grant: ExportGrant, lock = false) {
  const { exportJobs, workers } = schemaFor(db)
  const query = db.select().from(exportJobs).where(grantPredicate(db, grant))
  if (lock) {
    const [candidate] = await db.select().from(exportJobs).where(eq(exportJobs.id, grant.jobId)).limit(1)
    if (candidate) await lockConsoleAuthorization(db, candidate.createdByConsoleAccountId)
  }
  const [job] = lock ? await locked(db, query) : await query.limit(1)
  if (!job?.reportId) throw conflict('EXPORT_CLAIM_LOST', '导出任务已取消、超时或执行权已失效')
  const [worker] = await db.select().from(workers).where(and(eq(workers.id, grant.workerId), eq(workers.instanceId, grant.instanceId), eq(workers.status, 'READY'))).limit(1)
  if (!worker || !worker.protocolCapabilities.includes(EXPORT_ARTIFACTS_PROTOCOL) || (worker.heartbeatExpiresAt && worker.heartbeatExpiresAt <= new Date())) throw conflict('EXPORT_CLAIM_LOST', '导出节点已失效')
  const report = await getReport(db, job.reportId, job.createdByConsoleAccountId)
  await assertTargetPermission(db, job.createdByConsoleAccountId, report.targetId, 'report:export')
  return job
}

export async function updateExportProgress(db: Db, grant: ExportGrant, progress: string) {
  const { exportJobs } = schemaFor(db)
  await guardExportJob(db, grant)
  await db.update(exportJobs).set({ progress: progress.slice(0, 200), updatedAt: new Date() }).where(grantPredicate(db, grant))
}

export async function insertExportJob(db: Db, input: { kind: 'report_materialize' | 'report_render' | 'report_bundle'; reportId: string; revisionId: string; targetId: string; actorId: string; key: string; manifest: Record<string, JsonValue> }) {
  const { exportJobs } = schemaFor(db)
  const id = newId()
  await db.insert(exportJobs).values({ id, kind: input.kind, reportId: input.reportId, reportRevisionId: input.revisionId, targetId: input.targetId, createdByConsoleAccountId: input.actorId, status: 'queued', sourceManifest: input.manifest, requestDigest: sha256Hex(input.manifest), idempotencyKey: input.key })
  return id
}

export function grantPredicate(db: Db, grant: ExportGrant) {
  const { exportJobs } = schemaFor(db)
  return and(eq(exportJobs.id, grant.jobId), eq(exportJobs.status, 'running'), eq(exportJobs.holderWorkerId, grant.workerId), eq(exportJobs.holderInstanceId, grant.instanceId), eq(exportJobs.claimEpoch, grant.claimEpoch), sql`${exportJobs.leaseUntil} > ${new Date()}`, or(isNull(exportJobs.deadlineAt), sql`${exportJobs.deadlineAt} > ${new Date()}`))
}

export async function renewExportJob(db: Db, grant: ExportGrant) {
  const { exportJobs, workers } = schemaFor(db)
  try {
    await guardExportJob(db, grant)
  } catch { return false }
  const rows = await updateRows(db, exportJobs, { leaseUntil: new Date(Date.now() + 60_000), updatedAt: new Date() }, grantPredicate(db, grant), { id: exportJobs.id })
  return rows.length === 1
}

export async function completeExportJob(
  db: Db,
  input: ExportGrant & {
    artifactIds: string[]
    status: 'complete' | 'partial' | 'failed'
    error?: string
  },
) {
  return atomic(db, async (tx) => {
    const { exportJobs, exportJobArtifacts, artifacts, storedObjects, workers, reportRevisions, reportRevisionOutputs } = schemaFor(tx)
    const [candidate] = await tx.select().from(exportJobs).where(eq(exportJobs.id, input.jobId)).limit(1)
    if (!candidate) return false
    await lockConsoleAuthorization(tx, candidate.createdByConsoleAccountId, false)
    const [job] = await locked(tx, tx.select().from(exportJobs).where(grantPredicate(tx, input)))
    if (!job) return false
    const [worker] = await tx.select().from(workers).where(and(eq(workers.id, input.workerId), eq(workers.instanceId, input.instanceId), eq(workers.status, 'READY'))).limit(1)
    if (!worker) return false
    let status = input.status, error = input.error?.slice(0, 512) ?? null
    let contentCompleteness: string | null = null
    if (status !== 'failed') {
      try {
        if (!job.reportId) throw notFound('REPORT_NOT_FOUND', '报告不存在')
        const report = await getReport(tx, job.reportId, job.createdByConsoleAccountId)
        await assertTargetPermission(tx, job.createdByConsoleAccountId, report.targetId, 'report:export')
      } catch { status = 'failed'; error = '来源已删除或当前授权不允许交付报告' }
    }
    if (status !== 'failed') {
      if (!input.artifactIds.length) throw badRequest('EXPORT_ARTIFACTS_REQUIRED', '导出任务缺少产物')
      const [revision] = await locked(tx, tx.select().from(reportRevisions).where(eq(reportRevisions.id, job.reportRevisionId!)))
      if (!revision?.sealedAt) throw conflict('REPORT_NOT_SEALED', '报告材料尚未封存')
      contentCompleteness = revision.contentCompleteness
      const deliveredFormats = new Set<string>()
      for (const artifactId of new Set(input.artifactIds)) {
        const [artifact] = await tx.select({ id: artifacts.id, kind: artifacts.kind, exportJobId: artifacts.exportJobId, revisionId: artifacts.reportRevisionId, creatorId: artifacts.createdByConsoleAccountId }).from(artifacts).innerJoin(storedObjects, eq(storedObjects.artifactId, artifacts.id))
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.targetId, job.targetId), eq(storedObjects.status, 'available'), isNull(storedObjects.deleteRequestedAt), sql`${storedObjects.retainUntil} > ${new Date()}`, sql`${artifacts.retainUntil} > ${new Date()}`)).limit(1)
        if (!artifact) throw badRequest('EXPORT_ARTIFACT_INVALID', '导出产物不可用或归属不匹配')
        let deliveredId = artifactId
        if (job.kind === 'report_render') {
          const format = artifact.kind === 'report_pdf' ? 'pdf' : artifact.kind === 'report_docx' ? 'docx' : null
          if (!format || !(job.sourceManifest.formats as JsonValue[]).includes(format)) throw badRequest('EXPORT_ARTIFACT_INVALID', '导出格式不属于当前请求')
          if (deliveredFormats.has(format)) throw badRequest('EXPORT_ARTIFACT_INVALID', '同一格式不能交付重复产物')
          deliveredFormats.add(format)
          const [cached] = await tx.select({ output: reportRevisionOutputs, object: storedObjects }).from(reportRevisionOutputs)
            .innerJoin(storedObjects, eq(storedObjects.artifactId, reportRevisionOutputs.artifactId))
            .where(and(eq(reportRevisionOutputs.revisionId, revision.id), eq(reportRevisionOutputs.format, format), eq(reportRevisionOutputs.renderVersion, revision.renderVersion))).limit(1)
          if (cached?.object.status === 'available' && !cached.object.deleteRequestedAt && cached.object.retainUntil > new Date()) deliveredId = cached.output.artifactId
          else {
            if (artifact.exportJobId && (artifact.exportJobId !== job.id || artifact.revisionId !== revision.id)) throw badRequest('EXPORT_ARTIFACT_INVALID', '产物不属于当前任务及修订')
            if (!artifact.exportJobId && artifact.creatorId !== job.createdByConsoleAccountId) throw badRequest('EXPORT_ARTIFACT_INVALID', '产物创建者不匹配')
            if (cached) await tx.update(reportRevisionOutputs).set({ artifactId }).where(eq(reportRevisionOutputs.id, cached.output.id))
            else await tx.insert(reportRevisionOutputs).values({ id: newId(), revisionId: revision.id, format, renderVersion: revision.renderVersion, artifactId })
          }
        } else if (job.kind !== 'report_bundle' || artifact.kind !== 'report_bundle' || artifact.exportJobId !== job.id) throw badRequest('EXPORT_ARTIFACT_INVALID', '产物不是本任务的报告包')
        await tx.insert(exportJobArtifacts).values({ jobId: job.id, artifactId: deliveredId })
      }
      if (job.kind === 'report_render' && status === 'complete' && (job.sourceManifest.formats as string[]).some((format) => !deliveredFormats.has(format))) throw badRequest('EXPORT_ARTIFACTS_REQUIRED', '请求的格式尚未全部交付')
    }
    if (status === 'failed' && job.kind === 'report_materialize' && job.reportRevisionId) await tx.update(reportRevisions).set({ preparationError: error ?? '报告材料准备失败' }).where(and(eq(reportRevisions.id, job.reportRevisionId), isNull(reportRevisions.sealedAt)))
    await tx
      .update(exportJobs)
      .set({
        status,
        error,
        contentCompleteness,
        updatedAt: new Date(),
        leaseUntil: null,
      })
      .where(eq(exportJobs.id, input.jobId))
    await cleanupUnusedJobArtifacts(tx, job.id)
    return true
  })
}

export async function getCachedReportArtifacts(db: Db, revisionId: string, formats: Array<'docx' | 'pdf'>, actorId?: string) {
  const loaded = await loadReportRevisionDocument(db, revisionId, actorId)
  const { reportRevisionOutputs, artifacts, storedObjects } = schemaFor(db)
  const rows = await db.select({ format: reportRevisionOutputs.format, artifact: artifacts, object: storedObjects }).from(reportRevisionOutputs)
    .innerJoin(artifacts, eq(artifacts.id, reportRevisionOutputs.artifactId)).innerJoin(storedObjects, eq(storedObjects.artifactId, artifacts.id))
    .where(and(eq(reportRevisionOutputs.revisionId, revisionId), eq(reportRevisionOutputs.renderVersion, loaded.revision.renderVersion), inArray(reportRevisionOutputs.format, formats)))
  return rows.filter((row) => row.object.status === 'available' && !row.object.deleteRequestedAt && row.object.retainUntil > new Date() && row.artifact.retainUntil > new Date())
}

export async function cleanupUnusedJobArtifacts(db: Db, jobId: string) {
  const { artifacts, storedObjects, reportRevisionMaterials, reportRevisionOutputs, exportJobArtifacts } = schemaFor(db)
  const unused = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.exportJobId, jobId),
    sql`NOT EXISTS (SELECT 1 FROM ${reportRevisionMaterials} m WHERE m.artifact_id = ${artifacts.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${reportRevisionOutputs} o WHERE o.artifact_id = ${artifacts.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${exportJobArtifacts} a WHERE a.artifact_id = ${artifacts.id})`))
  if (unused.length) await db.update(storedObjects).set({ deleteRequestedAt: new Date() }).where(inArray(storedObjects.artifactId, unused.map((row) => row.id)))
}

export async function loadReportRevisionDocument(db: Db, revisionId: string, actorId?: string) {
  const { reportRevisions, reports } = schemaFor(db)
  const [revision] = await db.select().from(reportRevisions).where(eq(reportRevisions.id, revisionId)).limit(1)
  if (!revision) throw notFound('REPORT_NOT_FOUND', '报告修订不存在')
  if (revision.document) {
    reportDocumentSchema.parse(revision.document)
    if (revision.documentDigest && sha256Hex(revision.document) !== revision.documentDigest) throw conflict('REPORT_DOCUMENT_INTEGRITY', '报告封存内容摘要不一致')
  }
  await getReport(db, revision.reportId, actorId)
  const [report] = await db.select().from(reports).where(eq(reports.id, revision.reportId)).limit(1)
  if (!report) throw notFound('REPORT_NOT_FOUND', '报告不存在')
  return { revision, report }
}

export async function cancelExportJob(db: Db, jobId: string, actor: AuditActor) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { exportJobs, reportRevisions } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(exportJobs).where(eq(exportJobs.id, jobId)))
    if (!job) throw notFound('EXPORT_JOB_NOT_FOUND', '导出任务不存在')
    await getReport(tx, job.reportId!, actor.id)
    await assertTargetPermission(tx, actor.id, job.targetId, 'report:export')
    if (['queued', 'running'].includes(job.status)) {
      await tx.update(exportJobs).set({ status: 'cancelled', leaseUntil: null, error: '用户取消导出', updatedAt: new Date() }).where(eq(exportJobs.id, jobId))
      if (job.kind === 'report_materialize') await tx.update(reportRevisions).set({ preparationError: '材料准备已取消，可重试或新建修订' }).where(and(eq(reportRevisions.id, job.reportRevisionId!), isNull(reportRevisions.sealedAt)))
      await cleanupUnusedJobArtifacts(tx, job.id)
      await recordAudit(tx, actor, 'report.export.cancel', 'export_job', jobId, '取消文件任务，保留运行事实')
    }
    return getExportJob(tx, jobId, actor.id)
  })
}

export async function retryExportJob(db: Db, jobId: string, key: string, actor: AuditActor) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { exportJobs, reportRevisions } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(exportJobs).where(eq(exportJobs.id, jobId)))
    if (!job) throw notFound('EXPORT_JOB_NOT_FOUND', '导出任务不存在')
    await getReport(tx, job.reportId!, actor.id)
    await assertTargetPermission(tx, actor.id, job.targetId, 'report:export')
    const digest = sha256Hex({ retryOf: job.id, manifest: job.sourceManifest })
    const [existing] = await tx.select().from(exportJobs).where(and(eq(exportJobs.createdByConsoleAccountId, actor.id), eq(exportJobs.idempotencyKey, key))).limit(1)
    if (existing) {
      if (existing.requestDigest !== digest) throw conflict('EXPORT_IDEMPOTENCY_CONFLICT', '幂等键已用于其他导出请求')
      return getExportJob(tx, existing.id, actor.id)
    }
    if (!['failed', 'cancelled', 'partial'].includes(job.status)) throw conflict('EXPORT_RETRY_NOT_ALLOWED', '当前任务无需重试')
    if (job.retryCount >= REPORT_LIMITS.retries) throw conflict('EXPORT_RETRY_LIMIT', '已达到重试上限，请核对原因后创建新的导出请求')
    const id = newId()
    let sourceManifest = job.sourceManifest
    if (job.kind === 'report_bundle') {
      const entries = []
      for (const entry of job.sourceManifest.entries as Array<{ reportId: string; revisionId: string; name: string }>) {
        const dependency = await enqueueReportExportTx(tx, entry.reportId, entry.revisionId, job.sourceManifest.formats as Array<'docx' | 'pdf'>, actor, `bundle-retry:${sha256Hex({ key, revisionId: entry.revisionId })}`)
        entries.push({ ...entry, jobId: dependency.id })
      }
      sourceManifest = { ...sourceManifest, entries, jobIds: entries.map((entry) => entry.jobId) }
    }
    await tx.insert(exportJobs).values({ id, kind: job.kind, reportId: job.reportId, reportRevisionId: job.reportRevisionId, targetId: job.targetId, createdByConsoleAccountId: actor.id, status: 'queued', sourceManifest, requestDigest: digest, idempotencyKey: key, retryCount: job.retryCount + 1 })
    if (job.kind === 'report_materialize') await tx.update(reportRevisions).set({ preparationError: null }).where(and(eq(reportRevisions.id, job.reportRevisionId!), isNull(reportRevisions.sealedAt)))
    await recordAudit(tx, actor, 'report.export.retry', 'export_job', id, `重试导出任务 ${jobId}`)
    return getExportJob(tx, id, actor.id)
  })
}

export async function deleteReport(db: Db, reportId: string, actor: AuditActor) {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const report = await loadReportDto(tx, reportId)
    await assertTargetPermission(tx, actor.id, report.targetId, 'report:delete')
    await revokeReportTrees(tx, [reportId])
    await recordAudit(tx, actor, 'report.delete', 'report', reportId, '删除报告，撤销其产物访问及待处理导出')
    return { id: reportId, deleted: true }
  })
}

export async function previewDeleteReport(db: Db, reportId: string, actorId: string) {
  const report = await loadReportDto(db, reportId)
  await assertTargetPermission(db, actorId, report.targetId, 'report:delete')
  const { storedObjects } = schemaFor(db)
  const { reportTreeOwnership } = await import('./cleanup.js')
  const { reportIds, artifactIds } = await reportTreeOwnership(db, [reportId])
  const objects = artifactIds.length ? await db.select({ id: storedObjects.id, byteSize: storedObjects.byteSize }).from(storedObjects).where(and(inArray(storedObjects.artifactId, artifactIds), ne(storedObjects.status, 'purged'))) : []
  return { previewToken: newId(), counts: { reports: reportIds.length, storedObjects: objects.length, totalBytes: objects.reduce((sum, object) => sum + (object.byteSize ?? 0), 0), unknownByteObjects: objects.filter((object) => object.byteSize === null).length }, blockers: [] }
}

export { snapshotDeletedBy }
