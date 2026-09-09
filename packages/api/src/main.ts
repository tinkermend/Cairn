import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { loadEnvFile } from './config/env'

async function bootstrap(): Promise<void> {
  loadEnvFile()

  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  // 让 OnApplicationShutdown 在 SIGTERM/SIGINT 时触发
  app.enableShutdownHooks()

  const port = Number(process.env.CAIRN_API_PORT ?? 3030)
  await app.listen(port, '0.0.0.0')
}

void bootstrap()
