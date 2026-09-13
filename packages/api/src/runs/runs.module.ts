import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'

@Module({
  imports: [ObjectsModule, PlatformConfigModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
