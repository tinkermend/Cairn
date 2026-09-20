import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Param, Post, Query, StreamableFile } from '@nestjs/common'
import {
  claimRecordingBindingBodySchema,
  createDemonstrationBodySchema,
  type CreateDemonstrationBody,
  createRecordingBodySchema,
  recordingDraftListQuerySchema,
  renameRecordingBodySchema,
  type ClaimRecordingBindingBody,
  type CreateRecordingBody,
  type RecordingDraftListQuery,
  type RenameRecordingBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { RecordingsService } from './recordings.service'
import { RecordingArtifactsService } from './artifacts.service'

@Controller('recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService, private readonly artifacts: RecordingArtifactsService) {}

  @Post('demonstrations')
  @RequirePermissions('workflow:write', 'target:read')
  createDemonstration(@Body(new ZodValidationPipe(createDemonstrationBodySchema)) body: CreateDemonstrationBody, @CurrentAccount() actor: RequestAccount) {
    return this.recordings.createDemonstration(body, actor)
  }

  @Get(':recordingId/demonstration')
  @RequirePermissions('workflow:write', 'target:read')
  demonstration(@Param('recordingId') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.recordings.demonstration(id, actor)
  }

  @Post(':recordingId/artifacts/:artifactId/content')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'target:read')
  uploadArtifact(@Param('recordingId') id: string, @Param('artifactId') artifactId: string,
    @Headers('x-upload-generation') generationId: string, @Body() body: Buffer, @CurrentAccount() actor: RequestAccount) {
    return this.artifacts.upload(id, artifactId, generationId, body, actor.id)
  }

  @Get(':recordingId/artifacts/:artifactId/content')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @RequirePermissions('workflow:write', 'target:read')
  async artifact(@Param('recordingId') id: string, @Param('artifactId') artifactId: string, @CurrentAccount() actor: RequestAccount) {
    const content = await this.artifacts.read(id, artifactId, actor.id)
    return new StreamableFile(content.bytes, { type: content.contentType, disposition: 'inline', length: content.bytes.length })
  }

  @Get()
  @RequirePermissions('workflow:write')
  list(
    @CurrentAccount() actor: RequestAccount,
    @Query(new ZodValidationPipe(recordingDraftListQuerySchema)) query: RecordingDraftListQuery,
  ) {
    return this.recordings.list(actor, query)
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

  @Post(':recordingId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  rename(
    @Param('recordingId') recordingId: string,
    @Body(new ZodValidationPipe(renameRecordingBodySchema)) body: RenameRecordingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.recordings.rename(recordingId, body.name, actor)
  }

  @Post(':recordingId/rename')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  renameAlias(
    @Param('recordingId') recordingId: string,
    @Body(new ZodValidationPipe(renameRecordingBodySchema)) body: RenameRecordingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.recordings.rename(recordingId, body.name, actor)
  }

  @Post(':recordingId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:delete')
  delete(@Param('recordingId') recordingId: string, @CurrentAccount() actor: RequestAccount) {
    return this.recordings.remove(recordingId, actor)
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
