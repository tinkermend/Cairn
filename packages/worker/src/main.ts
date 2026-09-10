import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { WorkerModule } from './worker.module'
import { resolveWorkerEnv } from './config/env'

async function bootstrap(): Promise<void> {
  // 配置在首次读取时校验，失败即退出。这里取已解析结果，不再把缺失的
  // workerId 打成 'unset'——那行日志恰恰在配置出问题时最难分辨真假。
  const env = resolveWorkerEnv()

  // createApplicationContext：拿到 DI 与生命周期，但不启动 HTTP 服务器。
  // 执行面不对外暴露端口，只从 PostgreSQL 领任务。
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()

  app.get(Logger).log(`cairn-worker 已启动（workerId=${env.CAIRN_WORKER_ID}）`)
}

void bootstrap()
