import { Module } from '@nestjs/common'
import { DEFAULT_TRACE_MAX_BYTES, DEFAULT_VIDEO_MAX_BYTES } from '@cairn/shared'
import { createObjectStore, findRepoRoot } from '@cairn/storage'
import { resolveApiEnv } from '../config/env'
import { OBJECT_STORE } from './object-store.token'

@Module({
  providers: [
    {
      provide: OBJECT_STORE,
      useFactory: () => {
        const env = resolveApiEnv()
        return createObjectStore(
          {
            ...env,
            CAIRN_OBJECT_MAX_BYTES: Math.max(
              env.CAIRN_OBJECT_MAX_BYTES,
              DEFAULT_TRACE_MAX_BYTES,
              env.CAIRN_VIDEO_MAX_BYTES ?? DEFAULT_VIDEO_MAX_BYTES,
            ),
          },
          { repoRoot: () => findRepoRoot(__dirname) },
        )
      },
    },
  ],
  exports: [OBJECT_STORE],
})
export class ObjectsModule {}
