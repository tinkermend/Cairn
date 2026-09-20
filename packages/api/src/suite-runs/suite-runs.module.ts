import { Module } from '@nestjs/common'
import { SuiteRunsController } from './suite-runs.controller'
import { SuiteRunsService } from './suite-runs.service'

@Module({
  controllers: [SuiteRunsController],
  providers: [SuiteRunsService],
})
export class SuiteRunsModule {}
