import { Module } from '@nestjs/common'
import { findRepoRoot } from '@cairn/storage'
import { resolveWorkerEnv } from '../config/env'
import { DbModule } from '../db/db.module'
import { BROWSER_PORT } from '../engine/ports'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { resolveProfileRoot } from './profiles'
import {
  BROWSER_SESSION_OPTIONS,
  BrowserSessionManager,
  SECRET_PROVIDER,
  SessionLeaseError,
} from './session-manager'

@Module({
  imports: [DbModule],
  providers: [
    {
      provide: BROWSER_SESSION_OPTIONS,
      useFactory: () => {
        const env = resolveWorkerEnv()
        return {
          workerId: env.CAIRN_WORKER_ID,
          // 惰性：绝对路径配置用不到仓根，容器里也找不到 pnpm-workspace.yaml。
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
      useFactory: (manager: BrowserSessionManager) => ({
        async acquire(
          run: Parameters<BrowserSessionManager['acquire']>[0],
          grant: Parameters<BrowserSessionManager['acquire']>[1],
          signal?: AbortSignal,
        ) {
          const result = await manager.acquire(run, grant, signal)
          if (!result.ok) {
            const error = new Error(result.message) as Error & {
              code: string
              waitingForAuth?: boolean
            }
            error.code = result.code
            error.waitingForAuth = result.waitingForAuth
            throw error
          }
          return result.grant
        },
        async release(grant: { leaseId: string }, reason: string) {
          try {
            await manager.release(grant.leaseId, reason)
          } catch (error) {
            if (error instanceof SessionLeaseError) throw error
            throw error
          }
        },
      }),
      inject: [BrowserSessionManager],
    },
  ],
  exports: [BrowserSessionManager, BROWSER_PORT, BROWSER_SESSION_OPTIONS, SECRET_PROVIDER],
})
export class BrowserModule {}
