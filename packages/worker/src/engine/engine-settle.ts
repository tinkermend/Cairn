import {
  completeMapJobSlice,
  loadRunRow,
  projectModuleInvocationResults,
  settleRunEvidence,
  settleRunOutcome,
  type DbHandle,
} from '@cairn/db'
import { isHaltedRunStatus, isMapJobRun, type RunGrant, type RunStatus } from '@cairn/shared'
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
      return Boolean(row && isHaltedRunStatus(row.status) && row.snapshot.outcomeManifest?.entries.length)
    },
    async settle(db, runId, row) {
      await settleRunOutcome(db, runId, row)
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
