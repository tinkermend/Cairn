import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import {
  createScenarioBodySchema,
  updateScenarioBodySchema,
  type CreateScenarioBody,
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
