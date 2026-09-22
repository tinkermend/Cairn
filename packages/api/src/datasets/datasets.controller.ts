import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  autoMapBodySchema,
  createDatasetBodySchema,
  datasetListQuerySchema,
  datasetRowsQuerySchema,
  deleteResourceBodySchema,
  preflightDatasetBodySchema,
  type AutoMapBody,
  type CreateDatasetBody,
  type DatasetListQuery,
  type DatasetRowsQuery,
  type DeleteResourceBody,
  type PreflightDatasetBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { DatasetsService } from './datasets.service'

@Controller('datasets')
export class DatasetsController {
  constructor(private readonly datasets: DatasetsService) {}

  @Get()
  @RequirePermissions('dataset:read')
  list(
    @Query(new ZodValidationPipe(datasetListQuerySchema)) query: DatasetListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.list(query, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('dataset:write')
  create(
    @Body(new ZodValidationPipe(createDatasetBodySchema)) body: CreateDatasetBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.create(body, account)
  }

  @Post('upload')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('dataset:write')
  upload(
    @Body(new ZodValidationPipe(createDatasetBodySchema)) body: CreateDatasetBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.create(body, account)
  }

  @Get(':datasetId')
  @RequirePermissions('dataset:read')
  get(@Param('datasetId') datasetId: string, @CurrentAccount() account: RequestAccount) {
    return this.datasets.get(datasetId, account.id)
  }

  @Get(':datasetId/rows')
  @RequirePermissions('dataset:read')
  rows(
    @Param('datasetId') datasetId: string,
    @Query(new ZodValidationPipe(datasetRowsQuerySchema)) query: DatasetRowsQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.getRows(datasetId, query, account.id)
  }

  @Post(':datasetId/auto-map')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('dataset:read')
  autoMap(
    @Param('datasetId') datasetId: string,
    @Body(new ZodValidationPipe(autoMapBodySchema)) body: AutoMapBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.autoMap(datasetId, body, account.id)
  }

  @Post(':datasetId/preflight')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('dataset:read')
  preflight(
    @Param('datasetId') datasetId: string,
    @Body(new ZodValidationPipe(preflightDatasetBodySchema)) body: PreflightDatasetBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.preflight(datasetId, body, account.id)
  }

  @Post(':datasetId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('dataset:delete')
  delete(
    @Param('datasetId') datasetId: string,
    @Body(new ZodValidationPipe(deleteResourceBodySchema)) body: DeleteResourceBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.datasets.delete(datasetId, body, account)
  }
}
