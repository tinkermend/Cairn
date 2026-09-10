import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { REQUEST_ID_HEADER } from '@cairn/shared'
import { AppModule } from './app.module'
import { resolveApiEnv } from './config/env'

/** 停机收敛的上限。超时强制退出，避免容器等到 kill -9。 */
const SHUTDOWN_TIMEOUT_MS = 10_000

async function bootstrap(): Promise<void> {
  // 配置在模块加载时就已校验；这里取已解析结果，不再直接读 process.env，
  // 免得「schema 里校验过的」和「实际用的」是两份值。
  const env = resolveApiEnv()

  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))

  // 显式白名单。前一代用无参 cors() 等于允许任意源。
  // 拆分与合法性校验都在 schema 里完成，这里只消费结果——同一份配置不做两次解释
  app.enableCors({
    origin: [...env.CAIRN_CORS_ORIGINS],
    credentials: true,
    // 跨源时浏览器默认读不到自定义响应头；不放行的话 apiFetch 的兜底分支
    // （错误体解析失败时从响应头取 requestId）恰好会在最需要它时拿到 unknown
    exposedHeaders: [REQUEST_ID_HEADER],
  })

  // 业务路由统一挂 /api；/health 留在根路径，供负载均衡与容器探活直接访问
  app.setGlobalPrefix('api', { exclude: ['health'] })

  // 让 OnApplicationShutdown 在 SIGTERM/SIGINT 时触发
  app.enableShutdownHooks()

  await app.listen(env.CAIRN_API_PORT, '0.0.0.0')

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
