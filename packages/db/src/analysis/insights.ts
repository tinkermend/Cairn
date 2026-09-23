import {
  type ChangeImpact,
  type KnowledgeInsight,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { notFound } from '../runs/errors.js'
import { getAnalysisJob } from './jobs.js'

export interface JobInsightsSummary {
  jobId: string
  targetId: string
  status: string
  mode: string
  insights: KnowledgeInsight[]
  changeImpacts: ChangeImpact[]
  coverageGaps: string[]
}

export async function getJobInsights(db: Db, jobId: string): Promise<JobInsightsSummary> {
  const job = await getAnalysisJob(db, jobId)
  const result = (job.result ?? {}) as Record<string, unknown>

  // 1. 读取或合成结构化 KnowledgeInsight
  let insights: KnowledgeInsight[] = []
  if (Array.isArray(result.insights)) {
    insights = result.insights as KnowledgeInsight[]
  } else if (job.candidates && job.candidates.length > 0) {
    insights = job.candidates.map((cand) => ({
      insightId: cand.candidateId,
      kind: cand.kind,
      title: cand.title,
      claims: [cand.summary],
      sourceRefs: cand.sources.map((s) => ({
        kind: String(s.kind ?? 'run'),
        id: String(s.runId ?? s.sourceId ?? cand.candidateId),
        revision: s.sourceRevision != null ? String(s.sourceRevision) : undefined,
      })),
      applicability: {
        targetId: job.targetId,
        observedWindow: `seq_${job.afterSeq}_to_${job.throughSeq ?? job.afterSeq}`,
      },
      unknowns: job.coverageGaps,
      suggestedAction: {
        actionType: 'create_knowledge_candidate',
        destination: { candidateKind: cand.kind },
        payload: { candidateId: cand.candidateId },
      },
    }))
  }

  // 2. 读取或合成结构化 ChangeImpact
  let changeImpacts: ChangeImpact[] = []
  if (Array.isArray(result.changeImpacts)) {
    changeImpacts = result.changeImpacts as ChangeImpact[]
  } else if (job.mode === 'map_quality') {
    changeImpacts = [
      {
        impactId: `${job.analysisJobId}-map-impact`,
        fromRef: String(result.publishedReleaseId ?? 'draft'),
        toRef: 'current',
        changedAssets:
          Number(result.staleAssetCountInSample ?? 0) > 0
            ? [
                {
                  assetType: 'page',
                  assetId: 'stale-pages-sample',
                  changeType: 'modified',
                },
              ]
            : [],
        confirmedRefs: [],
        possibleRefs: [],
        scanCoverage: {
          totalScanned: Number(result.inspectedPageCount ?? 0),
          gaps: job.coverageGaps,
        },
      },
    ]
  }

  return {
    jobId: job.analysisJobId,
    targetId: job.targetId,
    status: job.status,
    mode: job.mode,
    insights,
    changeImpacts,
    coverageGaps: job.coverageGaps,
  }
}

export async function getJobInsight(
  db: Db,
  jobId: string,
  insightId: string,
): Promise<KnowledgeInsight> {
  const summary = await getJobInsights(db, jobId)
  const item = summary.insights.find((i) => i.insightId === insightId)
  if (!item) {
    throw notFound('INSIGHT_NOT_FOUND', `分析任务 ${jobId} 中未找到洞察 ${insightId}`)
  }
  return item
}
