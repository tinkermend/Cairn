import { Module } from '@nestjs/common'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { ScenariosController } from './scenarios.controller'
import { ScenariosService } from './scenarios.service'

@Module({
  imports: [PlatformConfigModule],
  controllers: [ScenariosController],
  providers: [ScenariosService],
})
export class ScenariosModule {}
