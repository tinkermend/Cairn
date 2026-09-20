import { z } from 'zod'
import { utcInstantSchema } from './wire.js'

/**
 * `/health` 的响应契约。
 *
 * api 用它序列化响应，web 用它解析——同一个 schema 对象，
 * 是前后端契约不漂移的最小证明。
 */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.enum(['cairn-api', 'cairn-worker']),
  /** 进程启动至今的秒数 */
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    changeHint: z.enum(['up', 'down', 'unused']).default('unused'),
  }),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

export const workerNodeHealthNodeSchema = z.object({
  workerId: z.string().min(1),
  instanceId: z.string().min(1),
  lastTickAt: utcInstantSchema.nullable(),
  loopAlive: z.boolean(),
  runningRunCount: z.number().int().nonnegative(),
  liveHandleCount: z.number().int().nonnegative(),
  shuttingDown: z.boolean(),
})
export type WorkerNodeHealthNode = z.infer<typeof workerNodeHealthNodeSchema>

export const workerNodeHealthResponseSchema = healthResponseSchema.extend({
  node: workerNodeHealthNodeSchema,
})
export type WorkerNodeHealthResponse = z.infer<typeof workerNodeHealthResponseSchema>
