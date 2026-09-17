import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { loadSecretCiphertext, type DbHandle } from '@cairn/db'
import type { LocalSecretProvider } from '@cairn/secret'
import { buildWorkerLoggerOptions } from './logger-options'
import { BrowserModule } from './browser/browser.module'
import { BrowserSessionManager, SECRET_PROVIDER } from './browser/session-manager'
import { config } from './config/env'
import { DB_HANDLE, DbModule } from './db/db.module'
import { ChangeHintModule } from './observe/change-hint.module'
import { ExecutionEngine } from './engine/engine'
import { AI_PORT, BROWSER_PORT, type AiPort, type BrowserPort } from './engine/ports'
import { BrowserStepExecutor } from './engine/browser-executor'
import { FixtureStepExecutor } from './engine/fixture-executor'
import { AiStepExecutor } from './engine/ai-executor'
import { MapExploreExecutor } from './engine/explore-executor'
import { STEP_EXECUTOR_REGISTRY, StepExecutorRegistry } from './engine/step-executor'
import { ObjectsModule } from './objects/objects.module'
import { ObjectService } from './objects/object.service'
import { MapProjectionService } from './map/projection.service'
import { MapReferenceScanService } from './map/reference-scan.service'
import { LifecycleService } from './runtime/lifecycle.service'
import { createAiPort } from './ai/port'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: buildWorkerLoggerOptions({
        level: config.CAIRN_LOG_LEVEL,
        workerId: config.CAIRN_WORKER_ID,
      }),
    }),
    DbModule,
    ChangeHintModule,
    ObjectsModule,
    BrowserModule,
  ],
  providers: [
    LifecycleService,
    MapProjectionService,
    MapReferenceScanService,
    {
      provide: AI_PORT,
      useFactory: (
        manager: BrowserSessionManager,
        handle: DbHandle,
        objects: ObjectService,
        secrets?: LocalSecretProvider,
      ) =>
        createAiPort({
          manager,
          handle,
          objects,
          resolveApiKey: async (aiConfig) => {
            if (aiConfig.secretRef) {
              const row = await loadSecretCiphertext(handle, aiConfig.secretRef.secretId)
              if (!row || !secrets) {
                throw Object.assign(new Error('AI 模型密钥不可用'), { code: 'AI_CONFIG_INVALID' })
              }
              return secrets.decrypt(row.id, row.ciphertext)
            }
            // 仅兼容迁移前没有 secretRef 的旧快照；有引用时禁止回落当前进程明文。
            if (config.CAIRN_BROWSER_AI_API_KEY) return config.CAIRN_BROWSER_AI_API_KEY
            throw Object.assign(new Error('AI 模型密钥不可用'), { code: 'AI_CONFIG_INVALID' })
          },
        }),
      inject: [BrowserSessionManager, DB_HANDLE, ObjectService, { token: SECRET_PROVIDER, optional: true }],
    },
    {
      provide: STEP_EXECUTOR_REGISTRY,
      useFactory: (handle: DbHandle, browser?: BrowserPort, ai?: AiPort) => {
        const executors = [
          new FixtureStepExecutor(),
          new BrowserStepExecutor(handle, browser),
          new MapExploreExecutor(browser),
        ]
        if (ai) executors.push(new AiStepExecutor(ai))
        return new StepExecutorRegistry(executors)
      },
      inject: [DB_HANDLE, { token: BROWSER_PORT, optional: true }, { token: AI_PORT, optional: true }],
    },
    ExecutionEngine,
  ],
  exports: [ExecutionEngine, STEP_EXECUTOR_REGISTRY],
})
export class WorkerModule {}
