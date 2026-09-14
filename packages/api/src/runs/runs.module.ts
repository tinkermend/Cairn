import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ObjectsModule } from '../objects/objects.module'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { BrowserService } from './browser.service'
import { ObserveService } from './observe.service'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'
import { WorkerInternalClient } from './worker-internal.client'

@Module({
  imports: [ObjectsModule, PlatformConfigModule, AuthModule],
  controllers: [RunsController],
  providers: [RunsService, ObserveService, BrowserService, WorkerInternalClient],
})
export class RunsModule {}
