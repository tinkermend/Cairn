import { Controller, Get, Param, Query } from '@nestjs/common'
import {
  evidenceRetentionObjectsQuerySchema,
  evidenceSearchQuerySchema,
  type EvidenceRetentionObjectsQuery,
  type EvidenceSearchQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { EvidenceService } from './evidence.service'

@Controller('evidence')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Get()
  @RequirePermissions('run:read')
  list(
    @Query(new ZodValidationPipe(evidenceSearchQuerySchema)) query: EvidenceSearchQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.evidence.search(query, account.id)
  }

  @Get(':evidenceId')
  @RequirePermissions('run:read')
  get(@Param('evidenceId') evidenceId: string, @CurrentAccount() account: RequestAccount) {
    return this.evidence.get(evidenceId, account.id)
  }
}

@Controller('evidence-retention')
export class EvidenceRetentionController {
  constructor(private readonly evidence: EvidenceService) {}

  @Get('summary')
  @RequirePermissions('run:read')
  summary(@CurrentAccount() account: RequestAccount) {
    return this.evidence.summary(account)
  }

  @Get('objects')
  @RequirePermissions('run:read')
  objects(
    @Query(new ZodValidationPipe(evidenceRetentionObjectsQuerySchema)) query: EvidenceRetentionObjectsQuery,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.evidence.objects(query, account)
  }
}
