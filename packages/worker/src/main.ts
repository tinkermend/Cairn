import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { WorkerModule } from './worker.module'
import { loadEnvFile } from './config/env'

async function bootstrap(): Promise<void> {
  loadEnvFile()

  // createApplicationContext：拿到 DI 与生命周期，但不启动 HTTP 服务器。
  // 执行面不对外暴露端口，只从 PostgreSQL 领任务。
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()

  app.get(Logger).log(`cairn-worker 已启动（workerId=${process.env.CAIRN_WORKER_ID || 'unset'}）`)
}

void bootstrap()
