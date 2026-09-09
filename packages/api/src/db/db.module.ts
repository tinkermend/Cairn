import { Global, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createDb, type DbHandle } from '@cairn/db'
import { loadDbEnv } from '../config/env'

export const DB_HANDLE = Symbol('DB_HANDLE')

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      useFactory: (): DbHandle => createDb(loadDbEnv()),
    },
  ],
  exports: [DB_HANDLE],
})
export class DbModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // 连接池由 DbHandle 自己持有；进程退出时交给 Nest 生命周期收敛
  }
}
