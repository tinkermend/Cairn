import {
  advanceBatch,
  completeMapJobSlice,
  loadRunDetail,
  loadRunRow,
  onRunSettledForBatch,
  projectModuleInvocationResults,
  settleRunEvidence,
  settleRunOutcome,
  type DbHandle,
} from '@cairn/db'
import {
  isHaltedRunStatus,
  isMapJobRun,
  type BatchFailureDomain,
  type RunGrant,
  type RunStatus,
} from '@cairn/shared'
import { config } from '../config/env.js'
import type { ExecutionEngine } from './engine.js'

export type RunRow = Awaited<ReturnType<typeof loadRunRow>>

export type RunSettler = {
  readonly name: string
  /** row 为 undefined 表示 Run 行读取失败；证据收尾在此情况下仍须执行。 */
  applies(row: RunRow | undefined): boolean
  settle(db: DbHandle, runId: string, row: RunRow | undefined): Promise<void>
}

const SETTLER_WARN: Record<string, string> = {
  evidence: '证据收尾失败',
  mapJob: '地图作业分片收尾失败',
  moduleResults: '模块调用结果投影失败',
  outcomeResults: '结果轴收尾聚合失败',
  batchItem: '批量任务项状态收尾失败',
}

function mapJobOutcome(status: RunStatus): 'completed' | 'cancelled' | 'failed' | null {
  if (status === 'SUCCEEDED') return 'completed'
  if (status === 'CANCELLED') return 'cancelled'
  if (status === 'FAILED' || status === 'NEEDS_REVIEW') return 'failed'
  return null
}

export const RUN_SETTLERS: readonly RunSettler[] = [
  {
    name: 'evidence',
    applies: () => true,
    async settle(db, runId) {
      await settleRunEvidence(db, runId, {
        pendingTtlSeconds: config.CAIRN_OBJECT_PENDING_TTL_SECONDS,
        maxUploadAttempts: config.CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS,
      })
    },
  },
  {
    name: 'mapJob',
    applies(row) {
      return Boolean(row && isMapJobRun(row.snapshot) && mapJobOutcome(row.status))
    },
    async settle(db, runId, row) {
      const outcome = row ? mapJobOutcome(row.status) : null
      if (!outcome) return
      await completeMapJobSlice(db, runId, outcome)
    },
  },
  {
    name: 'moduleResults',
    applies(row) {
      return Boolean(row && isHaltedRunStatus(row.status) && row.snapshot.moduleManifest?.entries.length)
    },
    async settle(db, runId) {
      await projectModuleInvocationResults(db, runId)
    },
  },
  {
    name: 'outcomeResults',
    applies(row) {
      return Boolean(
        row &&
          isHaltedRunStatus(row.status) &&
          (row.snapshot.outcomeManifest?.entries.length ||
            row.snapshot.runtimeInvariantManifest?.entries.length),
      )
    },
    async settle(db, runId, row) {
      await settleRunOutcome(db, runId, row)
    },
  },
  {
    name: 'batchItem',
    applies(row) {
      return Boolean(row && isHaltedRunStatus(row.status) && row.executionOrigin === 'batch_item')
    },
    async settle(db, runId, row) {
      if (!row) return
      let status: 'passed' | 'failed' | 'review' | 'cancelled' = 'passed'
      if (row.status === 'SUCCEEDED') status = 'passed'
      else if (row.status === 'FAILED') status = 'failed'
      else if (row.status === 'NEEDS_REVIEW') status = 'review'
      else if (row.status === 'CANCELLED') status = 'cancelled'

      let failureDomain: BatchFailureDomain | undefined = undefined
      let errorMessage: string | undefined = undefined

      if (row.status === 'FAILED' || row.status === 'NEEDS_REVIEW') {
        const detail = await loadRunDetail(db, runId).catch(() => null)
        if (detail) {
          const failedAttempt = detail.stepRuns
            .flatMap((s) => s.attempts)
            .reverse()
            .find((a) => a.status === 'FAILED')
          if (failedAttempt?.error) {
            errorMessage = failedAttempt.error.safeMessage || failedAttempt.error.cause?.message || failedAttempt.error.code
            const code = failedAttempt.error.code ?? ''
            const msg = failedAttempt.error.safeMessage ?? failedAttempt.error.cause?.message ?? ''
            if (
              code.includes('SESSION') ||
              code.includes('LEASE') ||
              code.includes('BROWSER')
            ) {
              failureDomain = 'SESSION'
            } else if (
              code.includes('TARGET') ||
              code.includes('GATEWAY') ||
              code.includes('HTTP_5') ||
              code.includes('LOCATOR_TIMEOUT') ||
              msg.includes('500') ||
              msg.includes('502') ||
              msg.includes('503') ||
              msg.includes('504') ||
              msg.includes('熔断')
            ) {
              failureDomain = 'TARGET'
            } else {
              failureDomain = 'ITEM'
            }
          }
        }
      }

      const settled = await onRunSettledForBatch(db, runId, {
        status,
        outcomeVerdict: row.outcomeStatus,
        failureDomain,
        errorMessage,
      })

      if (settled?.batchStatus === 'RUNNING') {
        await advanceBatch(db, settled.batchId).catch(() => {})
      }
    },
  },
]

/** 会话释放之后读一次 Run 行，供三项收尾共用。 */
export async function settleRun(
  this: ExecutionEngine,
  db: DbHandle,
  runId: string,
  grant: RunGrant,
): Promise<void> {
  const row = await loadRunRow(db, runId).catch(() => undefined)
  for (const settler of RUN_SETTLERS) {
    if (!settler.applies(row)) continue
    try {
      await settler.settle(db, runId, row)
    } catch (error: unknown) {
      this.emitProcess('warn', SETTLER_WARN[settler.name] ?? `${settler.name} 收尾失败`, {
        runId,
        workerId: grant.holderWorkerId,
        leaseId: grant.leaseId,
        settler: settler.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
