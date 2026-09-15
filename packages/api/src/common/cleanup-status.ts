import { HttpStatus } from '@nestjs/common'
import type { CleanupStatusResponse } from '@cairn/shared'

export function cleanupAcceptedStatus(cleanup: CleanupStatusResponse): number {
  return cleanup.totalObjects > 0 && cleanup.status !== 'completed'
    ? HttpStatus.ACCEPTED
    : HttpStatus.OK
}
