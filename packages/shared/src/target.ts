import { z } from 'zod'
import { loginFieldsInputSchema, targetLoginFieldsDtoSchema } from './login-fields.js'
import {
  sessionPolicyOverrideSchema,
  sessionPolicySchema,
} from './session.js'
import { nextCursorSchema } from './rbac.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'

export {
  LOGIN_FIELD_HEURISTICS,
  LOGIN_HEURISTIC_VERSION,
  LOGIN_LOCATOR_BY,
  compactLoginFields,
  loginFieldsInputSchema,
  loginLocatorSchema,
  targetLoginFieldsDtoSchema,
  targetLoginFieldsObjectSchema,
  type LoginLocator,
  type LoginLocatorBy,
  type TargetLoginFields,
} from './login-fields.js'

export const TARGET_STATUSES = ['active', 'disabled'] as const
export type TargetStatus = (typeof TARGET_STATUSES)[number]

export const AUTH_METHODS = ['password', 'manual'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

export const CAPTCHA_MODES = ['none', 'image', 'slider', 'sms', 'other'] as const
export type CaptchaMode = (typeof CAPTCHA_MODES)[number]

export const TARGET_ERROR_CODES = [
  'TARGET_NOT_FOUND',
  'TARGET_ACCOUNT_NOT_FOUND',
  'TARGET_CODE_CONFLICT',
  'TARGET_ACCOUNT_CONFLICT',
  'TARGET_HAS_ACCOUNTS',
  'TARGET_HAS_SCENARIOS',
  'TARGET_HAS_RECORDINGS',
  'TARGET_DISABLED',
  'TARGET_ACCOUNT_HAS_RUNS',
  'TARGET_ACCOUNT_BUSY',
  'RESOURCE_BUSY',
  'RESOURCE_DELETED',
  'RUN_NOT_TERMINAL',
  'DELETE_SCOPE_EXPANDED',
  'AUTH_FRESHNESS_OUT_OF_RANGE',
  'AUTH_VALIDATION_INCOMPLETE',
  'AUTH_PROFILE_REQUIRED',
  'AUTH_SCOPE_INVALID',
] as const
export type TargetErrorCode = (typeof TARGET_ERROR_CODES)[number]

export const targetCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/, '编码须为小写字母开头的 slug（2–63 字符）')

/**
 * 已落库的编码。创建仍走 targetCodeSchema；出站不能再用同一条正则打回，
 * 否则库里一条历史/夹具脏数据会让整个 GET /targets 变成 500。
 */
export const persistedTargetCodeSchema = z.string().min(1).max(256)

/**
 * `URL` 是浏览器与 Node 共有的 Web 标准全局，契约包不带 DOM lib，
 * 因此显式声明形状。取不到时下面的 refine 会抛错并判为非法——失败方向是拒绝，不是放行。
 */
const UrlCtor = (globalThis as unknown as { URL: new (input: string) => { username: string; password: string } })
  .URL

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'URL 须以 http:// 或 https:// 开头',
  })
  .refine((value) => {
    try {
      const parsed = new UrlCtor(value)
      return parsed.username === '' && parsed.password === ''
    } catch {
      return false
    }
  }, 'URL 不得内嵌凭据')

const optionalLoginUrlSchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}, httpUrlSchema.nullable().optional())

const targetPasswordSchema = z.string().min(1).max(256)

export const targetStatusSchema = z.enum(TARGET_STATUSES)
export const authMethodSchema = z.enum(AUTH_METHODS)
export const captchaModeSchema = z.enum(CAPTCHA_MODES)

export const targetSchema = z.object({
  id: z.string().min(1),
  code: persistedTargetCodeSchema,
  name: z.string().min(1),
  entryUrl: httpUrlSchema,
  loginUrl: z.string().nullable(),
  authMethod: authMethodSchema,
  captchaMode: captchaModeSchema,
  status: targetStatusSchema,
  loginFields: targetLoginFieldsDtoSchema,
  accountCount: z.number().int().nonnegative(),
  deletedAt: z.string().nullable().optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
  currentAuthProfileRevision: z.number().int().positive().nullable().optional(),
  sessionPolicy: sessionPolicyOverrideSchema.nullable().optional(),
  effectiveSessionPolicy: sessionPolicySchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type TargetDto = z.infer<typeof targetSchema>

export const targetListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: targetStatusSchema.optional(),
  authMethod: authMethodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type TargetListQuery = z.input<typeof targetListQuerySchema>

export const targetListResponseSchema = z.object({
  items: z.array(targetSchema),
  nextCursor: nextCursorSchema,
})
export type TargetListResponse = z.infer<typeof targetListResponseSchema>

export const targetAccountSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  displayName: z.string().min(1),
  username: z.string().min(1),
  hasPassword: z.boolean(),
  status: targetStatusSchema,
  expectedIdentity: z.string().trim().min(1).max(256).nullable().optional(),
  configRevision: z.number().int().positive().optional(),
  authCapability: z.enum(['IDENTITY_VERIFIED', 'LOGIN_VERIFIED', 'LEGACY']).optional(),
  lastAuthCheckedAt: z.string().nullable().optional(),
  lastAuthSuccessAt: z.string().nullable().optional(),
  lastAuthError: z.string().nullable().optional(),
  autoLoginPausedReason: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type TargetAccountDto = z.infer<typeof targetAccountSchema>

export const targetAccountListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: targetStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type TargetAccountListQuery = z.input<typeof targetAccountListQuerySchema>

export const targetAccountListResponseSchema = z.object({
  items: z.array(targetAccountSchema),
  nextCursor: nextCursorSchema,
})
export type TargetAccountListResponse = z.infer<typeof targetAccountListResponseSchema>

export const createTargetAccountBodySchema = z.strictObject({
  displayName: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(256),
  password: targetPasswordSchema.optional(),
  status: targetStatusSchema.default('active'),
})
export type CreateTargetAccountBody = z.infer<typeof createTargetAccountBodySchema>

export const createTargetBodySchema = z
  .strictObject({
    code: targetCodeSchema,
    name: z.string().trim().min(1).max(128),
    entryUrl: httpUrlSchema,
    loginUrl: optionalLoginUrlSchema,
    authMethod: authMethodSchema.default('password'),
    captchaMode: captchaModeSchema.default('none'),
    status: targetStatusSchema.default('active'),
    loginFields: loginFieldsInputSchema,
    account: createTargetAccountBodySchema.optional(),
  })
  .transform((body) => ({
    ...body,
    loginFields: body.loginFields === undefined ? null : body.loginFields,
  }))
export type CreateTargetBody = z.infer<typeof createTargetBodySchema>

export const updateTargetBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(128).optional(),
    entryUrl: httpUrlSchema.optional(),
    loginUrl: optionalLoginUrlSchema,
    authMethod: authMethodSchema.optional(),
    captchaMode: captchaModeSchema.optional(),
    status: targetStatusSchema.optional(),
    loginFields: loginFieldsInputSchema,
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.entryUrl !== undefined ||
      body.loginUrl !== undefined ||
      body.authMethod !== undefined ||
      body.captchaMode !== undefined ||
      body.status !== undefined ||
      body.loginFields !== undefined,
    { message: '至少提供一个要修改的字段' },
  )
export type UpdateTargetBody = z.infer<typeof updateTargetBodySchema>

export const updateTargetAccountBodySchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(128).optional(),
    username: z.string().trim().min(1).max(256).optional(),
    password: targetPasswordSchema.optional(),
    clearPassword: z.literal(true).optional(),
    status: targetStatusSchema.optional(),
  })
  .refine(
    (body) =>
      body.displayName !== undefined ||
      body.username !== undefined ||
      body.password !== undefined ||
      body.clearPassword !== undefined ||
      body.status !== undefined,
    { message: '至少提供一个要修改的字段' },
  )
  .refine((body) => !(body.password !== undefined && body.clearPassword === true), {
    message: 'password 与 clearPassword 不能同时给出',
  })
export type UpdateTargetAccountBody = z.infer<typeof updateTargetAccountBodySchema>
