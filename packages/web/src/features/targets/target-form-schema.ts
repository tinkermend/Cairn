import { z } from 'zod'
import {
  DEFAULT_TARGET_ACCENT_KEY,
  DEFAULT_TARGET_ICON_KEY,
  LOGIN_LOCATOR_BY,
  compactLoginFields,
  targetConfigFormFieldSchemas,
  type CreateTargetAccountBody,
  type LoginLocatorBy,
  type TargetCaptchaDefinition,
  type TargetDto,
  type TargetLoginFields,
} from '@cairn/shared'

export const targetFormSchema = z
  .object({
    ...targetConfigFormFieldSchemas,
    accountDisplayName: z.string(),
    accountUsername: z.string(),
    accountPassword: z.string(),
    validityMode: z.enum(['days', 'months', 'permanent']),
    validityAmount: z.string(),
    validityTimeZone: z.string(),
    usernameBy: z.enum(LOGIN_LOCATOR_BY),
    usernameValue: z.string(),
    passwordBy: z.enum(LOGIN_LOCATOR_BY),
    passwordValue: z.string(),
    submitBy: z.enum(LOGIN_LOCATOR_BY),
    submitValue: z.string(),
    captchaImageBy: z.enum(LOGIN_LOCATOR_BY),
    captchaImageValue: z.string(),
    captchaInputBy: z.enum(LOGIN_LOCATOR_BY),
    captchaInputValue: z.string(),
    captchaKnobBy: z.enum(LOGIN_LOCATOR_BY),
    captchaKnobValue: z.string(),
    captchaBgBy: z.enum(LOGIN_LOCATOR_BY),
    captchaBgValue: z.string(),
    sensitiveSelectors: z.string(),
  })
  .superRefine((values, ctx) => {
    const hasAny =
      values.accountDisplayName.trim() !== '' ||
      values.accountUsername.trim() !== '' ||
      values.accountPassword.trim() !== ''
    if (!hasAny) return
    if (values.accountDisplayName.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['accountDisplayName'],
        message: '填写首个账号时请给出显示名。',
      })
    }
    if (values.accountUsername.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUsername'],
        message: '填写首个账号时请给出登录名。',
      })
    }
  })

// Persisted legacy codes can predate today's create-time slug rule. The field
// is disabled in edit mode and is never sent by updateTarget.
export const targetEditFormSchema = targetFormSchema.safeExtend({ code: z.string() })

export type TargetFormValues = z.infer<typeof targetFormSchema>

export const EMPTY_TARGET_FORM_VALUES: TargetFormValues = {
  code: '',
  name: '',
  entryUrl: '',
  loginUrl: '',
  loginLeaveTimeoutSeconds: '',
  landingSettleMode: 'default',
  landingSettleTimeoutSeconds: '',
  authMethod: 'password',
  captchaMode: 'none',
  status: 'active',
  iconKey: DEFAULT_TARGET_ICON_KEY,
  accentKey: DEFAULT_TARGET_ACCENT_KEY,
  accountDisplayName: '',
  accountUsername: '',
  accountPassword: '',
  validityMode: 'days',
  validityAmount: '90',
  validityTimeZone: 'Asia/Shanghai',
  usernameBy: 'id',
  usernameValue: '',
  passwordBy: 'id',
  passwordValue: '',
  submitBy: 'id',
  submitValue: '',
  captchaImageBy: 'css',
  captchaImageValue: '',
  captchaInputBy: 'css',
  captchaInputValue: '',
  captchaKnobBy: 'css',
  captchaKnobValue: '',
  captchaBgBy: 'css',
  captchaBgValue: '',
  sensitiveSelectors: '',
}

export function locatorFromForm(by: LoginLocatorBy, value: string) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : { by, value: trimmed }
}

export function loginLeaveTimeoutFromForm(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed > 0 ? parsed * 1000 : null
}

export function loginLeaveTimeoutToForm(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return ''
  return String(Math.round(ms / 1000))
}

export function formatLoginLeaveTimeout(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`
}

export function loginFieldsFromForm(values: TargetFormValues): TargetLoginFields | null {
  return compactLoginFields({
    username: locatorFromForm(values.usernameBy, values.usernameValue),
    password: locatorFromForm(values.passwordBy, values.passwordValue),
    submit: locatorFromForm(values.submitBy, values.submitValue),
  })
}

export function captchaFromForm(values: TargetFormValues): TargetCaptchaDefinition | null {
  if (values.captchaMode === 'image') {
    const imageLocator = locatorFromForm(values.captchaImageBy, values.captchaImageValue)
    const inputLocator = locatorFromForm(values.captchaInputBy, values.captchaInputValue)
    if (imageLocator && inputLocator) {
      return { type: 'IMAGE', image: { imageLocator, inputLocator } }
    }
    return { type: 'AUTO' }
  }
  if (values.captchaMode === 'slider') {
    const knobLocator = locatorFromForm(values.captchaKnobBy, values.captchaKnobValue)
    const bgLocator = locatorFromForm(values.captchaBgBy, values.captchaBgValue)
    if (knobLocator) {
      return {
        type: 'SLIDER',
        slider: {
          knobLocator,
          ...(bgLocator ? { bgLocator } : {}),
          mode: 'TRACK',
        },
      }
    }
    return { type: 'AUTO' }
  }
  return null
}

export function accountFromForm(
  values: TargetFormValues
): CreateTargetAccountBody | undefined {
  const displayName = values.accountDisplayName.trim()
  const username = values.accountUsername.trim()
  const password = values.accountPassword
  if (!displayName && !username && password.trim() === '') return undefined
  return {
    displayName,
    username,
    status: 'active',
    usage: 'business',
    ...(password.trim() === ''
      ? {}
      : {
          password,
          validity: {
            mode: values.validityMode,
            ...(values.validityMode === 'permanent'
              ? {}
              : { amount: Number(values.validityAmount), timeZone: values.validityTimeZone }),
            startedAt: new Date().toISOString(),
          },
        }),
  }
}

export function valuesFromTarget(current: TargetDto): TargetFormValues {
  return {
    ...EMPTY_TARGET_FORM_VALUES,
    code: current.code,
    name: current.name,
    entryUrl: current.entryUrl,
    loginUrl: current.loginUrl ?? '',
    loginLeaveTimeoutSeconds: loginLeaveTimeoutToForm(current.loginLeaveTimeoutMs),
    landingSettleMode: current.landingSettleMode ?? 'default',
    landingSettleTimeoutSeconds: loginLeaveTimeoutToForm(current.landingSettleTimeoutMs),
    authMethod: current.authMethod,
    captchaMode: current.captchaMode,
    status: current.status,
    iconKey: current.iconKey ?? DEFAULT_TARGET_ICON_KEY,
    accentKey: current.accentKey ?? DEFAULT_TARGET_ACCENT_KEY,
    usernameBy: current.loginFields?.username?.by ?? 'id',
    usernameValue: current.loginFields?.username?.value ?? '',
    passwordBy: current.loginFields?.password?.by ?? 'id',
    passwordValue: current.loginFields?.password?.value ?? '',
    submitBy: current.loginFields?.submit?.by ?? 'id',
    submitValue: current.loginFields?.submit?.value ?? '',
    captchaImageBy: current.captcha?.image?.imageLocator.by ?? 'css',
    captchaImageValue: current.captcha?.image?.imageLocator.value ?? '',
    captchaInputBy: current.captcha?.image?.inputLocator.by ?? 'css',
    captchaInputValue: current.captcha?.image?.inputLocator.value ?? '',
    captchaKnobBy: current.captcha?.slider?.knobLocator?.by ?? 'css',
    captchaKnobValue: current.captcha?.slider?.knobLocator?.value ?? '',
    captchaBgBy: current.captcha?.slider?.bgLocator?.by ?? 'css',
    captchaBgValue: current.captcha?.slider?.bgLocator?.value ?? '',
    sensitiveSelectors: (current.sensitiveSelectors ?? []).join('\n'),
  }
}

export function selectorsFromForm(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 32)
}

export function hasAnyLoginField(
  fields: TargetLoginFields | null | undefined
): boolean {
  return Boolean(fields?.username || fields?.password || fields?.submit)
}

export function hasCaptchaLocator(captcha: TargetCaptchaDefinition | null | undefined): boolean {
  return Boolean(
    captcha?.image?.imageLocator.value ||
      captcha?.image?.inputLocator.value ||
      captcha?.slider?.knobLocator?.value ||
      captcha?.slider?.bgLocator?.value,
  )
}

export function countConfiguredLocators(values: TargetFormValues): number {
  let count = 0
  if (values.usernameValue.trim()) count++
  if (values.passwordValue.trim()) count++
  if (values.submitValue.trim()) count++
  if (values.captchaMode === 'image') {
    if (values.captchaImageValue.trim()) count++
    if (values.captchaInputValue.trim()) count++
  }
  if (values.captchaMode === 'slider') {
    if (values.captchaKnobValue.trim()) count++
    if (values.captchaBgValue.trim()) count++
  }
  return count
}
