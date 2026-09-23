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
  getOverview(@Param('targetId') targetId: string) {
    return this.reliability.getOverview(targetId)
  }

  @Post('evaluations')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:configure')
  triggerEvaluation(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(triggerEvaluationBodySchema)) body: TriggerEvaluationBody,
  ) {
    return this.reliability.requestEvaluation(targetId, body)
  }
}

@Controller('reliability/assets')
export class ReliabilityAssetsController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get()
  @RequirePermissions('reliability:read')
  list(@Query(new ZodValidationPipe(assetReliabilityQuerySchema)) query: AssetReliabilityQuery) {
    return this.reliability.listAssets(query)
  }
}

@Controller('reliability/incidents')
export class ReliabilityIncidentsController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get()
  @RequirePermissions('reliability:read')
  list(@Query(new ZodValidationPipe(reliabilityIncidentListQuerySchema)) query: ReliabilityIncidentListQuery) {
    return this.reliability.listIncidents(query)
  }

  @Get(':incidentId')
  @RequirePermissions('reliability:read')
  get(@Param('incidentId') incidentId: string) {
    return this.reliability.getIncidentDetail(incidentId)
  }

  @Get(':incidentId/signals')
  @RequirePermissions('reliability:read')
  listSignals(
    @Param('incidentId') incidentId: string,
    @Query(new ZodValidationPipe(incidentSignalsQuerySchema)) query: IncidentSignalsQuery,
  ) {
    return this.reliability.listIncidentSignals(incidentId, query)
  }

  @Post(':incidentId/merge')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  merge(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(mergeIncidentBodySchema)) body: MergeIncidentBody,
  ) {
    return this.reliability.mergeIncidents(incidentId, body)
  }

  @Post(':incidentId/split')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  split(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(splitIncidentBodySchema)) body: SplitIncidentBody,
  ) {
    return this.reliability.splitIncidents(incidentId, body)
  }

  @Post(':incidentId/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  dismiss(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(dismissIncidentBodySchema)) body: DismissIncidentBody,
  ) {
    return this.reliability.dismissIncident(incidentId, body)
  }

  @Post(':incidentId/silence')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  silence(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(silenceIncidentBodySchema)) body: SilenceIncidentBody,
  ) {
    return this.reliability.silenceIncident(incidentId, body)
  }

  @Post(':incidentId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('reliability:triage')
  resolve(
    @Param('incidentId') incidentId: string,
    @Body(new ZodValidationPipe(resolveIncidentBodySchema)) body: ResolveIncidentBody,
  ) {
    return this.reliability.resolveIncident(incidentId, body)
  }

  @Get(':incidentId/impact')
  @RequirePermissions('reliability:read')
  getImpact(@Param('incidentId') incidentId: string) {
    return this.reliability.getIncidentImpact(incidentId)
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
  getJob(@Param('jobId') jobId: string) {
    return this.reliability.getUpgradeJob(jobId)
  }
}

