import { Module } from '@nestjs/common'
import { AnalysisJobsController } from './analysis-jobs.controller'
import { AnalysisJobsService } from './analysis-jobs.service'
import { KnowledgeCandidatesController } from './knowledge-candidates.controller'

@Module({
  controllers: [AnalysisJobsController, KnowledgeCandidatesController],
  providers: [AnalysisJobsService],
})
export class AnalysisJobsModule {}
