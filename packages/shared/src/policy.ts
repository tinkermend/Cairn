import type { ExecutionPolicy } from './step.js'

export const DEFAULT_STEP_TIMEOUT_MS = 30_000
export const DEFAULT_RETRY_LIMIT = 0

export const DEFAULT_EXECUTOR_VERSIONS = {
  echo: '1',
  delay: '1',
  fail: '1',
} as const
export type DefaultExecutorVersions = typeof DEFAULT_EXECUTOR_VERSIONS

export function resolveStepPolicy(
  snapshotPolicy?: ExecutionPolicy,
  stepPolicy?: ExecutionPolicy,
): { timeoutMs: number; retryLimit: number } {
  return {
    timeoutMs: stepPolicy?.timeoutMs ?? snapshotPolicy?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    retryLimit: stepPolicy?.retryLimit ?? snapshotPolicy?.retryLimit ?? DEFAULT_RETRY_LIMIT,
  }
}
