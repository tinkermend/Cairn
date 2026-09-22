import { Inject, Injectable } from '@nestjs/common'
import {
  autoMapDataset,
  createDataset,
  getDataset,
  getDatasetRows,
  listDatasets,
  preflightDataset,
  softDeleteDataset,
  type DbHandle,
} from '@cairn/db'
import type {
  AutoMapBody,
  CreateDatasetBody,
  DatasetListQuery,
  DatasetRowsQuery,
  DeleteResourceBody,
  PreflightDatasetBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class DatasetsService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  list(query: DatasetListQuery, actorId: string) {
    return listDatasets(this.database, query, actorId).catch(rethrowDomain)
  }

  get(datasetId: string, actorId: string) {
    return getDataset(this.database, datasetId, actorId).catch(rethrowDomain)
  }

  getRows(datasetId: string, query: DatasetRowsQuery, actorId: string) {
    return getDatasetRows(this.database, datasetId, query, actorId).catch(rethrowDomain)
  }

  create(body: CreateDatasetBody, account: RequestAccount) {
    return createDataset(this.database, body, account.id).catch(rethrowDomain)
  }

  async autoMap(datasetId: string, body: AutoMapBody, actorId: string) {
    const dataset = await this.get(datasetId, actorId)
    if (!dataset) throw new Error('DATASET_NOT_FOUND')
    const binding = autoMapDataset(dataset.columns, body.scenarioInputs)
    return { binding }
  }

  async preflight(datasetId: string, body: PreflightDatasetBody, actorId: string) {
    const rowsRes = await this.getRows(datasetId, { limit: 200 }, actorId)
    const rowsData = rowsRes.items.map((r) => r.rowData)
    const targetRows = body.selectedRowIndices?.length
      ? body.selectedRowIndices.map((idx) => rowsData[idx]).filter((r): r is Record<string, any> => Boolean(r))
      : rowsData
    return preflightDataset(targetRows, body.binding, body.scenarioInputs)
  }

  delete(datasetId: string, _body: DeleteResourceBody, account: RequestAccount) {
    return softDeleteDataset(this.database, datasetId, account.id).catch(rethrowDomain)
  }
}
