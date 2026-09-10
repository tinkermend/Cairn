import { z } from 'zod'

export const LOGIN_LOCATOR_BY = ['id', 'name', 'css'] as const
export type LoginLocatorBy = (typeof LOGIN_LOCATOR_BY)[number]

export const LOGIN_HEURISTIC_VERSION = 1

export const loginLocatorSchema = z.strictObject({
  by: z.enum(LOGIN_LOCATOR_BY),
  value: z.string().trim().min(1).max(256),
})
export type LoginLocator = z.infer<typeof loginLocatorSchema>

const locatorInputSchema = z.preprocess((value) => {
  if (value == null) return undefined
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const raw = (value as { value: unknown }).value
    if (typeof raw === 'string' && raw.trim() === '') return undefined
  }
  return value
}, loginLocatorSchema.optional())

export const targetLoginFieldsObjectSchema = z.strictObject({
  username: locatorInputSchema,
  password: locatorInputSchema,
  submit: locatorInputSchema,
})
export type TargetLoginFields = {
  username?: LoginLocator
  password?: LoginLocator
  submit?: LoginLocator
}

export function compactLoginFields(
  fields: TargetLoginFields | null | undefined,
): TargetLoginFields | null {
  if (!fields) return null
  const next: TargetLoginFields = {}
  if (fields.username) next.username = fields.username
  if (fields.password) next.password = fields.password
  if (fields.submit) next.submit = fields.submit
  return next.username || next.password || next.submit ? next : null
}

/** GET / 持久化：始终是对象或 null。 */
export const targetLoginFieldsDtoSchema = z
  .object({
    username: loginLocatorSchema.optional(),
    password: loginLocatorSchema.optional(),
    submit: loginLocatorSchema.optional(),
  })
  .nullable()
  .transform((fields) => compactLoginFields(fields))

/** 请求体：省略保持 undefined；null / {} / 空 value 归一为 null。 */
export const loginFieldsInputSchema = z
  .union([z.null(), targetLoginFieldsObjectSchema])
  .optional()
  .transform((fields) => (fields === undefined ? undefined : compactLoginFields(fields)))

export const LOGIN_FIELD_HEURISTICS = {
  username: [
    { by: 'id', value: 'username' },
    { by: 'id', value: 'user' },
    { by: 'id', value: 'account' },
    { by: 'id', value: 'loginName' },
    { by: 'id', value: 'login-name' },
    { by: 'name', value: 'username' },
    { by: 'name', value: 'user' },
    { by: 'name', value: 'account' },
    { by: 'css', value: 'input[autocomplete="username"]' },
    { by: 'css', value: 'input[type="email"]' },
  ],
  password: [
    { by: 'id', value: 'password' },
    { by: 'id', value: 'passwd' },
    { by: 'id', value: 'pwd' },
    { by: 'name', value: 'password' },
    { by: 'css', value: 'input[autocomplete="current-password"]' },
    { by: 'css', value: 'input[type="password"]' },
  ],
  submit: [
    { by: 'css', value: 'button[type="submit"]' },
    { by: 'css', value: 'input[type="submit"]' },
    { by: 'id', value: 'login' },
    { by: 'id', value: 'submit' },
    { by: 'name', value: 'login' },
  ],
} as const satisfies Record<'username' | 'password' | 'submit', readonly LoginLocator[]>
