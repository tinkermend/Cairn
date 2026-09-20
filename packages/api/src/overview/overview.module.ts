import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { OverviewController } from './overview.controller'
import { OverviewService } from './overview.service'

@Module({
  imports: [AuthModule],
  controllers: [OverviewController],
  providers: [OverviewService],
  exports: [OverviewService],
})
export class OverviewModule {}
