import { Inject, Injectable } from '@nestjs/common'
import {
  advanceBatch,
  cancelBatch,
  createBatch,
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
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

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
    // Dispatch initial batch items within sliding window
    await advanceBatch(this.database, detail.id, body.maxConcurrentSessions).catch(() => {})
    return detail
  }

  pause(batchId: string, body: PauseBatchBody, account: RequestAccount) {
    return pauseBatch(this.database, batchId, body.reason, account.id).catch(rethrowDomain)
  }

  async resume(batchId: string, account: RequestAccount) {
    const detail = await resumeBatch(this.database, batchId, account.id).catch(rethrowDomain)
    await advanceBatch(this.database, batchId).catch(() => {})
    return detail
  }

  cancel(batchId: string, body: CancelBatchBody, account: RequestAccount) {
    return cancelBatch(this.database, batchId, body.reason, account.id).catch(rethrowDomain)
  }

  async retryFailed(batchId: string, account: RequestAccount) {
    const detail = await retryFailedBatch(this.database, batchId, account.id).catch(rethrowDomain)
    await advanceBatch(this.database, detail.id).catch(() => {})
    return detail
  }

  export(batchId: string, actorId: string) {
    return exportBatchResults(this.database, batchId, actorId).catch(rethrowDomain)
  }
}
