import { Controller, Get, Query } from '@nestjs/common'
import {
  overviewAnalyticsQuerySchema,
  type OverviewAnalyticsQueryParsed,
  type OverviewAnalyticsResponse,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { OverviewService } from './overview.service'

@Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('analytics')
  @RequirePermissions('run:read')
  analytics(
    @Query(new ZodValidationPipe(overviewAnalyticsQuerySchema)) query: OverviewAnalyticsQueryParsed,
  ): Promise<OverviewAnalyticsResponse> {
    return this.overview.analytics(query)
  }
}
