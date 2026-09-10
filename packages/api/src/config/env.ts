import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { apiEnvSchema, dbEnvSchema, type ApiEnv, type DbEnv } from '@cairn/shared'

/** 仓库根的 .env 不入库，本地开发时从这里读。生产由容器环境变量提供。 */
export function loadEnvFile(): void {
  const file = resolve(__dirname, '../../../../.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

/** 启动即校验。配置错误必须在进程起来之前显式失败，不能等到第一个请求。 */
export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(source)
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return apiEnvSchema.parse(source)
}
