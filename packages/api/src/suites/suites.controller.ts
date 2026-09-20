import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  createSuiteBodySchema,
  deleteResourceBodySchema,
  publishSuiteBodySchema,
  saveSuiteDraftBodySchema,
  suiteListQuerySchema,
  updateSuiteEnabledBodySchema,
  type CreateSuiteBody,
  type DeleteResourceBody,
  type PublishSuiteBody,
  type SaveSuiteDraftBody,
  type SuiteListQuery,
  type UpdateSuiteEnabledBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { SuitesService } from './suites.service'

@Controller('suites')
export class SuitesController {
  constructor(private readonly suites: SuitesService) {}

  @Get()
  @RequirePermissions('suite:read')
  list(@Query(new ZodValidationPipe(suiteListQuerySchema)) query: SuiteListQuery, @CurrentAccount() account: RequestAccount) {
    return this.suites.list(query, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:write')
  create(@Body(new ZodValidationPipe(createSuiteBodySchema)) body: CreateSuiteBody, @CurrentAccount() account: RequestAccount) {
    return this.suites.create(body, account)
  }

  @Get(':suiteId')
  @RequirePermissions('suite:read')
  get(@Param('suiteId') suiteId: string, @CurrentAccount() account: RequestAccount) {
    return this.suites.get(suiteId, account.id)
  }

  @Get(':suiteId/versions')
  @RequirePermissions('suite:read')
  versions(@Param('suiteId') suiteId: string, @CurrentAccount() account: RequestAccount) {
    return this.suites.versions(suiteId, account.id)
  }

  @Post(':suiteId/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:write')
  draft(
    @Param('suiteId') suiteId: string,
    @Body(new ZodValidationPipe(saveSuiteDraftBodySchema)) body: SaveSuiteDraftBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.suites.saveDraft(suiteId, body, account)
  }

  @Post(':suiteId/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:read')
  validate(@Param('suiteId') suiteId: string, @CurrentAccount() account: RequestAccount) {
    return this.suites.validate(suiteId, account.id)
  }

  @Post(':suiteId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:write')
  publish(
    @Param('suiteId') suiteId: string,
    @Body(new ZodValidationPipe(publishSuiteBodySchema)) body: PublishSuiteBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.suites.publish(suiteId, body, account)
  }

  @Post(':suiteId/enabled')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:write')
  enabled(
    @Param('suiteId') suiteId: string,
    @Body(new ZodValidationPipe(updateSuiteEnabledBodySchema)) body: UpdateSuiteEnabledBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.suites.enabled(suiteId, body, account)
  }

  @Post(':suiteId/delete-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:delete')
  deletePreview(@Param('suiteId') suiteId: string) {
    return this.suites.deletePreview(suiteId)
  }

  @Post(':suiteId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('suite:delete')
  delete(
    @Param('suiteId') suiteId: string,
    @Body(new ZodValidationPipe(deleteResourceBodySchema)) body: DeleteResourceBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.suites.delete(suiteId, body, account)
  }
}
