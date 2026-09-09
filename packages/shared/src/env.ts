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
