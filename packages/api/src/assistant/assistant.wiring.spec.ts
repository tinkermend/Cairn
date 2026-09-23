import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { DbHandle } from '@cairn/db'
import { describe, expect, it } from 'vitest'
import { unusedChangeHint } from '../__tests__/http-app'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { AssistantAsyncRunner } from './async-runner'
import { AssistantModule } from './assistant.module'
import { AssistantService } from './assistant.service'
import type { PlatformModelClient } from './model-client'

const lifecycleHooks = new Set([
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
])

const stubDb = new Proxy({} as DbHandle, {
  get(_target, prop) {
    if (prop === 'then' || lifecycleHooks.has(String(prop))) return undefined
    if (prop === 'driver') return 'postgres'
    if (typeof prop === 'symbol') return undefined
    return async () => {
      throw new Error(`stub db ${String(prop)}`)
    }
  },
})

@Global()
@Module({
  providers: [
    { provide: DB_HANDLE, useValue: stubDb },
    { provide: CHANGE_HINT, useValue: unusedChangeHint },
  ],
  exports: [DB_HANDLE, CHANGE_HINT],
})
class AssistantWiringDepsModule {}

describe('助手生产装配', () => {
  it('服务持有容器注入的执行器，且模型客户端提供 complete', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AssistantWiringDepsModule, AssistantModule],
    }).compile()
    try {
      await moduleRef.init()
      const service = moduleRef.get(AssistantService)
      const runner = moduleRef.get(AssistantAsyncRunner)
      const held = (service as unknown as { asyncRunner: AssistantAsyncRunner }).asyncRunner
      const models = (runner as unknown as { models: PlatformModelClient }).models
      expect(held).toBe(runner)
      expect(typeof models.complete).toBe('function')
    } finally {
      await moduleRef.close()
    }
  })
})
