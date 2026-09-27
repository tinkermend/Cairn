import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  assetReliabilityQuerySchema,
  batchUpgradeBodySchema,
  dismissIncidentBodySchema,
  incidentSignalsQuerySchema,
  mergeIncidentBodySchema,
  reliabilityIncidentListQuerySchema,
  resolveIncidentBodySchema,
  silenceIncidentBodySchema,
  splitIncidentBodySchema,
  triggerEvaluationBodySchema,
  type AssetReliabilityQuery,
  type BatchUpgradeBody,
  type DismissIncidentBody,
  type IncidentSignalsQuery,
  type MergeIncidentBody,
  type ReliabilityIncidentListQuery,
  type ResolveIncidentBody,
  type SilenceIncidentBody,
  type SplitIncidentBody,
  type TriggerEvaluationBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ReliabilityService } from './reliability.service'

@Controller('targets/:targetId/reliability')
export class TargetReliabilityController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get()
  @RequirePermissions('reliability:read')
  getOverview(@Param('targetId') targetId: string, @CurrentAccount() actor: RequestAccount) {
    return this.reliability.getOverview(targetId, actor.id)
  }

  @Post('evaluations')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:configure')
  triggerEvaluation(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(triggerEvaluationBodySchema)) body: TriggerEvaluationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.requestEvaluation(targetId, body, actor.id)
  }
}

@Controller('reliability/assets')
export class ReliabilityAssetsController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get()
  @RequirePermissions('reliability:read')
  list(
    @Query(new ZodValidationPipe(assetReliabilityQuerySchema)) query: AssetReliabilityQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.listAssets(query, actor.id)
  }
}

@Controller('reliability/incidents')
export class ReliabilityIncidentsController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get()
  @RequirePermissions('reliability:read')
  list(
    @Query(new ZodValidationPipe(reliabilityIncidentListQuerySchema)) query: ReliabilityIncidentListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.listIncidents(query, actor.id)
  }

  @Get(':incidentId')
  @RequirePermissions('reliability:read')
  get(@Param('incidentId') incidentId: string, @CurrentAccount() actor: RequestAccount) {
    return this.reliability.getIncidentDetail(incidentId, actor.id)
  }

  @Get(':incidentId/signals')
  @RequirePermissions('reliability:read')
  listSignals(
    @Param('incidentId') incidentId: string,
    @Query(new ZodValidationPipe(incidentSignalsQuerySchema)) query: IncidentSignalsQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.listIncidentSignals(incidentId, query, actor.id)
  }

  @Post(':incidentId/merge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  merge(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(mergeIncidentBodySchema)) body: MergeIncidentBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.mergeIncidents(incidentId, body, actor.id)
  }

  @Post(':incidentId/split')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  split(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(splitIncidentBodySchema)) body: SplitIncidentBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.splitIncidents(incidentId, body, actor.id)
  }

  @Post(':incidentId/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  dismiss(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(dismissIncidentBodySchema)) body: DismissIncidentBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.dismissIncident(incidentId, body, actor.id)
  }

  @Post(':incidentId/silence')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  silence(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(silenceIncidentBodySchema)) body: SilenceIncidentBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.silenceIncident(incidentId, body, actor.id)
  }

  @Post(':incidentId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  resolve(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(resolveIncidentBodySchema)) body: ResolveIncidentBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.resolveIncident(incidentId, body, actor.id)
  }

  @Get(':incidentId/impact')
  @RequirePermissions('reliability:read')
  getImpact(@Param('incidentId') incidentId: string, @CurrentAccount() actor: RequestAccount) {
    return this.reliability.getIncidentImpact(incidentId, actor.id)
  }

  @Post(':incidentId/batch-upgrade')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  batchUpgrade(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(batchUpgradeBodySchema)) body: BatchUpgradeBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.reliability.batchUpgrade(incidentId, body, actor)
  }
}

@Controller('reliability/upgrade-jobs')
export class ReliabilityUpgradeJobsController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get(':jobId')
  @RequirePermissions('reliability:read')
  getJob(@Param('jobId') jobId: string, @CurrentAccount() actor: RequestAccount) {
    return this.reliability.getUpgradeJob(jobId, actor.id)
  }
}
