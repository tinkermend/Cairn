import { z } from 'zod'
import { mapIngestCursorSchema, mapIngestScopeSchema, mapMenuEntrySchema } from './map-ingest.js'
import { mapJobPolicySchema } from './map-jobs.js'
import { assertExpectSchema, extractManySchema, type ExtractMany } from './browser-command.js'
import { pageAfterSchema } from './managed-browser.js'
import { aiOutputSchemaSchema, outputFieldNameSchema } from './output-schema.js'
import { executionErrorCategorySchema } from './runtime-error.js'
import { resolutionPolicySchema } from './resolution-policy.js'
import { locatorPlanSchema } from './locator-plan.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { durationMsSchema, entityIdSchema, jsonValueSchema, timeoutMsSchema, utcInstantSchema } from './wire.js'
import { runFileHandleSchema } from './run-file.js'
import { objectDigestSchema } from './object-store.js'
import { dataGeneratorSpecSchema, type DataGeneratorSpec } from './data-generator.js'
import {
  conditionSchema,
  exprSchema,
  validateSafeRegexPattern,
} from './expression.js'

/**
 * 可执行 Step。枚举即注册表：没写进这里的 type 过不了 `stepSchema`。
 *
 * 能力闸门另走 Compiler 的 executableTypes / GET capabilities，不靠从枚举里拿掉类型。
 */
export const FIXTURE_STEP_TYPES = ['echo', 'delay', 'fail'] as const
export const BROWSER_STEP_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'assert',
  'select',
  'keyboard',
  'wait',
  'download',
  'upload',
  'probe',
  'map_ingest',
] as const
export const AI_STEP_TYPES = ['ai_action', 'ai_extract', 'ai_assert'] as const
export const SYSTEM_STEP_TYPES = ['verify_context', 'decide', 'compute', 'loop'] as const
export const EXECUTABLE_STEP_TYPES = [
  ...FIXTURE_STEP_TYPES,
  ...BROWSER_STEP_TYPES,
  ...AI_STEP_TYPES,
  ...SYSTEM_STEP_TYPES,
] as const

export const OPTIONAL_ALLOWED_STEP_TYPES = [
  'click',
  'fill',
  'select',
  'keyboard',
  'extract',
] as const
export type OptionalAllowedStepType = (typeof OPTIONAL_ALLOWED_STEP_TYPES)[number]
export type FixtureStepType = (typeof FIXTURE_STEP_TYPES)[number]
export type BrowserStepType = (typeof BROWSER_STEP_TYPES)[number]
export type AiStepType = (typeof AI_STEP_TYPES)[number]
export type SystemStepType = (typeof SYSTEM_STEP_TYPES)[number]
export type ExecutableStepType = (typeof EXECUTABLE_STEP_TYPES)[number]
export const executableStepTypeSchema = z.enum(EXECUTABLE_STEP_TYPES)

export function isExecutableStepType(type: string): type is ExecutableStepType {
  return (EXECUTABLE_STEP_TYPES as readonly string[]).includes(type)
}

export function isSystemStepType(type: string): type is SystemStepType {
  return (SYSTEM_STEP_TYPES as readonly string[]).includes(type)
}

/** 调试夹具步骤：不碰浏览器，结果由入参直接决定，只用于排查编排本身。 */
export function isFixtureStepType(type: string): type is FixtureStepType {
  return (FIXTURE_STEP_TYPES as readonly string[]).includes(type)
}

export function isBrowserStepType(type: string): type is BrowserStepType {
  return (BROWSER_STEP_TYPES as readonly string[]).includes(type)
}

export function isAiStepType(type: string): type is AiStepType {
  return (AI_STEP_TYPES as readonly string[]).includes(type)
}

/** 需要受管 Page / Session 的步骤：确定性浏览器命令与三类 AI。 */
export function stepUsesBrowser(type: string): boolean {
  return isBrowserStepType(type) || isAiStepType(type)
}

export function hasAiSteps(steps: readonly { type: string }[]): boolean {
  return steps.some((step) => isAiStepType(step.type))
}

export const EFFECT_TYPES = ['READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT'] as const
export type EffectType = (typeof EFFECT_TYPES)[number]
export const effectTypeSchema = z.enum(EFFECT_TYPES)

/** context 写入名 / Echo.from。只校验形状，key 是否已存在由 Engine 检查。 */
export const contextKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, 'context key 须为字母开头的标识符，最长 128')

/** input / context 键不得踩到原型链上的保留名。`contextKeySchema` 挡不住 `constructor`。 */
export const FORBIDDEN_CONTEXT_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
] as const

export const executionPolicySchema = z.strictObject({
  timeoutMs: timeoutMsSchema.optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  resolution: resolutionPolicySchema.optional(),
  locatorPlan: locatorPlanSchema.optional(),
  deepLocate: z.boolean().optional(),
}).refine((value) => !(value.resolution && value.locatorPlan), '同一步骤不能同时设置旧版与新版定位策略')
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>

/** Delay 上限 5 分钟：这是测试夹具，不是平台超时上限。 */
export const MAX_DELAY_MS = 300_000

export const echoInputSchema = z
  .strictObject({
    value: jsonValueSchema.optional(),
    from: contextKeySchema.optional(),
    fromField: outputFieldNameSchema.optional(),
  })
  .refine((input) => (input.value !== undefined) !== (input.from !== undefined), {
    message: 'echo 必须恰好提供 value 或 from 其中一个',
  })
  .refine((input) => input.fromField === undefined || input.from !== undefined, {
    message: 'fromField 仅在提供 from 时合法',
  })
export type EchoInput = z.infer<typeof echoInputSchema>

export const delayInputSchema = z.strictObject({
  durationMs: durationMsSchema.max(MAX_DELAY_MS),
})
export type DelayInput = z.infer<typeof delayInputSchema>

export const failInputSchema = z.strictObject({
  message: z.string().min(1).max(1024),
  code: z.string().min(1).max(128).optional(),
  category: executionErrorCategorySchema.optional(),
  retryable: z.boolean().optional(),
})
export type FailInput = z.infer<typeof failInputSchema>

export const MODULE_BINDABLE_FIELDS = [
  'navigate.url',
  'target.anchor.withinText',
  'target.candidate.name',
  'target.candidate.value',
  'assert.expect.value',
] as const
export type ModuleBindableField = (typeof MODULE_BINDABLE_FIELDS)[number]
export const moduleBindableFieldSchema = z.enum(MODULE_BINDABLE_FIELDS)

export const stepFieldRefSchema = z.strictObject({
  from: contextKeySchema,
  fromField: outputFieldNameSchema.optional(),
})
export type StepFieldRef = z.infer<typeof stepFieldRefSchema>

const stepCommon = {
  id: entityIdSchema,
  name: z.string().min(1).max(128),
  effectType: effectTypeSchema,
  disabled: z.boolean().optional(),
  optional: z.boolean().optional(),
  outputKey: contextKeySchema.optional(),
  policy: executionPolicySchema.optional(),
  fieldRefs: z.record(z.string(), stepFieldRefSchema).optional(),
}

export const echoStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('echo'),
  input: echoInputSchema,
})
export const delayStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('delay'),
  input: delayInputSchema,
})
export const failStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('fail'),
  input: failInputSchema,
})

export const navigateInputSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
})
export type NavigateInput = z.infer<typeof navigateInputSchema>

export { pageAfterSchema, type PageAfter } from './managed-browser.js'

export const clickInputSchema = z.strictObject({
  target: targetDescriptorSchema,
  /** 缺省保持旧行为：可等待 popup 但不收养为当前页。 */
  pageAfter: pageAfterSchema.optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
})
export type ClickInput = z.infer<typeof clickInputSchema>

export const fillInputSchema = z
  .strictObject({
    target: targetDescriptorSchema,
    value: z.string().max(16_384).optional(),
    from: contextKeySchema.optional(),
    fromField: outputFieldNameSchema.optional(),
    /** 作者声明敏感。只打码该步 input 证据，不并进后续步骤的替换集。 */
    sensitive: z.boolean().optional(),
  })
  .refine((input) => (input.value !== undefined) !== (input.from !== undefined), {
    message: 'fill 必须恰好提供 value 或 from 其中一个',
  })
  .refine((input) => input.fromField === undefined || input.from !== undefined, {
    message: 'fromField 仅在提供 from 时合法',
  })
export type FillInput = z.infer<typeof fillInputSchema>

export const extractInputSchema = z
  .strictObject({
    target: targetDescriptorSchema,
    as: z.enum(['text', 'value', 'attribute']),
    attribute: z.string().trim().min(1).max(128).optional(),
    many: extractManySchema.optional(),
  })
  .refine((input) => input.as !== 'attribute' || Boolean(input.attribute), {
    message: 'extract as=attribute 时必须提供 attribute',
  })
export type ExtractInput = z.infer<typeof extractInputSchema>

export const assertInputSchema = z.strictObject({
  target: targetDescriptorSchema.optional(),
  expect: assertExpectSchema,
})
export type AssertInput = z.infer<typeof assertInputSchema>

export const navigateStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('navigate'),
  input: navigateInputSchema,
})
export const clickStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('click'),
  input: clickInputSchema,
})
export const fillStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('fill'),
  input: fillInputSchema,
})
export const extractStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('extract'),
  input: extractInputSchema,
})
export const assertStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('assert'),
  input: assertInputSchema,
})

export const selectStepInputSchema = z
  .strictObject({
    target: targetDescriptorSchema,
    by: z.enum(['label', 'value', 'index']),
    value: z.string().optional(),
    from: contextKeySchema.optional(),
    fromField: outputFieldNameSchema.optional(),
    index: z.number().int().min(0).optional(),
  })
  .refine(
    (input) => {
      if (input.by === 'index') {
        return input.index !== undefined && input.value === undefined && input.from === undefined
      }
      return (input.value !== undefined) !== (input.from !== undefined)
    },
    { message: 'select by=index 时须提供 index；by=label/value 时须提供 value 或 from 之一' },
  )
  .refine((input) => input.fromField === undefined || input.from !== undefined, {
    message: 'fromField 仅在提供 from 时合法',
  })
export type SelectInput = z.infer<typeof selectStepInputSchema>

export const KEY_BASE_ENUM = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
] as const

export const KEY_MODIFIER_ENUM = ['Control', 'Meta', 'Alt', 'Shift'] as const

export const keyComboSchema = z.string().regex(
  /^(Control|Meta|Alt|Shift)\+([A-Za-z0-9]|Enter|Tab|Escape|Backspace|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$|^(Enter|Tab|Escape|Backspace|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/,
  '按键必须属于封闭枚举（如 Enter, Tab, ArrowDown，或带单修饰键 Control+s, Shift+Tab 等）',
)
export type KeyCombo = z.infer<typeof keyComboSchema>

export const keyboardInputSchema = z.strictObject({
  target: targetDescriptorSchema.optional(),
  keys: z.array(keyComboSchema).min(1).max(4),
})
export type KeyboardInput = z.infer<typeof keyboardInputSchema>

export const WAIT_KINDS = ['time', 'visible', 'hidden', 'url', 'text', 'semantic'] as const
export const waitKindSchema = z.enum(WAIT_KINDS)
export type WaitKind = (typeof WAIT_KINDS)[number]

export const waitInputSchema = z
  .strictObject({
    kind: waitKindSchema,
    target: targetDescriptorSchema.optional(),
    urlPattern: z.string().trim().min(1).max(2048).optional(),
    text: z.string().min(1).max(1024).optional(),
    durationMs: durationMsSchema.max(60_000).optional(),
    timeoutMs: timeoutMsSchema.optional(),
  })
  .refine(
    (input) => {
      if (input.kind === 'time') return input.durationMs !== undefined && input.durationMs > 0
      if (input.kind === 'url') return Boolean(input.urlPattern)
      if (input.kind === 'text') return Boolean(input.target && input.text)
      if (input.kind === 'visible' || input.kind === 'hidden') return Boolean(input.target)
      if (input.kind === 'semantic') return Boolean(input.text)
      return true
    },
    {
      message:
        'wait 步骤必须根据 kind 提供对应条件（time 提供 durationMs ≤ 60s；visible/hidden 提供 target；url 提供 urlPattern；text 提供 target 和 text；semantic 提供 text）',
    },
  )
export type WaitInput = z.infer<typeof waitInputSchema>

export const selectStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('select'),
  input: selectStepInputSchema,
})
export const keyboardStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('keyboard'),
  input: keyboardInputSchema,
})
export const waitStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('wait'),
  effectType: z.literal('READ_ONLY'),
  input: waitInputSchema,
})

export const downloadInputSchema = z.strictObject({
  /** 给定则点击它触发下载；省略则等待前序步骤已触发、尚未落地的下载。 */
  target: targetDescriptorSchema.optional(),
  /** 等待 download 事件的预算，缺省 30s，上限 120s。 */
  waitMs: z.number().int().min(1_000).max(120_000).optional(),
  /** 可选校验：不满足即失败，避免把错误页存成"成功下载"。 */
  expect: z
    .strictObject({
      /** 受限正则（无回溯构造），编译期校验可编译。 */
      fileNamePattern: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .superRefine((pat, ctx) => {
          if (!pat) return
          const res = validateSafeRegexPattern(pat)
          if (!res.valid) {
            ctx.addIssue({ code: 'custom', message: res.reason })
          }
        }),
      minBytes: z.number().int().positive().optional(),
    })
    .optional(),
})
export type DownloadInput = z.infer<typeof downloadInputSchema>

export const downloadStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('download'),
  input: downloadInputSchema,
})
export type DownloadStep = z.infer<typeof downloadStepSchema>

export const downloadStepOutputSchema = runFileHandleSchema

export const uploadAssetSourceSchema = z.strictObject({
  source: z.literal('asset'),
  fixtureId: entityIdSchema,
  /** 编写期写入的夹具摘要。运行期比对不一致即失败，保证历史版本可复盘。 */
  digest: objectDigestSchema,
  /** 可选重命名注入的文件名；省略时用夹具登记名。 */
  name: z.string().min(1).max(255).optional(),
})
export type UploadAssetSource = z.infer<typeof uploadAssetSourceSchema>

export const uploadContextSourceSchema = z.strictObject({
  source: z.literal('context'),
  from: contextKeySchema,
  /** 前序步骤输出为对象时，取其中的句柄字段。 */
  fromField: outputFieldNameSchema.optional(),
  name: z.string().min(1).max(255).optional(),
})
export type UploadContextSource = z.infer<typeof uploadContextSourceSchema>

export const uploadFileItemSchema = z.discriminatedUnion('source', [
  uploadAssetSourceSchema,
  uploadContextSourceSchema,
])
export type UploadFileItem = z.infer<typeof uploadFileItemSchema>

export const uploadInputSchema = z.strictObject({
  target: targetDescriptorSchema,
  files: z.array(uploadFileItemSchema).min(1).max(10),
})
export type UploadInput = z.infer<typeof uploadInputSchema>

export const uploadStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('upload'),
  input: uploadInputSchema,
})
export type UploadStep = z.infer<typeof uploadStepSchema>

export const uploadStepOutputSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      name: z.string(),
      byteSize: z.number().int().nonnegative(),
      mimeType: z.string(),
      digest: objectDigestSchema,
    }),
  ),
  method: z.enum(['dom_direct', 'file_chooser']),
  uploadedAt: utcInstantSchema,
})
export type UploadStepOutput = z.infer<typeof uploadStepOutputSchema>

export const aiInstructionSchema = z.string().trim().min(1).max(4096)

export const AI_ATOMIC_ACTIONS_PROTOCOL = 'ai.atomic-actions@1' as const
export const LIST_OUTPUT_PROTOCOL = 'output.list@1' as const

export const aiAtomicInputSchema = z.strictObject({
  operation: z.literal('input'),
  targetDescription: aiInstructionSchema,
  mode: z.enum(['replace', 'type_only', 'clear']),
  value: z.string().max(16_384).optional(),
  from: contextKeySchema.optional(),
  fromField: outputFieldNameSchema.optional(),
}).superRefine((input, ctx) => {
  if (input.mode === 'clear') {
    if (input.value !== undefined || input.from !== undefined || input.fromField !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'clear 不允许提供 value/from/fromField' })
    }
  } else if ((input.value !== undefined) === (input.from !== undefined) || input.value === '') {
    ctx.addIssue({ code: 'custom', message: 'AI 输入必须提供非空 value 或 from 之一；清空请使用 clear' })
  }
  if (input.fromField !== undefined && input.from === undefined) {
    ctx.addIssue({ code: 'custom', message: 'fromField 仅在提供 from 时合法' })
  }
})

export const aiAtomicActionInputSchema = z.union([
  z.strictObject({ operation: z.literal('tap'), targetDescription: aiInstructionSchema }),
  aiAtomicInputSchema,
  z.strictObject({ operation: z.literal('keyboard'), key: keyComboSchema, targetDescription: aiInstructionSchema.optional() }),
  z.strictObject({
    operation: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    distance: z.number().int().min(1).max(10_000),
    targetDescription: aiInstructionSchema.optional(),
  }),
])
export type AiAtomicActionInput = z.infer<typeof aiAtomicActionInputSchema>

// Legacy instruction objects retain their exact shape (no new defaults).
export const aiActionInputSchema = z.union([
  z.strictObject({ instruction: aiInstructionSchema }),
  aiAtomicActionInputSchema,
])
export type AiActionInput = z.infer<typeof aiActionInputSchema>

export const aiExtractInputSchema = z.strictObject({
  instruction: aiInstructionSchema,
  outputSchema: aiOutputSchemaSchema,
})
export type AiExtractInput = z.infer<typeof aiExtractInputSchema>

export const aiAssertInputSchema = z.strictObject({
  instruction: aiInstructionSchema,
})
export type AiAssertInput = z.infer<typeof aiAssertInputSchema>

export const contextBindingSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, '绑定名须为字母开头的标识符')
    .refine((val) => !['__proto__', 'constructor', 'prototype'].includes(val), '非法绑定名'),
  source: z
    .string()
    .regex(/^(input|steps)\.[A-Za-z0-9_.-]+$/, '数据源格式须为 input.<key> 或 steps.<stepId>.<field>')
    .refine((val) => !val.includes('__proto__') && !val.includes('constructor') && !val.includes('prototype'), '不能包含原型属性'),
  path: z
    .string()
    .min(1)
    .max(256)
    .refine((val) => !val.includes('__proto__') && !val.includes('constructor') && !val.includes('prototype'), '不能包含原型属性'),
  required: z.boolean().default(true),
  projection: z.enum(['value', 'list_sample', 'summary']).optional(),
})
export type ContextBinding = z.infer<typeof contextBindingSchema>

const aiActionStepBase = z.strictObject({
  ...stepCommon,
  type: z.literal('ai_action'),
  effectType: z.literal('SIDE_EFFECT'),
  input: aiActionInputSchema,
  contextBindings: z.array(contextBindingSchema).optional(),
})
export const aiActionStepSchema = aiActionStepBase.superRefine((step, ctx) => {
  if ((step.policy?.retryLimit ?? 0) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['policy', 'retryLimit'],
      message: 'ai_action 不允许自动重试',
    })
  }
})

export const aiExtractStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('ai_extract'),
  effectType: z.literal('READ_ONLY'),
  input: aiExtractInputSchema,
  contextBindings: z.array(contextBindingSchema).optional(),
})

export const aiAssertStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('ai_assert'),
  effectType: z.literal('READ_ONLY'),
  input: aiAssertInputSchema,
  contextBindings: z.array(contextBindingSchema).optional(),
})

export const verifyContextInputSchema = z.strictObject({
  keys: z.array(contextKeySchema).min(1).max(32),
})
export type VerifyContextInput = z.infer<typeof verifyContextInputSchema>

export const verifyContextStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('verify_context'),
  effectType: z.literal('READ_ONLY'),
  input: verifyContextInputSchema,
})
export type VerifyContextStep = z.infer<typeof verifyContextStepSchema>


export const probeInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('element'),
    target: targetDescriptorSchema,
    state: z.enum(['visible', 'present']).default('visible'),
    waitMs: z.number().int().min(0).max(30_000).default(2000),
  }),
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().min(1).max(1024),
    target: targetDescriptorSchema.optional(),
    waitMs: z.number().int().min(0).max(30_000).default(2000),
  }),
  z.strictObject({
    kind: z.literal('url'),
    urlPattern: z.string().min(1).max(2048),
    waitMs: z.number().int().min(0).max(30_000).default(2000),
  }),
])
export type ProbeInput = z.infer<typeof probeInputSchema>

export const probeStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('probe'),
  effectType: z.literal('READ_ONLY'),
  input: probeInputSchema,
})

export const mapIngestStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('map_ingest'),
  effectType: z.literal('READ_ONLY'),
  input: z.strictObject({
    jobId: entityIdSchema,
    startUrl: z.string().url().max(2048),
    scope: mapIngestScopeSchema,
    entries: z.array(mapMenuEntrySchema).max(64),
    cursor: mapIngestCursorSchema.nullable(),
    policy: mapJobPolicySchema,
    allowedSpaHashPrefixes: z.array(z.string().min(1).max(64)).max(16).default(['#/']),
    ignoreQueryParams: z.array(z.string().min(1).max(64)).max(64).optional(),
    sliceWorkSeconds: z.number().int().min(5).max(20),
  }),
})

export const decideInputSchema = z.strictObject({
  blockId: entityIdSchema,
  condition: conditionSchema,
})
export type DecideInput = z.infer<typeof decideInputSchema>

export const decideStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('decide'),
  effectType: z.literal('READ_ONLY'),
  input: decideInputSchema,
})

export const computeInputSchema = z.strictObject({
  expression: exprSchema,
})
export type ComputeInput = z.infer<typeof computeInputSchema>

export const computeStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('compute'),
  effectType: z.literal('READ_ONLY'),
  input: computeInputSchema,
  outputKey: contextKeySchema,
})

export const listRefSchema = z.strictObject({
  from: contextKeySchema,
  fromField: z.string().optional(),
})
export type ListRef = z.infer<typeof listRefSchema>

export const collectRulesSchema = z
  .array(
    z.strictObject({
      from: contextKeySchema,
      fromField: z.string().optional(),
      into: contextKeySchema,
    }),
  )
  .max(8)
export type CollectRule = z.infer<typeof collectRulesSchema>[number]

export const authoringControlForEachSchema = z.strictObject({
  type: z.literal('for_each'),
  over: listRefSchema,
  as: contextKeySchema,
  indexAs: contextKeySchema.optional(),
  maxItems: z.number().int().min(1).max(200).default(50),
  stopWhen: conditionSchema.optional(),
})
export type AuthoringControlForEach = z.infer<typeof authoringControlForEachSchema>

export const authoringControlRepeatSchema = z.strictObject({
  type: z.literal('repeat'),
  until: conditionSchema,
  maxIterations: z.number().int().min(1).max(100).default(20),
  intervalMs: z.number().int().min(0).max(60_000).optional(),
  onLimit: z.enum(['fail', 'stop']).default('fail'),
})
export type AuthoringControlRepeat = z.infer<typeof authoringControlRepeatSchema>

export const loopInputSchema = z.strictObject({
  blockId: entityIdSchema,
  control: z.discriminatedUnion('type', [
    authoringControlForEachSchema,
    authoringControlRepeatSchema,
  ]),
  collect: collectRulesSchema.optional(),
})
export type LoopInput = z.infer<typeof loopInputSchema>

export const loopStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('loop'),
  effectType: z.literal('READ_ONLY'),
  input: loopInputSchema,
})
export type LoopStep = z.infer<typeof loopStepSchema>

export const stepSchema = z
  .discriminatedUnion('type', [
    echoStepSchema,
    delayStepSchema,
    failStepSchema,
    navigateStepSchema,
    clickStepSchema,
    fillStepSchema,
    extractStepSchema,
    assertStepSchema,
    selectStepSchema,
    keyboardStepSchema,
    waitStepSchema,
    downloadStepSchema,
    uploadStepSchema,
    aiActionStepBase,
    aiExtractStepSchema,
    aiAssertStepSchema,
    verifyContextStepSchema,
    probeStepSchema,
    mapIngestStepSchema,
    decideStepSchema,
    computeStepSchema,
    loopStepSchema,
  ])
  .superRefine((step, ctx) => {
    if (step.type === 'ai_action' && (step.policy?.retryLimit ?? 0) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['policy', 'retryLimit'],
        message: 'ai_action 不允许自动重试',
      })
    }
    if (step.optional && !OPTIONAL_ALLOWED_STEP_TYPES.includes(step.type as any)) {
      ctx.addIssue({
        code: 'custom',
        path: ['optional'],
        message: `单步可选 (optional) 仅允许用于 ${OPTIONAL_ALLOWED_STEP_TYPES.join(', ')} 步骤`,
      })
    }
    if (step.type === 'probe') {
      const waitMs = step.input.waitMs ?? 2000
      if (step.policy?.timeoutMs !== undefined && step.policy.timeoutMs <= waitMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['policy', 'timeoutMs'],
          message: `页面检查步骤的超时上限 (policy.timeoutMs=${step.policy.timeoutMs}ms) 必须大于等待上限 (waitMs=${waitMs}ms)`,
        })
      }
    }
  })
export type EchoStep = z.infer<typeof echoStepSchema>
export type DelayStep = z.infer<typeof delayStepSchema>
export type FailStep = z.infer<typeof failStepSchema>
export type NavigateStep = z.infer<typeof navigateStepSchema>
export type ClickStep = z.infer<typeof clickStepSchema>
export type FillStep = z.infer<typeof fillStepSchema>
export type ExtractStep = z.infer<typeof extractStepSchema>
export type AssertStep = z.infer<typeof assertStepSchema>
export type SelectStep = z.infer<typeof selectStepSchema>
export type KeyboardStep = z.infer<typeof keyboardStepSchema>
export type WaitStep = z.infer<typeof waitStepSchema>
export type AiActionStep = z.infer<typeof aiActionStepSchema>
export type AiExtractStep = z.infer<typeof aiExtractStepSchema>
export type AiAssertStep = z.infer<typeof aiAssertStepSchema>
export type ProbeStep = z.infer<typeof probeStepSchema>
export type MapIngestStep = z.infer<typeof mapIngestStepSchema>
export type DecideStep = z.infer<typeof decideStepSchema>
export type ComputeStep = z.infer<typeof computeStepSchema>
export type Step = z.infer<typeof stepSchema>

export const SCENARIO_INPUT_TYPES = [
  'string',
  'number',
  'boolean',
  'url',
  'file',
  'json',
] as const
export type ScenarioInputType = (typeof SCENARIO_INPUT_TYPES)[number]
export const scenarioInputTypeSchema = z.enum(SCENARIO_INPUT_TYPES)

export const scenarioInputDeclSchema = z.strictObject({
  key: contextKeySchema.refine(
    (key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key),
    'input 键不得使用对象保留名',
  ),
  label: z.string().trim().min(1).max(128),
  type: scenarioInputTypeSchema.optional(),
  required: z.boolean().optional(),
  description: z.string().max(256).optional(),
  defaultGenerator: dataGeneratorSpecSchema.optional(),
})
export type ScenarioInputDecl = z.infer<typeof scenarioInputDeclSchema>
