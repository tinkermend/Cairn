import { z } from 'zod'
import { loginFieldsInputSchema, targetLoginFieldsDtoSchema } from './login-fields.js'
import { nextCursorSchema } from './rbac.js'

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
] as const
export type TargetErrorCode = (typeof TARGET_ERROR_CODES)[number]

export const targetCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/, '编码须为小写字母开头的 slug（2–63 字符）')

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
      const parsed = new URL(value)
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
  code: targetCodeSchema,
  name: z.string().min(1),
  entryUrl: httpUrlSchema,
  loginUrl: z.string().nullable(),
  authMethod: authMethodSchema,
  captchaMode: captchaModeSchema,
  status: targetStatusSchema,
  loginFields: targetLoginFieldsDtoSchema,
  accountCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type TargetDto = z.infer<typeof targetSchema>

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
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type TargetAccountDto = z.infer<typeof targetAccountSchema>

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
