import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { WorkerInternalClient } from '../runs/worker-internal.client'
import {
  AccountSessionController,
  BrowserSessionsController,
  SessionOperationsController,
} from './browser-sessions.controller'
import { BrowserSessionsService } from './browser-sessions.service'

@Module({
  imports: [AuthModule],
  controllers: [BrowserSessionsController, SessionOperationsController, AccountSessionController],
  providers: [BrowserSessionsService, WorkerInternalClient],
})
export class BrowserSessionsModule {}
