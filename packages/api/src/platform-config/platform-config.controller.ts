import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common'
import {
  platformConfigRestoreBodySchema,
  platformConfigSecretBodySchema,
  platformConfigTestConnectionBodySchema,
  platformConfigUpdateBodySchema,
  platformConfigValidateBodySchema,
  type PlatformConfigRestoreBody,
  type PlatformConfigSecretBody,
  type PlatformConfigTestConnectionBody,
  type PlatformConfigUpdateBody,
  type PlatformConfigValidateBody,
} from '@cairn/shared'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { PlatformConfigService } from './platform-config.service'

@Controller('platform-config')
export class PlatformConfigController {
  constructor(private readonly platformConfig: PlatformConfigService) {}

  @Get()
  @RequirePermissions('platform-config:read')
  get() {
    return this.platformConfig.get()
  }

  @Get('revisions')
  @RequirePermissions('platform-config:read')
  revisions(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.platformConfig.revisions({
      cursor,
      limit: limit ? Number(limit) : undefined,
    })
  }

  @Post('validate')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  validate(@Body(new ZodValidationPipe(platformConfigValidateBodySchema)) body: PlatformConfigValidateBody) {
    return this.platformConfig.validate(body.document)
  }

  @Post('update')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  update(
    @Body(new ZodValidationPipe(platformConfigUpdateBodySchema)) body: PlatformConfigUpdateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.platformConfig.update(body, { id: actor.id })
  }

  @Post('restore')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  restore(
    @Body(new ZodValidationPipe(platformConfigRestoreBodySchema)) body: PlatformConfigRestoreBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.platformConfig.restore(body, { id: actor.id })
  }

  @Post('secrets')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  secrets(
    @Body(new ZodValidationPipe(platformConfigSecretBodySchema)) body: PlatformConfigSecretBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.platformConfig.registerSecret(body, { id: actor.id })
  }

  @Post('test-connection')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  testConnection(
    @Body(new ZodValidationPipe(platformConfigTestConnectionBodySchema))
    body: PlatformConfigTestConnectionBody,
  ) {
    return this.platformConfig.testConnection(body)
  }
}
