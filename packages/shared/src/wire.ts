import { z } from 'zod'

/**
 * 跨进程线格式的公共零件。
 *
 * 实体 ID、JSON 值、UTC 时刻和时长会同时出现在 Snapshot、Evidence 和事件里。
 * 各写一份的结局是一边收紧另一边还在收裸 string。
 */

/** 顶层信封的 schema 版本。Step 跟快照走，不单独版本。 */
export const RUNTIME_SCHEMA_VERSION = 1 as const
export const runtimeSchemaVersionSchema = z.literal(RUNTIME_SCHEMA_VERSION)
export type RuntimeSchemaVersion = typeof RUNTIME_SCHEMA_VERSION

/**
 * 跨进程实体 ID。
 *
 * 形状是 UUID，版本不封闭：持久化侧用 UUIDv7，HTTP 侧仍可能冒出 v4。
 * 契约校验「是不是 UUID」，不校验「是不是 v7」。
 */
export const entityIdSchema = z.uuid()
export type EntityId = z.infer<typeof entityIdSchema>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

/**
 * 存储与跨进程传输用的时刻：ISO-8601，必须带 `Z`。
 *
 * `+08:00` 能通过「带偏移的 datetime」，但入库后展示层会再转一次，
 * 两个时区叠在一起是最难查的错。展示转换留给 UI，这里只收 UTC。
 */
export const utcInstantSchema = z.iso.datetime()
export type UtcInstant = z.infer<typeof utcInstantSchema>

/** 墙上时钟间隔，毫秒。Delay、timeout、耗时用它；租约到期不用它。 */
export const MAX_DURATION_MS = 86_400_000
export const durationMsSchema = z.number().int().min(0).max(MAX_DURATION_MS)
export type DurationMs = z.infer<typeof durationMsSchema>

/** 步骤 / 快照级超时。0 没有意义，上限与 duration 相同。 */
export const timeoutMsSchema = z.number().int().positive().max(MAX_DURATION_MS)

/**
 * 租约到期时刻的线格式，与 `utcInstantSchema` 同形状。
 *
 * 语义不同：比较是否过期必须用数据库时间，不得用进程 `Date.now()` 当真相。
 * 本轮只冻名字，写入与续租在 P3。
 */
export const leaseExpiresAtSchema = utcInstantSchema
export type LeaseExpiresAt = z.infer<typeof leaseExpiresAtSchema>
