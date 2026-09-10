import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import {
  createTargetAccountBodySchema,
  createTargetBodySchema,
  updateTargetAccountBodySchema,
  updateTargetBodySchema,
  type CreateTargetAccountBody,
  type CreateTargetBody,
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
  listTargets() {
    return this.targets.listTargets()
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

  @Post(':targetId/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('target:delete')
  deleteTarget(@Param('targetId') targetId: string, @CurrentAccount() actor: RequestAccount) {
    return this.targets.deleteTarget(targetId, actor)
  }

  @Get(':targetId/accounts')
  @RequirePermissions('target:read')
  listAccounts(@Param('targetId') targetId: string) {
    return this.targets.listAccounts(targetId)
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('target:delete')
  deleteAccount(
    @Param('targetId') targetId: string,
    @Param('accountId') accountId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.targets.deleteAccount(targetId, accountId, actor)
  }
}
