import { Module } from '@nestjs/common'
import { MapController } from './map.controller'
import { MapJobsController } from './map-jobs.controller'
import { MapService } from './map.service'

@Module({
  controllers: [MapController, MapJobsController],
  providers: [MapService],
})
export class MapModule {}
