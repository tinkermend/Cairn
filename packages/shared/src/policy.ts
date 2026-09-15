import type { ExecutionPolicy } from './step.js'

export const DEFAULT_STEP_TIMEOUT_MS = 30_000
export const DEFAULT_RETRY_LIMIT = 0

export const DEFAULT_EXECUTOR_VERSIONS = {
  echo: '1',
  delay: '1',
  fail: '1',
  navigate: '1',
  click: '1',
  fill: '1',
  extract: '1',
  assert: '1',
  select: '1',
  keyboard: '1',
  wait: '1',
  ai_action: '1',
  ai_extract: '1',
  ai_assert: '1',
} as const
export type DefaultExecutorVersions = typeof DEFAULT_EXECUTOR_VERSIONS

/** 只冻结该 Snapshot 步骤实际用到的 executor。没用到的键不影响历史 Run。 */
export function freezeExecutorVersions(usedTypes: readonly string[]): Record<string, string> {
  const versions: Record<string, string> = {}
  for (const type of usedTypes) {
    const version = DEFAULT_EXECUTOR_VERSIONS[type as keyof DefaultExecutorVersions]
    if (version) versions[type] = version
  }
  return versions
}

/**
 * 校验该 Snapshot 用到的 executor 版本。
 * 未传入 usedTypes 时，只核对本对象自己声明的键（给存量夹具快照用）。
 */
export function executorVersionsMatch(
  versions: Record<string, string> | undefined,
  usedTypes: readonly string[] = [],
): boolean {
  if (!versions) return false
  const keys = usedTypes.length > 0 ? usedTypes : Object.keys(versions)
  return keys.every((type) => {
    const expected = DEFAULT_EXECUTOR_VERSIONS[type as keyof DefaultExecutorVersions]
    if (!expected) return true
    return versions[type] === expected
  })
}

export function resolveStepPolicy(
  snapshotPolicy?: ExecutionPolicy,
  stepPolicy?: ExecutionPolicy,
  stepType?: string,
): { timeoutMs: number; retryLimit: number } {
  return {
    timeoutMs: stepPolicy?.timeoutMs ?? snapshotPolicy?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    retryLimit:
      stepType === 'ai_action' || stepType === 'wait'
        ? 0
        : (stepPolicy?.retryLimit ?? snapshotPolicy?.retryLimit ?? DEFAULT_RETRY_LIMIT),
  }
}
