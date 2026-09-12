import { Inject, Injectable } from '@nestjs/common'
import {
  settleExpiredPendingEvidence,
  settleFinishedPendingRuns,
  settleRunEvidence,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { OBJECT_SERVICE_OPTIONS, type ObjectServiceOptions } from '../objects/object.service'

/**
 * 证据收尾。只写证据行与 runs.evidence_status，不写执行状态，不需要 RunLease。
 */
@Injectable()
export class EvidenceSettleService {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(OBJECT_SERVICE_OPTIONS) private readonly options: ObjectServiceOptions,
  ) {}

  async settleExpired(): Promise<{ marked: number }> {
    const expired = await settleExpiredPendingEvidence(this.handle.db, this.opts())
    const finished = await settleFinishedPendingRuns(this.handle.db, this.opts())
    return { marked: expired.marked + expired.committed + finished.settled }
  }

  async settleRun(runId: string): Promise<void> {
    await settleRunEvidence(this.handle.db, runId, this.opts())
  }

  private opts() {
    return {
      now: this.options.now?.() ?? new Date(),
      pendingTtlSeconds: this.options.pendingTtlSeconds,
      maxUploadAttempts: this.options.uploadMaxAttempts ?? 3,
    }
  }
}
