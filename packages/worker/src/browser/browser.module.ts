import { Module } from '@nestjs/common'
import { findRepoRoot } from '@cairn/storage'
import { resolveWorkerEnv } from '../config/env'
import { DbModule } from '../db/db.module'
import { BROWSER_PORT } from '../engine/ports'
import { ObjectsModule } from '../objects/objects.module'
import { ObjectService } from '../objects/object.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { resolveProfileRoot } from './profiles'
import { createBrowserPort } from './port'
import { BROWSER_SESSION_OPTIONS, BrowserSessionManager, SECRET_PROVIDER } from './session-manager'

@Module({
  imports: [DbModule, ObjectsModule],
  providers: [
    {
      provide: BROWSER_SESSION_OPTIONS,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return {
          workerId: env.CAIRN_WORKER_ID,
          profileRoot: resolveProfileRoot(env.CAIRN_BROWSER_PROFILE_DIR, () => findRepoRoot(__dirname)),
          headless: env.CAIRN_BROWSER_HEADLESS,
          maxSessions: env.CAIRN_BROWSER_MAX_SESSIONS,
          executablePath: env.CAIRN_BROWSER_EXECUTABLE_PATH,
          defaultLeaseTtlSeconds: env.CAIRN_SESSION_LEASE_TTL_SECONDS,
          defaultAuthWaitSeconds: env.CAIRN_SESSION_AUTH_WAIT_SECONDS,
          heartbeatMs: env.CAIRN_SESSION_HEARTBEAT_MS,
        }
      },
    },
    {
      provide: SECRET_PROVIDER,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return new LocalSecretProvider(credentialKeyFromEnv(env.CAIRN_CREDENTIAL_KEY))
      },
    },
    BrowserSessionManager,
    {
      provide: BROWSER_PORT,
      useFactory: (manager: BrowserSessionManager, objects: ObjectService) =>
        createBrowserPort(manager, objects),
      inject: [BrowserSessionManager, ObjectService],
    },
  ],
  exports: [BrowserSessionManager, BROWSER_PORT, BROWSER_SESSION_OPTIONS, SECRET_PROVIDER],
})
export class BrowserModule {}
