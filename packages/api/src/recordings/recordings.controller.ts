import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { createRecordingBodySchema, type CreateRecordingBody } from '@cairn/shared'
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
  list() {
    return this.recordings.list()
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
  get(@Param('recordingId') recordingId: string) {
    return this.recordings.get(recordingId)
  }
}
