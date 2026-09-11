import { yieldClaimedRun, type Db, type YieldClaimResult } from '@cairn/db'
import type { RunGrant } from '@cairn/shared'

/** 回交后的进程内冷却。不是事实源：重启即失效，不跨 Worker。 */
export const PLACEMENT_YIELD_BACKOFF_MS = 10_000

const untilByRunId = new Map<string, number>()

export function rememberPlacementYield(runId: string, now = Date.now()): void {
  untilByRunId.set(runId, now + PLACEMENT_YIELD_BACKOFF_MS)
}

/**
 * 占不到会话时的生产回交入口：库回交成功后才记本进程冷却。
 * `has_attempts` / `unknown` 不改冷却表。停机仍走 `yieldUnfinishedRun`。
 */
export async function yieldPlacement(db: Db, grant: RunGrant): Promise<YieldClaimResult> {
  const result = await yieldClaimedRun(db, grant, 'placement_yield')
  if (result === 'yielded') rememberPlacementYield(grant.runId)
  return result
}

export function placementYieldExcludes(now = Date.now()): string[] {
  const active: string[] = []
  for (const [runId, until] of untilByRunId) {
    if (until > now) active.push(runId)
    else untilByRunId.delete(runId)
  }
  return active
}

export function clearPlacementYields(): void {
  untilByRunId.clear()
}
