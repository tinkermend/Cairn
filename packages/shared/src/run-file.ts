import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { objectContentTypeSchema, objectDigestSchema, objectKeySchema } from './object-store.js'

export const RUN_FILE_HANDLE_KIND = 'cairn.file/v1' as const

export const runFileHandleSchema = z
  .strictObject({
    kind: z.literal(RUN_FILE_HANDLE_KIND),
    /** run：随 Run 保留策略回收的运行产物；fixture：Target 级长期托管资产。 */
    scope: z.enum(['run', 'fixture']),
    /** scope=run 时必填，upload 时校验与当前 Run 一致。 */
    runId: entityIdSchema.optional(),
    /** scope=fixture 时必填。 */
    fixtureId: entityIdSchema.optional(),
    objectKey: objectKeySchema,
    /** 注入页面时使用的文件名，已按安全规则清洗。 */
    name: z.string().min(1).max(255),
    mimeType: objectContentTypeSchema,
    byteSize: z.number().int().nonnegative(),
    digest: objectDigestSchema,
    createdAt: utcInstantSchema,
  })
  .refine((v) => (v.scope === 'run') === (v.runId !== undefined), {
    message: 'scope=run 必须且只能带 runId',
  })
  .refine((v) => (v.scope === 'fixture') === (v.fixtureId !== undefined), {
    message: 'scope=fixture 必须且只能带 fixtureId',
  })

export type RunFileHandle = z.infer<typeof runFileHandleSchema>

/** 从任意 context 值中识别句柄，供 upload 解析与 Studio 呈现共用。 */
export function asRunFileHandle(value: unknown): RunFileHandle | undefined {
  if (!value || typeof value !== 'object') return undefined
  const parsed = runFileHandleSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const targetFixtureDtoSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  scenarioId: entityIdSchema.nullable().optional(),
  name: z.string().min(1).max(255),
  contentType: objectContentTypeSchema,
  byteSize: z.number().int().nonnegative().nullable().optional(),
  digest: objectDigestSchema.nullable().optional(),
  available: z.boolean(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})

export type TargetFixtureDto = z.infer<typeof targetFixtureDtoSchema>

/**
 * 安全文件名清洗：剔除路径分隔符、控制字符与前导点号，限制最大 255 字符，空时回退默认名。
 */
export function safeDownloadFileName(name: string): string {
  const stripped = name
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return stripped.length > 0 ? stripped.slice(0, 255) : 'download.bin'
}

