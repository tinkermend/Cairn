import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import { reviewAnalysisCandidateBodySchema, type ReviewAnalysisCandidateBody } from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { AnalysisJobsService } from './analysis-jobs.service'

@Controller('knowledge-candidates')
export class KnowledgeCandidatesController {
  constructor(private readonly jobs: AnalysisJobsService) {}

  @Post(':candidateId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('target:read', 'map:read', 'map:analyze')
  review(@Param('candidateId') candidateId: string,
    @Body(new ZodValidationPipe(reviewAnalysisCandidateBodySchema)) body: ReviewAnalysisCandidateBody,
    @CurrentAccount() account: RequestAccount) {
    // The domain checks fresh target-scoped write permissions for the selected destination.
    return this.jobs.review(candidateId, body, account)
  }
}
