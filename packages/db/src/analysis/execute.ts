import { eq } from 'drizzle-orm'
import type { AnalysisJobDto, PlatformAiProvider, PlatformAiThinkingMode, SecretRef } from '@cairn/shared'
import type { Db } from '../client.js'
import { getMapSummary, listMapAssets } from '../map/governance.js'
import { atomic, schemaFor } from '../native.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { getAnalysisJob, heartbeatAnalysisJob, submitAnalysisJob } from './jobs.js'
import { listAnalysisSourcesAfter } from './sources.js'

type Candidate = NonNullable<Parameters<typeof submitAnalysisJob>[1]['candidates']>[number]
export type PreparedAnalysis = {
  throughSeq: number
  result: Record<string, unknown>
  coverageGaps: string[]
  candidates: Candidate[]
  noNewData: boolean
  records: Record<string, unknown>[]
  ai: {
    enabled: boolean
    provider?: PlatformAiProvider
    baseUrl?: string
    model?: string
    secretRef?: SecretRef
    thinkingMode?: PlatformAiThinkingMode
    requestTimeoutMs: number
    maxOutputTokens: number
    maxConcurrentJobs: number
  }
}

/** DB freezes bounded facts. Model calls and lifecycle orchestration belong to
 * the analyst Worker. Retries reuse this input. */
export async function prepareAnalysisJob(db: Db, job: AnalysisJobDto, owner: string): Promise<PreparedAnalysis> {
  return atomic(db, async tx => {
    await heartbeatAnalysisJob(tx, job.analysisJobId, owner, job.fencingToken)
    const { analysisJobs } = schemaFor(tx)
    const current = await getAnalysisJob(tx, job.analysisJobId)
    const [row] = await tx.select().from(analysisJobs).where(eq(analysisJobs.id, job.analysisJobId)).limit(1)
    if (row?.inputSnapshot) return row.inputSnapshot as PreparedAnalysis
    const config = (await getOrCreatePlatformConfig(tx)).document
    const ai = {
      enabled: config.analysisAi.enabled,
      provider: config.platformAi.provider,
      baseUrl: config.platformAi.baseUrl,
      model: config.platformAi.model,
      secretRef: config.platformAi.secretRef,
      thinkingMode: config.platformAi.thinkingMode,
      requestTimeoutMs: config.analysisAi.requestTimeoutMs,
      maxOutputTokens: config.analysisAi.maxOutputTokens,
      maxConcurrentJobs: config.analysisAi.maxConcurrentJobs,
    }
    const prepared = current.mode === 'map_quality'
      ? await prepareMapQuality(tx, current, ai)
      : await prepareIncremental(tx, current, ai)
    await tx.update(analysisJobs).set({ inputSnapshot: prepared }).where(eq(analysisJobs.id, job.analysisJobId))
    return prepared
  })
}

async function prepareMapQuality(db: Db, job: AnalysisJobDto, ai: PreparedAnalysis['ai']): Promise<PreparedAnalysis> {
  const summary = await getMapSummary(db, job.targetId, { limit: 20 })
  const query = { limit: Math.min(job.budget.maxItems, 100), ...(summary.view.viewRef.kind === 'release' ? { releaseId: summary.view.viewRef.releaseId } : {}) }
  const pages = await listMapAssets(db, job.targetId, 'pages', query)
  const after = await getMapSummary(db, job.targetId, { limit: 20 })
  if (JSON.stringify(summary.view) !== JSON.stringify(after.view)) throw new Error('地图视图已变化，请重试')
  const stale = pages.items.filter(item => ['DISCOVERED', 'OBSERVED', 'DEGRADED'].includes(item.lifecycle))
  return {
    ai, throughSeq: job.checkpointSeq, noNewData: false,
    result: { kind: 'map_quality', ...summary, inspectedPageCount: pages.items.length, sampled: Boolean(pages.nextCursor), staleAssetCountInSample: stale.length },
    records: pages.items,
    coverageGaps: [...(!summary.publishedReleaseId ? ['NO_PUBLISHED_MAP'] : []), ...(pages.nextCursor ? ['PAGE_SAMPLE_LIMIT'] : [])],
    candidates: stale.map(item => ({
      kind: 'map_refresh_suggestion', title: `建议复查 ${item.name ?? item.assetRef.pageId}`.slice(0, 200),
      summary: `当前生命周期 ${item.lifecycle}，证据 ${item.evidenceAvailability}。这是已有地图数据的质量检查，尚未执行现场复查。`,
      sources: [{ kind: 'map_asset', targetId: job.targetId, assetRef: item.assetRef, view: pages.view }],
      payload: { lifecycle: item.lifecycle },
    })),
  }
}

async function prepareIncremental(db: Db, job: AnalysisJobDto, ai: PreparedAnalysis['ai']): Promise<PreparedAnalysis> {
  const sources = await listAnalysisSourcesAfter(db, { targetId: job.targetId, afterSeq: job.afterSeq, throughSeq: job.throughSeq ?? job.afterSeq, limit: job.budget.maxItems + 1, source: job.source })
  let selected = sources.slice(0, job.budget.maxItems)
  if (job.budget.useAi) {
    // A conservative UTF-8 byte bound reserves space for the prompt and output.
    // Split before freezing the batch; never advance past unprocessed sources.
    const byteBudget = Math.max(0, (job.budget.maxTokens ?? 32_000) - ai.maxOutputTokens - 2048)
    let bytes = 0
    selected = selected.filter(item => {
      bytes += Buffer.byteLength(JSON.stringify(item.source.snapshot)) + 256
      return bytes <= byteBudget
    })
    if (!selected.length && sources.length) throw new Error('ANALYSIS_BUDGET_EXHAUSTED：单条来源超过输入预算，请提高本批 Token 预算')
  }
  const hasMore = sources.length > selected.length
  const throughSeq = hasMore ? selected.at(-1)!.source.committedSeq : job.throughSeq ?? job.afterSeq
  // Terminal state and subsequently completed evidence may both arrive in this
  // batch. Retain the latest complete snapshot per Run, not duplicate advice.
  const latest = [...new Map(selected.map(item => [item.source.runId ?? item.source.sourceId, item])).values()]
  const records = latest.map(({ source }) => ({ ...source.snapshot, sourceId: source.id, sourceRevision: source.sourceRevision, committedSeq: source.committedSeq }))
  const candidates: Candidate[] = latest.filter(item => item.source.snapshot).map(({ source }) => {
    const fact = source.snapshot!
    const steps = fact.steps as Array<{ stepRunId: string; name: string | null; status: string; error: string | null; output: string | null }>
    const failed = steps.filter(step => step.status === 'FAILED' || step.error)
    const outputs = steps.filter(step => step.output).slice(-3)
    const observation = failed.length
      ? failed.map(step => `${step.name ?? step.stepRunId}：${step.error ?? step.status}`).join('；')
      : outputs.length ? outputs.map(step => `${step.name ?? step.stepRunId}：${step.output}`).join('；') : '没有可提炼的步骤输出，仅记录执行与证据状态。'
    return {
      kind: failed.length ? 'failure_mode' : 'experience',
      title: `${failed.length ? '失败观察' : '运行摘要'} ${source.runId!.slice(-8)}`,
      summary: `执行 ${factLabel(fact.status)}；业务结果 ${factLabel(fact.outcomeStatus)}；证据 ${factLabel(fact.evidenceStatus)}。${observation}`.slice(0, 2000),
      sources: [{ kind: 'run', runId: source.runId, scenarioId: fact.scenarioId, sourceId: source.id, sourceRevision: source.sourceRevision, committedSeq: source.committedSeq }],
      payload: { steps, evidences: fact.evidences },
    }
  })
  return {
    ai, throughSeq, candidates, records, noNewData: !selected.length,
    result: { kind: 'run_incremental', code: selected.length ? 'BATCH_PROCESSED' : 'NO_NEW_DATA', processed: selected.length, uniqueRunCount: latest.length, afterSeq: job.afterSeq, throughSeq, frozenThroughSeq: job.throughSeq, hasMore, analysisMethod: 'deterministic' },
    coverageGaps: [...new Set(selected.flatMap(({ source }) => source.snapshot ? (source.snapshot.coverageGaps as string[] ?? []) : ['MISSING_SOURCE_SNAPSHOT']))],
  }
}

function factLabel(value: unknown) {
  const labels: Record<string, string> = { SUCCEEDED: '成功', FAILED: '失败', CANCELLED: '已取消', PASS: '通过', FAIL: '未通过', WARN: '有警告', UNKNOWN: '未知', NOT_EVALUATED: '未评估', COMPLETE: '完整', INCOMPLETE: '不完整', PENDING: '待补齐' }
  return labels[String(value)] ?? String(value)
}
