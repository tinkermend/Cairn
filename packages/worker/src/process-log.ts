import type { Logger } from '@nestjs/common'
import { bindLogFields, type ProcessLogEvent } from '@cairn/shared'

export function emitProcessLog(
  logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>,
  level: 'log' | 'warn' | 'error' | 'debug',
  event: ProcessLogEvent | string,
  fields: Record<string, unknown>,
): void {
  logger[level](bindLogFields(fields), event)
}
