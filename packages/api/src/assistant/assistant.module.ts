import { Module } from '@nestjs/common'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { TargetsModule } from '../targets/targets.module'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'

@Module({
  imports: [PlatformConfigModule, TargetsModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
