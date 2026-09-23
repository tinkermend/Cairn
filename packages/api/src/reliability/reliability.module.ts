import { Module } from '@nestjs/common'
import {
  ReliabilityAssetsController,
  ReliabilityIncidentsController,
  ReliabilityUpgradeJobsController,
  TargetReliabilityController,
} from './reliability.controller'
import { ReliabilityService } from './reliability.service'

@Module({
  controllers: [
    TargetReliabilityController,
    ReliabilityAssetsController,
    ReliabilityIncidentsController,
    ReliabilityUpgradeJobsController,
  ],
  providers: [ReliabilityService],
  exports: [ReliabilityService],
})
export class ReliabilityModule {}
