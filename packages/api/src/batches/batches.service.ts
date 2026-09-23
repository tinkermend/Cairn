import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  cancelBatch,
  createBatch,
  dispatchBatch,
  exportBatchResults,
  getBatch,
  getBatchItems,
  listBatches,
  pauseBatch,
  resumeBatch,
  retryFailedBatch,
  type DbHandle,
} from '@cairn/db'
import type {
  BatchItemListQuery,
  BatchListQuery,
  CancelBatchBody,
  CreateBatchBody,
  PauseBatchBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name)

  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private async dispatch(batchId: string, concurrency?: number) {
    const outcome = await dispatchBatch(this.database, batchId, concurrency).catch(rethrowDomain)
    if (!outcome.ok && outcome.deterministic) rethrowDomain(outcome.error)
    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      this.logger.warn(`批次 ${batchId} 派发未完成，等待维护扫描重试：${message}`)
    }
  }

  list(query: BatchListQuery, actorId: string) {
    return listBatches(this.database, query, actorId).catch(rethrowDomain)
  }

  get(batchId: string, actorId: string) {
    return getBatch(this.database, batchId, actorId).catch(rethrowDomain)
  }

  getItems(batchId: string, query: BatchItemListQuery, actorId: string) {
    return getBatchItems(this.database, batchId, query, actorId).catch(rethrowDomain)
  }

  async create(body: CreateBatchBody, account: RequestAccount) {
    const detail = await createBatch(this.database, body, account.id).catch(rethrowDomain)
    await this.dispatch(detail.id, body.maxConcurrentSessions)
    return (await getBatch(this.database, detail.id, account.id).catch(() => null)) ?? detail
  }

  pause(batchId: string, body: PauseBatchBody, account: RequestAccount) {
    return pauseBatch(this.database, batchId, body.reason, account.id).catch(rethrowDomain)
  }

  async resume(batchId: string, account: RequestAccount) {
    const detail = await resumeBatch(this.database, batchId, account.id).catch(rethrowDomain)
    await this.dispatch(batchId)
    return (await getBatch(this.database, batchId, account.id).catch(() => null)) ?? detail
  }

  cancel(batchId: string, body: CancelBatchBody, account: RequestAccount) {
    return cancelBatch(this.database, batchId, body.reason, account.id).catch(rethrowDomain)
  }

  async retryFailed(batchId: string, account: RequestAccount) {
    const detail = await retryFailedBatch(this.database, batchId, account.id).catch(rethrowDomain)
    await this.dispatch(detail.id)
    return (await getBatch(this.database, detail.id, account.id).catch(() => null)) ?? detail
  }

  export(batchId: string, actorId: string) {
    return exportBatchResults(this.database, batchId, actorId).catch(rethrowDomain)
  }
}
