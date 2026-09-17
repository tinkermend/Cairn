import { buildProcessLoggerBindings, type LogLevel } from '@cairn/shared'

/** Worker 无 HTTP 入口，只装配与 api 同源的 level / base / redact。 */
export function buildWorkerLoggerOptions(input: { level: LogLevel; workerId: string }) {
  return buildProcessLoggerBindings({
    service: 'cairn-worker',
    level: input.level,
    workerId: input.workerId,
  })
}
