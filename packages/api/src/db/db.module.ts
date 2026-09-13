import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createDb, type DbHandle } from '@cairn/db'
import { assertReady } from '@cairn/db/admin'
import { resolveDbEnv } from '../config/env'

export const DB_HANDLE = Symbol('DB_HANDLE')

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      useFactory: async (): Promise<DbHandle> => {
        const env = resolveDbEnv()
        const database = createDb(env)
        try { await assertReady(database, env); return database } catch (error) { await database.close(); throw error }
      },
    },
  ],
  exports: [DB_HANDLE],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close()
  }
}
