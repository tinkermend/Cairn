import { z } from 'zod'

/**
 * 平台自有配置。第三方依赖自带的变量（MIDSCENE_*、DATABASE_URL）
 * 不在此校验——它们由外部库直接读取。
 */
export const dbEnvSchema = z.object({
  CAIRN_DB_HOST: z.string().min(1),
  CAIRN_DB_PORT: z.coerce.number().int().positive().default(5432),
  CAIRN_DB_NAME: z.string().min(1),
  CAIRN_DB_USER: z.string().min(1),
  CAIRN_DB_PASSWORD: z.string().min(1),
  CAIRN_DB_SCHEMA: z.string().min(1).default('cairn'),
})

export type DbEnv = z.infer<typeof dbEnvSchema>

/** 控制面进程配置。JWT 默认值只方便本地/测试；私有化交付必须在环境里覆盖。 */
export const apiEnvSchema = z.object({
  CAIRN_JWT_SECRET: z.string().min(16).default('dev-only-change-me-jwt-secret'),
  CAIRN_JWT_EXPIRES_IN: z.string().min(1).default('12h'),
  CAIRN_BOOTSTRAP_ADMIN_EMAIL: z.email().default('admin@cairn.dev'),
  CAIRN_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default('cairn-admin'),
  CAIRN_BOOTSTRAP_ADMIN_NAME: z.string().min(1).default('Administrator'),
})

export type ApiEnv = z.infer<typeof apiEnvSchema>

export function parseDurationSeconds(raw: string): number {
  const match = /^(\d+)([smhd])$/.exec(raw.trim())
  if (!match) return 12 * 3600
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 's') return n
  if (unit === 'm') return n * 60
  if (unit === 'h') return n * 3600
  return n * 86400
}
