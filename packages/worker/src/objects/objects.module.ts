import { Module } from '@nestjs/common'
import { findRepoRoot, createObjectStore } from '@cairn/storage'
import { resolveWorkerEnv } from '../config/env'
import { DbModule } from '../db/db.module'
import { EvidenceSettleService } from '../evidence/settle.service'
import { OBJECT_SERVICE_OPTIONS, OBJECT_STORE, ObjectService } from './object.service'

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: OBJECT_STORE,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return createObjectStore(
          {
            ...env,
            CAIRN_OBJECT_MAX_BYTES: Math.max(
              env.CAIRN_OBJECT_MAX_BYTES,
              env.CAIRN_TRACE_MAX_BYTES,
              env.CAIRN_VIDEO_MAX_BYTES,
            ),
          },
          { repoRoot: () => findRepoRoot(__dirname) },
        )
      },
    },
    {
      provide: OBJECT_SERVICE_OPTIONS,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return {
          retainDays: env.CAIRN_OBJECT_RETAIN_DAYS,
          pendingTtlSeconds: env.CAIRN_OBJECT_PENDING_TTL_SECONDS,
          maxBytes: env.CAIRN_OBJECT_MAX_BYTES,
          traceMaxBytes: env.CAIRN_TRACE_MAX_BYTES,
          videoMaxBytes: env.CAIRN_VIDEO_MAX_BYTES,
          uploadMaxAttempts: env.CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS,
        }
      },
    },
    ObjectService,
    EvidenceSettleService,
  ],
  exports: [ObjectService, EvidenceSettleService, OBJECT_SERVICE_OPTIONS],
})
export class ObjectsModule {}
