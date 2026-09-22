import { Module } from '@nestjs/common'
import { DatasetsController } from './datasets.controller'
import { DatasetsService } from './datasets.service'

@Module({
  controllers: [DatasetsController],
  providers: [DatasetsService],
  exports: [DatasetsService],
})
export class DatasetsModule {}
