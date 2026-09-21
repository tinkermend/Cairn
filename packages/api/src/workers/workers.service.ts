import { Inject, Injectable } from '@nestjs/common'
import { getWorkerDetail, listWorkers, type DbHandle } from '@cairn/db'
import {
  canSeeWorkerInternalEndpoint,
  parseWorkerEndpoints,
  type WorkerDetailResponse,
  type WorkerListQuery,
  type WorkerListResponse,
  type WorkerSessionListQuery,
} from '@cairn/shared'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class WorkersService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async list(query: WorkerListQuery, permissions: readonly string[]): Promise<WorkerListResponse> {
    try {
      return await listWorkers(this.handle, query, this.options(permissions))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async get(
    workerId: string,
    query: WorkerSessionListQuery,
    permissions: readonly string[],
  ): Promise<WorkerDetailResponse> {
    try {
      return await getWorkerDetail(this.handle, workerId, query, this.options(permissions))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async disable(workerId: string) {
    try {
      const { disableWorker } = await import('@cairn/db')
      return await disableWorker(this.handle, workerId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async enable(workerId: string) {
    try {
      const { enableWorker } = await import('@cairn/db')
      return await enableWorker(this.handle, workerId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async remove(workerId: string) {
    try {
      const { deregisterWorker } = await import('@cairn/db')
      await deregisterWorker(this.handle, workerId)
      return { ok: true }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async purgeStale() {
    try {
      const { purgeStaleWorkers } = await import('@cairn/db')
      return await purgeStaleWorkers(this.handle)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  private options(permissions: readonly string[]) {
    return {
      envEndpoints: parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS),
      canSeeEndpoint: canSeeWorkerInternalEndpoint(permissions),
    }
  }
}
