import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common'
import {
  approveCandidateBodySchema,
  businessRecordsListQuerySchema,
  createBusinessSourceCandidateBodySchema,
  previewBusinessSourceBodySchema,
  previewBusinessSourceQuerySchema,
  revokeSourceBodySchema,
  targetBusinessSourceQuerySchema,
  type ApproveCandidateBody,
  type BusinessRecordsListQuery,
  type CreateBusinessSourceCandidateBody,
  type PreviewBusinessSourceBody,
  type PreviewBusinessSourceQuery,
  type RevokeSourceBody,
  type TargetBusinessSourceQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe.js'
import type { RequestAccount } from '../common/request-account.js'
import { CurrentAccount } from '../rbac/current-account.decorator.js'
import { RequirePermissions } from '../rbac/require-permission.decorator.js'
import { BusinessSourcesService } from './business-sources.service.js'

@Controller('targets')
export class BusinessSourcesController {
  constructor(private readonly businessSources: BusinessSourcesService) {}

  @Get(':targetId/business-sources')
  @RequirePermissions('target:read', 'dataset:read')
  getBusinessSource(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(targetBusinessSourceQuerySchema)) query: TargetBusinessSourceQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.getBusinessSource(targetId, query.entityType, actor.id)
  }

  @Get(':targetId/business-sources/preview')
  @RequirePermissions('target:read', 'dataset:read')
  previewBusinessSourceGet(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(previewBusinessSourceQuerySchema)) query: PreviewBusinessSourceQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.previewBusinessSource(
      targetId,
      {
        datasetId: query.datasetId,
        entityType: query.entityType,
        mappingConfig: {
          keyColumn: query.keyColumn,
          displayNameColumn: query.displayNameColumn,
          statusColumn: query.statusColumn,
          fieldWhitelist: query.fieldWhitelist,
          sensitiveFields: query.sensitiveFields,
        },
      },
      actor.id,
    )
  }

  @Post(':targetId/business-sources/preview')
  @RequirePermissions('target:read', 'dataset:read')
  previewBusinessSourcePost(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(previewBusinessSourceBodySchema)) body: PreviewBusinessSourceBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.previewBusinessSource(targetId, body, actor.id)
  }

  @Post(':targetId/business-sources/candidates')
  @RequirePermissions('target:write', 'dataset:write')
  createCandidate(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(createBusinessSourceCandidateBodySchema)) body: CreateBusinessSourceCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.createCandidate(targetId, body, actor.id)
  }

  @Get(':targetId/business-sources/candidates/:candidateId')
  @RequirePermissions('target:read', 'dataset:read')
  getCandidate(
    @Param('targetId') targetId: string,
    @Param('candidateId') candidateId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.getCandidate(targetId, candidateId, actor.id)
  }

  @Post(':targetId/business-sources/candidates/:candidateId/approve')
  @RequirePermissions('target:write', 'dataset:write')
  approveCandidate(
    @Param('targetId') targetId: string,
    @Param('candidateId') candidateId: string,
    @Body(new ZodValidationPipe(approveCandidateBodySchema)) body: ApproveCandidateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.approveCandidate(targetId, candidateId, body, actor.id)
  }

  @Post(':targetId/business-sources/revoke')
  @RequirePermissions('target:write', 'dataset:write')
  revokeSource(
    @Param('targetId') targetId: string,
    @Body(new ZodValidationPipe(revokeSourceBodySchema)) body: RevokeSourceBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.revokeSource(targetId, body.entityType ?? 'manufacturer', body, actor.id)
  }

  @Get(':targetId/business-records')
  @RequirePermissions('target:read')
  listBusinessRecords(
    @Param('targetId') targetId: string,
    @Query(new ZodValidationPipe(businessRecordsListQuerySchema)) query: BusinessRecordsListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.businessSources.listBusinessRecords(targetId, query, actor.id)
  }
}

