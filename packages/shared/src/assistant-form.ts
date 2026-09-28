import { z } from 'zod'
import {
  AUTH_METHODS,
  AUTH_METHOD_LABELS,
  CAPTCHA_MODES,
  CAPTCHA_MODE_LABELS,
  TARGET_ACCENT_KEYS,
  TARGET_ICON_KEYS,
  TARGET_STATUSES,
  TARGET_STATUS_LABELS,
  httpUrlSchema,
  optionalLoginUrlSchema,
  targetCodeSchema,
  targetNameSchema,
} from './target.js'
import {
  LANDING_SETTLE_MODES,
  landingSettleModeSchema,
} from './landing-settle.js'
import { MAX_DURATION_MS, entityIdSchema } from './wire.js'

export const TARGET_CONFIG_FORM_ID = 'target-config' as const

export const assistantActiveFormSchema = z.strictObject({
  formId: z.string().min(1).max(100),
  mode: z.enum(['create', 'edit']),
  targetId: entityIdSchema.optional(),
  draftValues: z.record(z.string(), z.string()).optional(),
})
export type AssistantActiveForm = z.infer<typeof assistantActiveFormSchema>

export const TARGET_CONFIG_MAX_TIMEOUT_SECONDS = MAX_DURATION_MS / 1000

/** A form definition is executable: the same field rules feed validation, help, and AI proposals. */
export type AssistantFormField = {
  id: string
  label: string
  aliases: readonly string[]
  help: string
  requiredOnCreate: boolean
  readOnlyOnEdit?: boolean
  kind: 'text' | 'url' | 'seconds' | 'choice'
  blankMeaning?: string
  choices?: readonly string[]
  choiceLabels?: Readonly<Record<string, string>>
  schema: z.ZodType<string>
}

const optionalSeconds = z.string().refine((value) => {
  const trimmed = value.trim()
  if (trimmed === '') return true
  const seconds = Number(trimmed)
  return (
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= TARGET_CONFIG_MAX_TIMEOUT_SECONDS
  )
}, `须为 1–${TARGET_CONFIG_MAX_TIMEOUT_SECONDS} 的正整数秒，或留空用平台配置。`)

export const TARGET_CONFIG_FORM_FIELDS = [
  {
    id: 'name',
    label: '名称',
    aliases: ['系统名称'],
    help: '用于在识途中识别目标系统。',
    requiredOnCreate: true,
    kind: 'text',
    schema: targetNameSchema,
  },
  {
    id: 'code',
    label: '编码',
    aliases: ['系统编码', 'slug'],
    help: '系统唯一标识；小写字母开头，2–63 字符，创建后不可修改。',
    requiredOnCreate: true,
    readOnlyOnEdit: true,
    kind: 'text',
    schema: targetCodeSchema,
  },
  {
    id: 'entryUrl',
    label: '入口 URL',
    aliases: ['入口地址', '系统地址'],
    help: '打开目标业务系统时使用的入口地址，不代表系统身份。',
    requiredOnCreate: true,
    kind: 'url',
    schema: httpUrlSchema,
  },
  {
    id: 'loginUrl',
    label: '登录 URL',
    aliases: ['登录地址'],
    help: '登录页地址。',
    requiredOnCreate: false,
    kind: 'url',
    blankMeaning: '留空则与入口 URL 相同。',
    schema: z
      .string()
      .refine(
        (value) => optionalLoginUrlSchema.safeParse(value).success,
        '请填写不含账号密码的 http(s) URL，或留空。'
      ),
  },
  {
    id: 'loginLeaveTimeoutSeconds',
    label: '提交后等待离开登录页',
    aliases: ['登录页停留超时', '登录超时'],
    help: '自动填写并提交后，仍停在登录页超过此时间才判定登录未完成；跳转慢的系统可加大。单位为秒。',
    requiredOnCreate: false,
    kind: 'seconds',
    blankMeaning: '留空使用当前平台配置；不要推断为固定秒数。',
    schema: optionalSeconds,
  },
  {
    id: 'landingSettleMode',
    label: '登录后整理',
    aliases: ['欢迎层整理'],
    help: 'default 表示按平台策略整理欢迎层；off 表示不自动整理，换节点自动登录时也不会关闭欢迎层。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: LANDING_SETTLE_MODES,
    choiceLabels: { default: '按平台整理', off: '不自动整理' },
    schema: landingSettleModeSchema,
  },
  {
    id: 'landingSettleTimeoutSeconds',
    label: '整理预算',
    aliases: ['整理超时'],
    help: '覆盖平台的登录后整理时间预算。单位为秒。',
    requiredOnCreate: false,
    kind: 'seconds',
    blankMeaning: '留空使用当前平台配置；不要推断为固定秒数。',
    schema: optionalSeconds,
  },
  {
    id: 'authMethod',
    label: '认证方式',
    aliases: ['登录方式'],
    help: '目标系统的登录处理方式。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: AUTH_METHODS,
    choiceLabels: AUTH_METHOD_LABELS,
    schema: z.enum(AUTH_METHODS),
  },
  {
    id: 'captchaMode',
    label: '验证码',
    aliases: ['验证码方式'],
    help: '目标登录页使用的验证码类型。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: CAPTCHA_MODES,
    choiceLabels: CAPTCHA_MODE_LABELS,
    schema: z.enum(CAPTCHA_MODES),
  },
  {
    id: 'status',
    label: '状态',
    aliases: ['启用状态'],
    help: '目标系统在平台中的启用状态。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: TARGET_STATUSES,
    choiceLabels: TARGET_STATUS_LABELS,
    schema: z.enum(TARGET_STATUSES),
  },
  {
    id: 'iconKey',
    label: '图标',
    aliases: ['系统图标'],
    help: '目标系统在识途中的识别图标。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: TARGET_ICON_KEYS,
    schema: z.enum(TARGET_ICON_KEYS),
  },
  {
    id: 'accentKey',
    label: '身份色',
    aliases: ['系统颜色'],
    help: '目标系统在识途中的识别颜色。',
    requiredOnCreate: false,
    kind: 'choice',
    choices: TARGET_ACCENT_KEYS,
    schema: z.enum(TARGET_ACCENT_KEYS),
  },
] as const satisfies readonly AssistantFormField[]

export type TargetConfigAssistFieldId =
  (typeof TARGET_CONFIG_FORM_FIELDS)[number]['id']
export const targetConfigAssistFieldIdSchema = z.enum(
  TARGET_CONFIG_FORM_FIELDS.map((field) => field.id) as [
    TargetConfigAssistFieldId,
    ...TargetConfigAssistFieldId[],
  ]
)

export const targetConfigFormFieldSchemas = Object.fromEntries(
  TARGET_CONFIG_FORM_FIELDS.map((field) => [field.id, field.schema])
) as {
  [K in TargetConfigAssistFieldId]: Extract<
    (typeof TARGET_CONFIG_FORM_FIELDS)[number],
    { id: K }
  >['schema']
}

export function targetConfigFieldHelp(id: TargetConfigAssistFieldId): string {
  const field = TARGET_CONFIG_FORM_FIELDS.find((item) => item.id === id)!
  const choices =
    'choiceLabels' in field
      ? ` 可选：${Object.values(field.choiceLabels).join('、')}。`
      : ''
  return `${field.help}${'blankMeaning' in field ? ` ${field.blankMeaning}` : ''}${choices}`
}

export function targetConfigFieldValueLabel(
  id: TargetConfigAssistFieldId,
  value: string | undefined
): string {
  const field = TARGET_CONFIG_FORM_FIELDS.find((item) => item.id === id)!
  if (!value) return 'blankMeaning' in field ? field.blankMeaning : '留空'
  const labels: Readonly<Record<string, string>> | undefined =
    'choiceLabels' in field ? field.choiceLabels : undefined
  return labels?.[value] ?? value
}

export const targetFormProposalChangeSchema = z.strictObject({
  fieldId: targetConfigAssistFieldIdSchema,
  value: z.string().max(2048),
})
export type TargetFormProposalChange = z.infer<
  typeof targetFormProposalChangeSchema
>

export const targetFormProposalSchema = z.strictObject({
  kind: z.literal('target_form'),
  mode: z.enum(['create', 'edit']),
  targetId: z.string().uuid().optional(),
  summary: z.string().min(1).max(1024),
  changes: z.array(targetFormProposalChangeSchema).min(1).max(16),
  pendingFields: z.array(targetConfigAssistFieldIdSchema).optional(),
  clarifyPrompt: z.string().max(256).optional(),
})
export type TargetFormProposal = z.infer<typeof targetFormProposalSchema>

export const SUSPICIOUS_DUMMY_URL_PATTERNS = [
  /example\.(com|org|net)/i,
  /test\.(com|cn)/i,
  /待补充/i,
  /placeholder/i,
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i,
]

export function sanitizeProposalChanges(
  changes: TargetFormProposalChange[],
  mode: 'create' | 'edit'
): {
  cleanChanges: TargetFormProposalChange[]
  detectedPendingFields: TargetConfigAssistFieldId[]
} {
  const cleanChanges: TargetFormProposalChange[] = []
  const detectedPendingFields: TargetConfigAssistFieldId[] = []

  for (const change of changes) {
    if (change.fieldId === 'entryUrl' || change.fieldId === 'loginUrl') {
      const isDummy = SUSPICIOUS_DUMMY_URL_PATTERNS.some((pat) =>
        pat.test(change.value)
      )
      if (isDummy) {
        if (
          change.fieldId === 'entryUrl' &&
          !detectedPendingFields.includes('entryUrl')
        ) {
          detectedPendingFields.push('entryUrl')
        }
        continue
      }
    }
    const issue = validateTargetFormProposalChange(change, mode)
    if (!issue) {
      cleanChanges.push(change)
    }
  }

  if (
    mode === 'create' &&
    !cleanChanges.some((c) => c.fieldId === 'entryUrl')
  ) {
    if (!detectedPendingFields.includes('entryUrl')) {
      detectedPendingFields.push('entryUrl')
    }
  }

  return { cleanChanges, detectedPendingFields }
}

export function validateTargetFormProposalChange(
  change: TargetFormProposalChange,
  mode: 'create' | 'edit'
): string | null {
  const field = TARGET_CONFIG_FORM_FIELDS.find(
    (item) => item.id === change.fieldId
  )
  if (!field) return '未知字段'
  if (mode === 'edit' && 'readOnlyOnEdit' in field && field.readOnlyOnEdit) {
    return `${field.label}在编辑时不可修改`
  }
  const result = field.schema.safeParse(change.value)
  return result.success
    ? null
    : (result.error.issues[0]?.message ?? `${field.label}格式不合法`)
}

