import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  createScenarioBodySchema,
  publishScenarioBodySchema,
  saveScenarioDraftBodySchema,
  trialRunBodySchema,
  updateScenarioBodySchema,
  type CreateScenarioBody,
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
}
