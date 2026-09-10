import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createDb, type DbHandle } from '@cairn/db'
import { resolveDbEnv } from '../config/env'

export const DB_HANDLE = Symbol('DB_HANDLE')

/**
 * 与 api 的 DbModule 形状相同但各自持有——两个进程只通过 PostgreSQL
 * 通信，不共享内存状态。待出现第二个共用模块时再抽 @cairn/nest-common，
 * 现在抽属于过早。
 *
 * 连接池的所有权在此：由创建者负责关闭，不散落到各个 service。
 *
 * 注意：此处**不要打日志**。Nest 逆序销毁模块，pino 的 LoggerModule
 * 会先于本模块拆除，写在这里的日志永远不会出现。释放行为已由
 * pg_stat_activity 侧验证（停机后连接数归零）。
 */
@Global()
@Module({
  providers: [{ provide: DB_HANDLE, useFactory: (): DbHandle => createDb(resolveDbEnv()) }],
  exports: [DB_HANDLE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close()
  }
}
