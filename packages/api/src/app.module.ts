import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { DbModule } from './db/db.module'
import { HealthModule } from './health/health.module'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        base: { service: 'cairn-api' },
        // 与命名约定对齐：X-Cairn-Run-Id 与 pino 的 runId 同源
        customProps: (req) => ({ runId: req.headers['x-cairn-run-id'] }),
        autoLogging: { ignore: (req) => req.url === '/health' },
      },
    }),
    DbModule,
    HealthModule,
  ],
})
export class AppModule {}
