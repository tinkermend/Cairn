import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  apiEnvSchema,
  dbEnvSchema,
  formatEnvIssues,
  type ApiEnv,
  type DbEnv,
  type EnvValidationError,
} from '@cairn/shared'

/**
 * 进程配置的唯一入口。
 *
 * 三件事必须依次发生，缺一件就会踩到静默失败：
 * 1. 读仓库根的 .env（不入库；生产由容器环境变量提供，环境变量优先）；
 * 2. 按「谁读谁校验」的粒度 parse 本进程真正读取的变量；
 * 3. 校验失败在 listen 之前退出，输出逐行的「变量名: 原因」，
 *    不把 Nest 的依赖注入栈甩给运维，也不回显变量值。
 *
 * 只有 `config` / `resolveApiEnv` 一条读取路径。第二次实现一份「顺手
 * 再 parse 一遍」的入口，等于把「schema 校验过的」和「实际用的」拆成两份值。
 */

const ENV_FILE = resolve(__dirname, '../../../../.env')

/** 仓库根的 .env。已存在的环境变量优先，便于临时覆盖。 */
export function loadEnvFile(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

/** 配置错误的人读输出：只有变量名与规则，不含变量值。 */
export function reportEnvFailure(processName: string, error: EnvValidationError): never {
  console.error(`${processName} 配置校验失败，进程拒绝启动：`)
  for (const line of formatEnvIssues(error)) console.error(`  ✗ ${line}`)
  process.exit(1)
}

loadEnvFile()

let cachedApi: ApiEnv | undefined

/** 已校验的进程配置。首次读取时才校验，失败即退出。 */
export function resolveApiEnv(): ApiEnv {
  if (cachedApi) return cachedApi
  const parsed = apiEnvSchema.safeParse(process.env)
  if (!parsed.success) reportEnvFailure('cairn-api', parsed.error)
  cachedApi = parsed.data
  return cachedApi
}

let cachedDb: DbEnv | undefined

/**
 * 数据库配置。DbModule 的工厂调用它而不是裸 parse——
 * 依赖注入栈对运维没有意义，配置错误应当以逐行变量名的形式直接结束进程。
 */
export function resolveDbEnv(): DbEnv {
  if (cachedDb) return cachedDb
  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) reportEnvFailure('cairn-api', parsed.error)
  cachedDb = parsed.data
  return cachedDb
}

/**
 * 惰性配置访问器。
 *
 * 不能退化成模块加载时求值的普通对象：`LoggerModule.forRoot` 的参数在
 * 模块装饰器求值时就要用到日志级别，而校验失败必须在建应用之前发生。
 */
export const config: ApiEnv = new Proxy({} as ApiEnv, {
  get: (_target, key: string) => resolveApiEnv()[key as keyof ApiEnv],
})

export type { ApiEnv, DbEnv }
