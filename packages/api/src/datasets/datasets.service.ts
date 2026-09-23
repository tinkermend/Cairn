import { Inject, Injectable } from '@nestjs/common'
import {
  autoMapDataset,
  createDataset,
  getDataset,
  getDatasetRows,
  getDatasetRowsForPreflight,
  listDatasets,
  preflightDataset,
  softDeleteDataset,
  type DbHandle,
} from '@cairn/db'
import {
  type AutoMapBody,
  type CreateDatasetBody,
  type DatasetListQuery,
  type DatasetRowsQuery,
  type PreflightDatasetBody,
  SYNC_PREFLIGHT_MAX_ROWS,
} from '@cairn/shared'
import { computeDatasetProfile } from '@cairn/authoring'
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
    const dataset = await this.get(datasetId, actorId)
    if (!dataset) throw new Error('DATASET_NOT_FOUND')

    const selectedIndices = body.selectedRowIndices
    const chunkSize = 500
    const allRows: { rowIndex: number; rowData: Record<string, any> }[] = []

    if (selectedIndices && selectedIndices.length > 0) {
      for (let i = 0; i < selectedIndices.length; i += chunkSize) {
        const chunk = selectedIndices.slice(i, i + chunkSize)
        const rows = await getDatasetRowsForPreflight(
          this.database,
          datasetId,
          { selectedRowIndices: chunk },
          actorId,
        )
        allRows.push(...rows)
      }
    } else {
      const limit = Math.min(dataset.rowCount, SYNC_PREFLIGHT_MAX_ROWS)
      for (let offset = 0; offset < limit; offset += chunkSize) {
        const rows = await getDatasetRowsForPreflight(
          this.database,
          datasetId,
          { limit: Math.min(chunkSize, limit - offset), offset },
          actorId,
        )
        allRows.push(...rows)
        if (rows.length < chunkSize) break
      }
    }

    return preflightDataset(allRows, body.binding, body.scenarioInputs)
  }

  async profile(datasetId: string, actorId: string) {
    const dataset = await this.get(datasetId, actorId)
    if (!dataset) throw new Error('DATASET_NOT_FOUND')

    const rows = await getDatasetRowsForPreflight(
      this.database,
      datasetId,
      { limit: 5000, offset: 0 },
      actorId,
    )

    return computeDatasetProfile({
      datasetId,
      rows: rows.map((r) => r.rowData),
      columns: dataset.columns.map((c) => c.name),
    })
  }

  delete(datasetId: string, account: RequestAccount) {
    return softDeleteDataset(this.database, datasetId, account.id).catch(rethrowDomain)
  }
}
