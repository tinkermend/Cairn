import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { ArtifactsController, ExportJobsController, ReportsController } from './reports.controller'
import { ReportsService } from './reports.service'
import { ReportAssetsController, ReportBundlesController, ReportProfilesController, ScenarioReportDefaultsController } from './report-settings.controller'

@Module({
  imports: [ObjectsModule],
  controllers: [ReportsController, ExportJobsController, ArtifactsController, ReportAssetsController, ReportBundlesController, ReportProfilesController, ScenarioReportDefaultsController],
  providers: [ReportsService],
})
export class ReportsModule {}
