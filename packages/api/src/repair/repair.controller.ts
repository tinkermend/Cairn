import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import {
  createRepairCandidateBodySchema,
  validateRepairCandidateBodySchema,
  adoptRepairCandidateBodySchema,
  rejectRepairCandidateBodySchema,
  reopenRepairCandidateBodySchema,
  type CreateRepairCandidateBody,
  type ValidateRepairCandidateBody,
  type AdoptRepairCandidateBody,
  type RejectRepairCandidateBody,
  type ReopenRepairCandidateBody,
  type RepairCandidateStatus,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { RepairService } from './repair.service'

@Controller()
export class RepairController {
  constructor(private readonly repairService: RepairService) {}

  @Post('runs/:runId/repair-candidates')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('workflow:write', 'run:read')
  async createCandidate(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(createRepairCandidateBodySchema)) body: CreateRepairCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.repairService.createCandidate(runId, body, actor.id)
  }

  @Get('runs/:runId/repair-candidates')
  @RequirePermissions('run:read')
  async listCandidatesByRun(@Param('runId') runId: string, @CurrentAccount() actor: RequestAccount) {
    return this.repairService.listCandidatesByRun(runId, actor.id)
  }

  @Get('scenarios/:scenarioId/repair-candidates')
  @RequirePermissions('workflow:read')
  async listCandidatesByScenario(
    @Param('scenarioId') scenarioId: string,
    @CurrentAccount() actor: RequestAccount,
    @Query('status') status?: string,
  ) {
    return this.repairService.listCandidatesByScenario(scenarioId, status as RepairCandidateStatus | undefined, actor.id)
  }

  @Get('repair-candidates/:id')
  @RequirePermissions('run:read')
  async getCandidate(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.repairService.getCandidate(id, actor.id)
  }

  @Post('repair-candidates/:id/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'workflow:write')
  async validateCandidate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(validateRepairCandidateBodySchema)) body: ValidateRepairCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.repairService.validateCandidate(id, body, actor)
  }

  @Post('repair-candidates/:id/adopt')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  async adoptCandidate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(adoptRepairCandidateBodySchema)) body: AdoptRepairCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.repairService.adoptCandidate(id, body, actor.id)
  }

  @Post('repair-candidates/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  async rejectCandidate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectRepairCandidateBodySchema)) body: RejectRepairCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.repairService.rejectCandidate(id, body, actor.id)
  }

  @Post('repair-candidates/:id/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow:write')
  async reopenCandidate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reopenRepairCandidateBodySchema.optional())) _body: ReopenRepairCandidateBody | undefined,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.repairService.reopenCandidate(id, actor.id)
  }
}
