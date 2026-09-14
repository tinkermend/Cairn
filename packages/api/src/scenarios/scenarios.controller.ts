import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  applyRecordingImportBodySchema,
  createRecordingBindingBodySchema,
  createScenarioBodySchema,
  previewRecordingImportBodySchema,
  publishScenarioBodySchema,
  saveScenarioDraftBodySchema,
  trialRunBodySchema,
  updateScenarioBodySchema,
  type ApplyRecordingImportBody,
  type CreateRecordingBindingBody,
  type CreateScenarioBody,
  type PreviewRecordingImportBody,
  type PublishScenarioBody,
  type SaveScenarioDraftBody,
  type TrialRunBody,
  type UpdateScenarioBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ScenariosService } from './scenarios.service'

@Controller('scenarios')
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  @RequirePermissions('workflow:read')
  list() {
    return this.scenarios.list()
  }

  @Get('capabilities')
  @RequirePermissions('workflow:read')
  capabilities() {
    return this.scenarios.capabilities()
  }

  @Post()
  @RequirePermissions('workflow:write')
  create(
    @Body(new ZodValidationPipe(createScenarioBodySchema)) body: CreateScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.create(body, actor)
  }

  @Get(':scenarioId')
  @RequirePermissions('workflow:read')
  get(@Param('scenarioId') scenarioId: string) {
    return this.scenarios.get(scenarioId)
  }

  @Post(':scenarioId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  update(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(updateScenarioBodySchema)) body: UpdateScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.update(scenarioId, body, actor)
  }

  @Post(':scenarioId/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  saveDraft(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(saveScenarioDraftBodySchema)) body: SaveScenarioDraftBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.saveDraft(scenarioId, body, actor)
  }

  @Post(':scenarioId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  publish(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(publishScenarioBodySchema)) body: PublishScenarioBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.publish(scenarioId, body, actor)
  }

  @Post(':scenarioId/trial')
  @RequirePermissions('workflow:write', 'run:execute', 'target:read')
  async trial(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(trialRunBodySchema)) body: TrialRunBody,
    @CurrentAccount() actor: RequestAccount,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { detail, created } = await this.scenarios.trial(scenarioId, body, actor)
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return detail
  }

  @Post(':scenarioId/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('workflow:delete')
  remove(@Param('scenarioId') scenarioId: string, @CurrentAccount() actor: RequestAccount) {
    return this.scenarios.remove(scenarioId, actor)
  }

  @Get(':scenarioId/versions')
  @RequirePermissions('workflow:read')
  versions(@Param('scenarioId') scenarioId: string) {
    return this.scenarios.versions(scenarioId)
  }

  @Post(':scenarioId/recording-bindings')
  @RequirePermissions('workflow:write', 'target:read')
  createRecordingBinding(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(createRecordingBindingBodySchema)) body: CreateRecordingBindingBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.createRecordingBinding(scenarioId, body, actor)
  }

  @Get(':scenarioId/recording-imports')
  @RequirePermissions('workflow:read', 'target:read')
  listRecordingImports(
    @Param('scenarioId') scenarioId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.listRecordingImports(scenarioId, actor)
  }

  @Post(':scenarioId/recording-imports/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:read', 'target:read')
  previewRecordingImport(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(previewRecordingImportBodySchema)) body: PreviewRecordingImportBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.previewRecordingImport(scenarioId, body, actor)
  }

  @Post(':scenarioId/recording-imports/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write', 'target:read')
  applyRecordingImport(
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodValidationPipe(applyRecordingImportBodySchema)) body: ApplyRecordingImportBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.scenarios.applyRecordingImport(scenarioId, body, actor)
  }
}
