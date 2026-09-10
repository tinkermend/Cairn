import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { loadEnvFile } from './config/env'

/** 停机收敛的上限。超时强制退出，避免容器等到 kill -9。 */
const SHUTDOWN_TIMEOUT_MS = 10_000

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function bootstrap(): Promise<void> {
  loadEnvFile()

  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))

  // 显式白名单。前一代用无参 cors() 等于允许任意源
  app.enableCors({
    origin: parseOrigins(process.env.CAIRN_CORS_ORIGINS),
    credentials: true,
  })

  // 业务路由统一挂 /api；/health 留在根路径，供负载均衡与容器探活直接访问
  app.setGlobalPrefix('api', { exclude: ['health'] })

  // 让 OnApplicationShutdown 在 SIGTERM/SIGINT 时触发
  app.enableShutdownHooks()

  const port = Number(process.env.CAIRN_API_PORT ?? 3030)
  await app.listen(port, '0.0.0.0')

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const timer = setTimeout(() => {
        // 收敛卡住时不能无限等——留一条确定的退出路径
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS)
      timer.unref()
    })
  }
}

void bootstrap()
