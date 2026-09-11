import { Module } from '@nestjs/common'
import { BrowserSessionsController } from './browser-sessions.controller'
import { BrowserSessionsService } from './browser-sessions.service'

@Module({
  controllers: [BrowserSessionsController],
  providers: [BrowserSessionsService],
})
export class BrowserSessionsModule {}
