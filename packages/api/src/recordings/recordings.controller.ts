import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import {
  claimRecordingBindingBodySchema,
  createRecordingBodySchema,
  type ClaimRecordingBindingBody,
  type CreateRecordingBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { RecordingsService } from './recordings.service'

@Controller('recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get()
  @RequirePermissions('workflow:write')
  list(@CurrentAccount() actor: RequestAccount) {
    return this.recordings.list(actor)
  }

  @Post()
  @RequirePermissions('workflow:write')
  create(
    @Body(new ZodValidationPipe(createRecordingBodySchema)) body: CreateRecordingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.recordings.create(body, actor)
  }

  @Get(':recordingId')
  @RequirePermissions('workflow:write')
  get(@Param('recordingId') recordingId: string, @CurrentAccount() actor: RequestAccount) {
    return this.recordings.get(recordingId, actor)
  }
}

@Controller('recording-bindings')
export class RecordingBindingsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get('open')
  @RequirePermissions('workflow:write', 'target:read')
  open(@CurrentAccount() actor: RequestAccount) {
    return this.recordings.open(actor)
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'target:read')
  claim(
    @Body(new ZodValidationPipe(claimRecordingBindingBodySchema)) body: ClaimRecordingBindingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.recordings.claim(body, actor)
  }

  @Post(':bindingId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  close(@Param('bindingId') bindingId: string, @CurrentAccount() actor: RequestAccount) {
    return this.recordings.close(bindingId, actor)
  }
}
