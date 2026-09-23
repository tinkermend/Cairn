import { Controller, Get, Query } from '@nestjs/common'
import { Public } from '../common/public.decorator'
import { ReportsService } from './reports.service'

@Public()
@Controller('public/reports')
export class PublicReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('view')
  async view(@Query('token') token: string) {
    return this.reports.getPublicReportView(token)
  }
}
