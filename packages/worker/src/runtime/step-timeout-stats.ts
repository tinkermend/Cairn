/**
 * 进程内累计计数：步骤硬超时（engine-attempt.ts 的 runExecutor 判定 timedOut）。
 * 与 host-pool.ts 的 hostLostCount 同一种"进程存活期内单调递增、随心跳持久化"的口径，
 * Worker 重启后归零，不是全历史累计。
 */

let stepHardTimeoutCount = 0

export function recordStepHardTimeout(): void {
  stepHardTimeoutCount += 1
}

export function getStepHardTimeoutCount(): number {
  return stepHardTimeoutCount
}
