import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  batchItemListQuerySchema,
  batchListQuerySchema,
  cancelBatchBodySchema,
  createBatchBodySchema,
  pauseBatchBodySchema,
  type BatchItemListQuery,
  type BatchListQuery,
  type CancelBatchBody,
  type CreateBatchBody,
  type PauseBatchBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { BatchesService } from './batches.service'

@Controller('batches')
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Get()
  @RequirePermissions('batch:read')
  list(
    @Query(new ZodValidationPipe(batchListQuerySchema)) query: BatchListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.batches.list(query, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:write')
  create(
    @Body(new ZodValidationPipe(createBatchBodySchema)) body: CreateBatchBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.batches.create(body, account)
  }

  @Get(':batchId')
  @RequirePermissions('batch:read')
  get(@Param('batchId') batchId: string, @CurrentAccount() account: RequestAccount) {
    return this.batches.get(batchId, account.id)
  }

  @Get(':batchId/items')
  @RequirePermissions('batch:read')
  items(
    @Param('batchId') batchId: string,
    @Query(new ZodValidationPipe(batchItemListQuerySchema)) query: BatchItemListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.batches.getItems(batchId, query, account.id)
  }

  @Post(':batchId/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:execute')
  pause(
    @Param('batchId') batchId: string,
    @Body(new ZodValidationPipe(pauseBatchBodySchema)) body: PauseBatchBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.batches.pause(batchId, body, account)
  }

  @Post(':batchId/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:execute')
  resume(@Param('batchId') batchId: string, @CurrentAccount() account: RequestAccount) {
    return this.batches.resume(batchId, account)
  }

  @Post(':batchId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:execute')
  cancel(
    @Param('batchId') batchId: string,
    @Body(new ZodValidationPipe(cancelBatchBodySchema)) body: CancelBatchBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.batches.cancel(batchId, body, account)
  }

  @Post(':batchId/retry-failed')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:execute')
  retryFailed(@Param('batchId') batchId: string, @CurrentAccount() account: RequestAccount) {
    return this.batches.retryFailed(batchId, account)
  }

  @Post(':batchId/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('batch:read')
  export(@Param('batchId') batchId: string, @CurrentAccount() account: RequestAccount) {
    return this.batches.export(batchId, account.id)
  }
}
