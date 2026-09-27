import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { HealthModule } from '../health/health.module'
import { ChangeHintModule } from '../observe/change-hint.module'
import { PlatformHealthController } from './platform-health.controller'
import { PlatformHealthService } from './platform-health.service'

@Module({
  imports: [DbModule, HealthModule, ChangeHintModule],
  controllers: [PlatformHealthController],
  providers: [PlatformHealthService],
  exports: [PlatformHealthService],
})
export class PlatformHealthModule {}
