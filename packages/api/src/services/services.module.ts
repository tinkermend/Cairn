import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { OpenExecutionController, ServicesController } from './services.controller'
import { ServicesService } from './services.service'
@Module({
  imports: [ObjectsModule, PlatformConfigModule],
  controllers: [ServicesController, OpenExecutionController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
