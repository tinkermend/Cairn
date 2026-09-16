import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { MapService } from './map.service'

@Controller('map-jobs')
export class MapJobsController {
  constructor(private readonly maps: MapService) {}

  @Get(':jobId')
  @RequirePermissions('target:read', 'map:read')
  getJob(@Param('jobId') jobId: string) {
    return this.maps.getJob(jobId)
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:maintain')
  cancelJob(@Param('jobId') jobId: string, @CurrentAccount() account: RequestAccount) {
    return this.maps.cancelJob(jobId, account)
  }
}
