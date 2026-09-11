import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { LOGGING_CENSOR, LOGGING_REDACT_PATHS } from '@cairn/shared'
import { BrowserModule } from './browser/browser.module'
import { config } from './config/env'
import { DbModule } from './db/db.module'
import { ExecutionEngine } from './engine/engine'
import { ObjectsModule } from './objects/objects.module'
import { LifecycleService } from './runtime/lifecycle.service'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.CAIRN_LOG_LEVEL,
        base: { service: 'cairn-worker' },
        redact: { paths: [...LOGGING_REDACT_PATHS], censor: LOGGING_CENSOR },
      },
    }),
    DbModule,
    ObjectsModule,
    BrowserModule,
  ],
  providers: [LifecycleService, ExecutionEngine],
})
export class WorkerModule {}
