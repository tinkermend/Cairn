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

  private options(permissions: readonly string[]) {
    return {
      networkMode: config.CAIRN_WORKER_NETWORK_MODE,
      envEndpoints: parseWorkerEndpoints(config.CAIRN_WORKER_ENDPOINTS, {
        networkMode: config.CAIRN_WORKER_NETWORK_MODE,
      }),
      canSeeEndpoint: canSeeWorkerInternalEndpoint(permissions),
    }
  }
}
