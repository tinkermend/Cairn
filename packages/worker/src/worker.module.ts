import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { DbModule } from './db/db.module'
import { LifecycleService } from './runtime/lifecycle.service'

@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: { base: { service: 'cairn-worker' } } }),
    DbModule,
  ],
  providers: [LifecycleService],
})
export class WorkerModule {}
