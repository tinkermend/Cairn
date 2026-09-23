import { Module } from '@nestjs/common'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { TargetsModule } from '../targets/targets.module'
import { AssistantController } from './assistant.controller'
import { AssistantService } from './assistant.service'
import { AssistantCapabilityRegistry } from './registry'
import { AssistantAsyncRunner } from './async-runner'

import { AuthModule } from '../auth/auth.module'

@Module({
  imports: [PlatformConfigModule, TargetsModule, AuthModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantCapabilityRegistry, AssistantAsyncRunner],
  exports: [AssistantService, AssistantCapabilityRegistry, AssistantAsyncRunner],
})
export class AssistantModule {}
