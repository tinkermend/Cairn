import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { LOGGING_CENSOR, LOGGING_REDACT_PATHS } from '@cairn/shared'
import { config } from './config/env'
import { DbModule } from './db/db.module'
import { LifecycleService } from './runtime/lifecycle.service'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.CAIRN_LOG_LEVEL,
        base: { service: 'cairn-worker' },
        // 脱敏清单与 api 共用同一份常量。执行面现在没有 HTTP 入口，
        // 但将来接上时不应该再想一次「要不要脱敏」。
        redact: { paths: [...LOGGING_REDACT_PATHS], censor: LOGGING_CENSOR },
      },
    }),
    DbModule,
  ],
  providers: [LifecycleService],
})
export class WorkerModule {}
