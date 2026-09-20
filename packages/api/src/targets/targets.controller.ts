import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { cleanupAcceptedStatus } from '../common/cleanup-status'
import {
  createTargetAccountBodySchema,
  createTargetBodySchema,
  deleteResourceBodySchema,
  observeAuthProfileValidationBodySchema,
  publishTargetAuthProfileBodySchema,
  startAuthProfileValidationBodySchema,
  updateTargetAccountIdentityBodySchema,
  targetAccessPolicyUpdateBodySchema,
  targetAccountListQuerySchema,
  targetListQuerySchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
  targetSessionPolicyPatchSchema,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type ObserveAuthProfileValidationBody,
  type PublishTargetAuthProfileBody,
  type StartAuthProfileValidationBody,
  type UpdateTargetAccountIdentityBody,
  type TargetAccessPolicyUpdateBody,
  type DeleteResourceBody,
  type TargetAccountListQuery,
  type TargetListQuery,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
  type TargetSessionPolicyPatch,
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
  listTargets(@Query(new ZodValidationPipe(targetListQuerySchema)) query: TargetListQuery, @CurrentAccount() actor: RequestAccount) {
    return this.targets.listTargets(query, actor)
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

  @Get(':targetId/access-policy')
  @RequirePermissions('target:read', 'map:read')
  getAccessPolicy(@Param('targetId') targetId: string) {
    return this.targets.getAccessPolicy(targetId)
  }

  @Post(':targetId/access-policy')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  updateAccessPolicy(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(targetAccessPolicyUpdateBodySchema)) body: TargetAccessPolicyUpdateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.updateAccessPolicy(targetId, body, actor)
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

  @Post(':targetId/session-policy')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  updateSessionPolicy(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(targetSessionPolicyPatchSchema)) body: TargetSessionPolicyPatch,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.updateSessionPolicy(targetId, body, actor)
  }

  @Get(':targetId/auth-profile')
  @RequirePermissions('target:read')
  getAuthProfile(@Param('targetId') targetId: string) {
    return this.targets.getAuthProfile(targetId)
  }

  @Post(':targetId/auth-profile')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  publishAuthProfile(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(publishTargetAuthProfileBodySchema)) body: PublishTargetAuthProfileBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.publishAuthProfile(targetId, body, actor)
  }

  @Post(':targetId/auth-profile/validations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('target:write')
  startAuthValidation(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(startAuthProfileValidationBodySchema)) body: StartAuthProfileValidationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.startAuthValidation(targetId, body, actor)
  }

  @Get(':targetId/auth-profile/validations/:operationId')
  @RequirePermissions('target:read')
  getAuthValidation(
    @Param('targetId') targetId: string,
    @Param('operationId') operationId: string,
  ) {
    return this.targets.getAuthValidation(targetId, operationId)
  }

  @Get(':targetId/auth-profile/validations/:operationId/browser')
  @RequirePermissions('target:write')
  validationBrowser(
    @Param('targetId') targetId: string,
    @Param('operationId') operationId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.validationBrowserMeta(targetId, operationId, actor)
  }

  @Post(':targetId/auth-profile/validations/:operationId/observe')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  observeAuthValidation(
    @Param('targetId') targetId: string,
    @Param('operationId') operationId: string,
    @Body(new ZodValidationPipe(observeAuthProfileValidationBodySchema)) body: ObserveAuthProfileValidationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.observeAuthValidation(targetId, operationId, body, actor)
  }

  @Post(':targetId/accounts/:accountId/identity')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:write')
  updateAccountIdentity(
    @Param('targetId') targetId: string,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(updateTargetAccountIdentityBodySchema)) body: UpdateTargetAccountIdentityBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.updateAccountIdentity(targetId, accountId, body, actor)
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
  @RequirePermissions('target:read')
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
