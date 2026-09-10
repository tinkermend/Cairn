import { jsonValueSchema, type ExecutionError, type FailInput, type JsonValue } from '@cairn/shared'
import { type EngineClock } from './clock.js'

export function executeEcho(value: JsonValue): JsonValue {
  return jsonValueSchema.parse(value)
}

export async function executeDelay(
  durationMs: number,
  signal: AbortSignal,
  clock: EngineClock,
): Promise<{ waitedMs: number }> {
  const started = clock.now()
  await clock.sleep(durationMs, signal)
  return { waitedMs: clock.now() - started }
}

export function executeFail(input: FailInput): ExecutionError {
  return {
    code: input.code ?? 'FAIL',
    category: input.category ?? 'EXECUTOR',
    retryable: input.retryable ?? true,
    safeMessage: input.message,
  }
}
