import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { cleanupAcceptedStatus } from '../common/cleanup-status'
import {
  createTargetAccountBodySchema,
  createTargetBodySchema,
  deleteResourceBodySchema,
  targetAccountListQuerySchema,
  targetListQuerySchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type DeleteResourceBody,
  type TargetAccountListQuery,
  type TargetListQuery,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { TargetsService } from './targets.service'

@Controller('targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  @RequirePermissions('target:read')
  listTargets(@Query(new ZodValidationPipe(targetListQuerySchema)) query: TargetListQuery) {
    return this.targets.listTargets(query)
  }

  @Post()
  @RequirePermissions('target:write')
  createTarget(
    @Body(new ZodValidationPipe(createTargetBodySchema)) body: CreateTargetBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.createTarget(body, actor)
  }

  @Get(':targetId')
  @RequirePermissions('target:read')
  getTarget(@Param('targetId') targetId: string) {
    return this.targets.getTarget(targetId)
  }

  @Post(':targetId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  updateTarget(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(updateTargetBodySchema)) body: UpdateTargetBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.updateTarget(targetId, body, actor)
  }

  @Get(':targetId/delete-preview')
  @RequirePermissions('target:delete')
  previewDeleteTarget(@Param('targetId') targetId: string) {
    return this.targets.previewDeleteTarget(targetId)
  }

  @Post(':targetId/delete')
  @RequirePermissions('target:delete', 'run:delete')
  async deleteTarget(
    @Param('targetId') targetId: string,
    @CurrentAccount() actor: RequestAccount,
    @Body(new ZodValidationPipe(deleteResourceBodySchema.optional())) body: DeleteResourceBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cleanup = await this.targets.deleteTarget(targetId, actor, body)
    res.status(cleanupAcceptedStatus(cleanup))
    return cleanup
  }

  @Get(':targetId/cleanup')
  @RequirePermissions('target:read')
  getTargetCleanupStatus(@Param('targetId') targetId: string) {
    return this.targets.getTargetCleanupStatus(targetId)
  }

  @Post(':targetId/cleanup/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:delete')
  retryTargetCleanup(
    @Param('targetId') targetId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.retryTargetCleanup(targetId, actor)
  }

  @Get(':targetId/accounts')
  @RequirePermissions('target:read')
  listAccounts(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(targetAccountListQuerySchema)) query: TargetAccountListQuery,
  ) {
    return this.targets.listAccounts(targetId, query)
  }

  @Post(':targetId/accounts')
  @RequirePermissions('target:write')
  createAccount(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(createTargetAccountBodySchema)) body: CreateTargetAccountBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.createAccount(targetId, body, actor)
  }

  @Post(':targetId/accounts/:accountId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  updateAccount(
    @Param('targetId') targetId: string,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(updateTargetAccountBodySchema)) body: UpdateTargetAccountBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.updateAccount(targetId, accountId, body, actor)
  }

  @Post(':targetId/accounts/:accountId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:delete')
  deleteAccount(
    @Param('targetId') targetId: string,
    @Param('accountId') accountId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.deleteAccount(targetId, accountId, actor)
  }
}
