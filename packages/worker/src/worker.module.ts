import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { LOGGING_CENSOR, LOGGING_REDACT_PATHS } from '@cairn/shared'
import { createObjectStore, findRepoRoot } from '@cairn/storage'
import { config, resolveWorkerEnv } from './config/env'
import { DB_HANDLE, DbModule } from './db/db.module'
import { ExecutionEngine } from './engine/engine'
import {
  OBJECT_SERVICE_OPTIONS,
  OBJECT_STORE,
  ObjectService,
} from './objects/object.service'
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
  providers: [
    {
      provide: OBJECT_STORE,
      useFactory: () =>
        // worker 编译为 CJS（package.json 无 "type": "module"），import.meta 在这里是语法错误；
        // 与 config/env.ts 一样用 __dirname。
        createObjectStore(resolveWorkerEnv(), {
          repoRoot: findRepoRoot(__dirname),
        }),
    },
    {
      provide: OBJECT_SERVICE_OPTIONS,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return {
          retainDays: env.CAIRN_OBJECT_RETAIN_DAYS,
          pendingTtlSeconds: env.CAIRN_OBJECT_PENDING_TTL_SECONDS,
          maxBytes: env.CAIRN_OBJECT_MAX_BYTES,
        }
      },
    },
    ObjectService,
    LifecycleService,
    ExecutionEngine,
  ],
})
export class WorkerModule {}
