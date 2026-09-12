import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'

@Module({
  imports: [ObjectsModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
