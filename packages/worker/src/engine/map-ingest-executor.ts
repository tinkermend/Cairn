import { commitMapIngestProgress, recordMapIngestSliceResult, type DbHandle } from '@cairn/db'
import type { BrowserPort } from './ports.js'
import type { StepExecutionContext, StepExecutionOutcome, StepExecutor } from './step-executor.js'

export class MapIngestExecutor implements StepExecutor {
  readonly supportedTypes = ['map_ingest'] as const

  constructor(private readonly db: DbHandle, private readonly browser?: BrowserPort) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    if (ctx.step.type !== 'map_ingest') {
      return { kind: 'failed', error: {
        code: 'MAP_INGEST_STEP_INVALID', category: 'VALIDATION', retryable: false,
        safeMessage: '采集步骤类型不匹配',
      } }
    }
    const frozen = ctx.snapshot.mapJob
    if (!frozen || frozen.jobId !== ctx.step.input.jobId || frozen.purpose !== 'map_ingest'
      || frozen.ingest?.accessPolicyRevision !== ctx.snapshot.accessPolicy?.revision) {
      return { kind: 'failed', error: {
        code: 'MAP_INGEST_SNAPSHOT_INVALID', category: 'VALIDATION', retryable: false,
        safeMessage: '采集作业快照与授权不一致',
      } }
    }
    if (!this.browser?.ingestMapSlice || !ctx.sessionGrant || !ctx.snapshot.accessPolicy || !ctx.snapshot.targetAccountId) {
      return { kind: 'failed', error: {
        code: 'MAP_INGEST_BROWSER_UNAVAILABLE', category: 'INFRASTRUCTURE', retryable: true,
        safeMessage: '采集浏览器会话不可用',
      } }
    }
    try {
      const result = await this.browser.ingestMapSlice(ctx.sessionGrant, {
        step: ctx.step.input, targetId: ctx.targetId,
        targetAccountId: ctx.snapshot.targetAccountId,
        accessPolicy: ctx.snapshot.accessPolicy.policy,
        signal: ctx.signal,
        onProgress: async (cursor, page) => {
          await commitMapIngestProgress(this.db, {
            grant: ctx.grant, jobId: frozen.jobId, runId: ctx.runId,
            stepRunId: ctx.stepRunId, attemptId: ctx.attemptId, cursor, page,
          })
        },
      })
      await recordMapIngestSliceResult(this.db, {
        grant: ctx.grant, jobId: frozen.jobId, runId: ctx.runId, cursor: result.cursor,
        nodes: result.nodes, blockedPostPaths: result.blockedPostPaths,
        inferredReadPostPaths: result.inferredReadPostPaths,
        inferredReadPostCount: result.inferredReadPostCount,
        blockedImpactCounts: result.blockedImpactCounts,
        dialogs: result.dialogs, detectedMenus: result.detectedMenus,
      })
      return { kind: 'success', output: {
        nodes: result.nodes.slice(0, 100), cursor: result.cursor,
        nodesTruncated: result.nodes.length > 100,
        blockedPostPaths: result.blockedPostPaths,
        inferredReadPostPaths: result.inferredReadPostPaths,
        inferredReadPostCount: result.inferredReadPostCount,
        blockedReasonCounts: result.blockedReasonCounts,
        blockedImpactCounts: result.blockedImpactCounts,
        blockedRequests: result.blockedRequests,
        dialogs: result.dialogs, dialogRecords: result.dialogRecords,
        detectedMenus: result.detectedMenus,
      } }
    } catch (error) {
      return { kind: ctx.signal.aborted ? 'cancelled' : 'failed', error: {
        code: ctx.signal.aborted ? 'CANCELLED' : 'MAP_INGEST_SLICE_FAILED',
        category: ctx.signal.aborted ? 'CANCELLED' : 'EXECUTOR',
        retryable: !ctx.signal.aborted,
        safeMessage: error instanceof Error ? error.message.slice(0, 256) : '地图采集分片失败',
      } }
    }
  }
}
