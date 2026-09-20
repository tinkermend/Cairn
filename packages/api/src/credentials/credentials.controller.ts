import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  credentialBatchCreateBodySchema,
  credentialBatchItemSubmitBodySchema,
  credentialHistoryQuerySchema,
  credentialListQuerySchema,
  credentialMetadataBodySchema,
  credentialRegisterBodySchema,
  credentialReplaceBodySchema,
  credentialRevisionBodySchema,
  credentialImportResolveBodySchema,
  type CredentialImportResolveBody,
  type CredentialBatchCreateBody,
  type CredentialBatchItemSubmitBody,
  type CredentialHistoryQuery,
  type CredentialListQuery,
  type CredentialMetadataBody,
  type CredentialRegisterBody,
  type CredentialReplaceBody,
  type CredentialRevisionBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { CredentialsService } from './credentials.service'
import { RequirePermissions } from '../rbac/require-permission.decorator'

@Controller('credentials')
@RequirePermissions('credential:read', 'target:read')
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(credentialListQuerySchema)) query: CredentialListQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.list(query, account)
  }

  @Post()
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  register(
    @Body(new ZodValidationPipe(credentialRegisterBodySchema)) body: CredentialRegisterBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.register(body, account)
  }

  @Post('batches')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  createBatch(
    @Body(new ZodValidationPipe(credentialBatchCreateBodySchema)) body: CredentialBatchCreateBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.createBatch(body, account)
  }

  @Post('import/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('credential:read', 'credential:write', 'credential:import', 'target:read')
  resolve(@Body(new ZodValidationPipe(credentialImportResolveBodySchema)) body: CredentialImportResolveBody,
    @CurrentAccount() account: RequestAccount) {
    return this.credentials.resolve(body, account)
  }

  @Get(':credentialId/owners')
  owners(@Param('credentialId') id: string, @CurrentAccount() account: RequestAccount) {
    return this.credentials.owners(id, account)
  }

  @Get('batches/:batchId')
  getBatch(@Param('batchId') batchId: string, @CurrentAccount() account: RequestAccount) {
    return this.credentials.getBatch(batchId, account)
  }

  @Post('batches/:batchId/items/:itemId')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  submitBatchItem(
    @Param('batchId') batchId: string,
    @Param('itemId') itemId: string,
    @Body(new ZodValidationPipe(credentialBatchItemSubmitBodySchema)) body: CredentialBatchItemSubmitBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.submitBatchItem(batchId, itemId, body, account)
  }

  @Get(':credentialId')
  get(@Param('credentialId') credentialId: string, @CurrentAccount() account: RequestAccount) {
    return this.credentials.get(credentialId, account)
  }

  @Get(':credentialId/usages')
  usages(@Param('credentialId') credentialId: string, @CurrentAccount() account: RequestAccount) {
    return this.credentials.usages(credentialId, account)
  }

  @Get(':credentialId/history')
  history(
    @Param('credentialId') credentialId: string,
    @Query(new ZodValidationPipe(credentialHistoryQuerySchema)) query: CredentialHistoryQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.history(credentialId, query, account)
  }

  @Post(':credentialId/metadata')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  metadata(
    @Param('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(credentialMetadataBodySchema)) body: CredentialMetadataBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.metadata(credentialId, body, account)
  }

  @Post(':credentialId/replace')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  replace(
    @Param('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(credentialReplaceBodySchema)) body: CredentialReplaceBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.replace(credentialId, body, account)
  }

  @Post(':credentialId/disable')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  disable(
    @Param('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(credentialRevisionBodySchema)) body: CredentialRevisionBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.disable(credentialId, body, account)
  }

  @Post(':credentialId/clear')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  clear(@Param('credentialId') id: string,
    @Body(new ZodValidationPipe(credentialRevisionBodySchema)) body: CredentialRevisionBody,
    @CurrentAccount() account: RequestAccount) {
    return this.credentials.clear(id, body, account)
  }

  @Post(':credentialId/delete')
  @RequirePermissions('credential:read', 'credential:write', 'credential:delete', 'target:read')
  @HttpCode(HttpStatus.OK)
  remove(@Param('credentialId') id: string,
    @Body(new ZodValidationPipe(credentialRevisionBodySchema)) body: CredentialRevisionBody,
    @CurrentAccount() account: RequestAccount) {
    return this.credentials.clear(id, body, account, true)
  }

  @Post(':credentialId/enable')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  enable(
    @Param('credentialId') credentialId: string,
    @Body(new ZodValidationPipe(credentialRevisionBodySchema)) body: CredentialRevisionBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.enable(credentialId, body, account)
  }

  @Post(':credentialId/versions/:versionId/revoke')
  @RequirePermissions('credential:read', 'credential:write', 'target:read')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param('credentialId') credentialId: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(credentialRevisionBodySchema)) body: CredentialRevisionBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.credentials.revoke(credentialId, versionId, body, account)
  }
}
