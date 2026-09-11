import { Module } from '@nestjs/common'
import { findRepoRoot, createObjectStore } from '@cairn/storage'
import { resolveWorkerEnv } from '../config/env'
import { DbModule } from '../db/db.module'
import { OBJECT_SERVICE_OPTIONS, OBJECT_STORE, ObjectService } from './object.service'

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: OBJECT_STORE,
      useFactory: () =>
        createObjectStore(resolveWorkerEnv(), {
          repoRoot: () => findRepoRoot(__dirname),
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
  ],
  exports: [ObjectService],
})
export class ObjectsModule {}
