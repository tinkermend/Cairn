import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  dbEnvSchema,
  formatEnvIssues,
  workerEnvSchema,
  type DbEnv,
  type EnvValidationError,
  type WorkerEnv,
} from '@cairn/shared'

/**
 * 执行面进程配置。与 api 侧同一套约定：先读 .env，再按本进程真正读取的
 * 变量校验，失败则在连库、领任务之前退出，输出逐行「变量名: 原因」。
 *
 * 这里**不能**打日志——pino 尚未装配，且校验失败时终端输出才是唯一通道。
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

let cachedWorker: WorkerEnv | undefined

/** 已校验的进程配置。首次读取时才校验，失败即退出。 */
export function resolveWorkerEnv(): WorkerEnv {
  if (cachedWorker) return cachedWorker
  const parsed = workerEnvSchema.safeParse(process.env)
  if (!parsed.success) reportEnvFailure('cairn-worker', parsed.error)
  cachedWorker = parsed.data
  return cachedWorker
}

let cachedDb: DbEnv | undefined

/**
 * 数据库配置。DbModule 的工厂调用它而不是裸 parse——
 * 依赖注入栈对运维没有意义，配置错误应当以逐行变量名的形式直接结束进程。
 */
export function resolveDbEnv(): DbEnv {
  if (cachedDb) return cachedDb
  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) reportEnvFailure('cairn-worker', parsed.error)
  cachedDb = parsed.data
  return cachedDb
}

/** 惰性配置访问器：LoggerModule.forRoot 在模块求值时就要日志级别。 */
export const config: WorkerEnv = new Proxy({} as WorkerEnv, {
  get: (_target, key: string) => resolveWorkerEnv()[key as keyof WorkerEnv],
})
