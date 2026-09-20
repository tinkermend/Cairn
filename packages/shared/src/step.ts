import { z } from 'zod'
import { assertExpectSchema } from './browser-command.js'
import { pageAfterSchema } from './managed-browser.js'
import {
  mapGuardedActionInputSchema,
  mapObserveInputSchema,
  mapProposeInputSchema,
  mapVerifyInputSchema,
} from './map-exploration.js'
import { aiOutputSchemaSchema, outputFieldNameSchema } from './output-schema.js'
import { executionErrorCategorySchema } from './runtime-error.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { durationMsSchema, entityIdSchema, jsonValueSchema, timeoutMsSchema } from './wire.js'

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
] as const
export const AI_STEP_TYPES = ['ai_action', 'ai_extract', 'ai_assert'] as const
export const MAP_EXPLORE_STEP_TYPES = [
  'map_observe',
  'map_propose',
  'map_guarded_action',
  'map_verify',
] as const
export const MAP_EXPLORE_BROWSER_STEP_TYPES = ['map_observe', 'map_guarded_action', 'map_verify'] as const
export const EXECUTABLE_STEP_TYPES = [
  ...FIXTURE_STEP_TYPES,
  ...BROWSER_STEP_TYPES,
  ...AI_STEP_TYPES,
  ...MAP_EXPLORE_STEP_TYPES,
] as const
export type FixtureStepType = (typeof FIXTURE_STEP_TYPES)[number]
export type BrowserStepType = (typeof BROWSER_STEP_TYPES)[number]
export type AiStepType = (typeof AI_STEP_TYPES)[number]
export type MapExploreStepType = (typeof MAP_EXPLORE_STEP_TYPES)[number]
export type ExecutableStepType = (typeof EXECUTABLE_STEP_TYPES)[number]
export const executableStepTypeSchema = z.enum(EXECUTABLE_STEP_TYPES)

export function isExecutableStepType(type: string): type is ExecutableStepType {
  return (EXECUTABLE_STEP_TYPES as readonly string[]).includes(type)
}

export function isBrowserStepType(type: string): type is BrowserStepType {
  return (BROWSER_STEP_TYPES as readonly string[]).includes(type)
}

export function isAiStepType(type: string): type is AiStepType {
  return (AI_STEP_TYPES as readonly string[]).includes(type)
}

export function isMapExploreStepType(type: string): type is MapExploreStepType {
  return (MAP_EXPLORE_STEP_TYPES as readonly string[]).includes(type)
}

/** 需要受管 Page / Session 的步骤：确定性浏览器命令、三类 AI，以及需要读页的探索步。 */
export function stepUsesBrowser(type: string): boolean {
  return (
    isBrowserStepType(type) ||
    isAiStepType(type) ||
    (MAP_EXPLORE_BROWSER_STEP_TYPES as readonly string[]).includes(type)
  )
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
})
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

const stepCommon = {
  id: entityIdSchema,
  name: z.string().min(1).max(128),
  effectType: effectTypeSchema,
  outputKey: contextKeySchema.optional(),
  policy: executionPolicySchema.optional(),
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

export const waitKindSchema = z.enum(['time', 'visible', 'hidden', 'url', 'text'])
export type WaitKind = z.infer<typeof waitKindSchema>

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
      return true
    },
    {
      message:
        'wait 步骤必须根据 kind 提供对应条件（time 提供 durationMs ≤ 60s；visible/hidden 提供 target；url 提供 urlPattern；text 提供 target 和 text）',
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

export const aiInstructionSchema = z.string().trim().min(1).max(4096)

export const AI_ATOMIC_ACTIONS_PROTOCOL = 'ai.atomic-actions@1' as const

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

const aiActionStepBase = z.strictObject({
  ...stepCommon,
  type: z.literal('ai_action'),
  effectType: z.literal('SIDE_EFFECT'),
  input: aiActionInputSchema,
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
})

export const aiAssertStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('ai_assert'),
  effectType: z.literal('READ_ONLY'),
  input: aiAssertInputSchema,
})

export const mapObserveStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('map_observe'),
  effectType: z.literal('READ_ONLY'),
  input: mapObserveInputSchema,
})
export const mapProposeStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('map_propose'),
  effectType: z.literal('READ_ONLY'),
  input: mapProposeInputSchema,
})
export const mapGuardedActionStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('map_guarded_action'),
  effectType: z.literal('READ_ONLY'),
  input: mapGuardedActionInputSchema,
})
export const mapVerifyStepSchema = z.strictObject({
  ...stepCommon,
  type: z.literal('map_verify'),
  effectType: z.literal('READ_ONLY'),
  input: mapVerifyInputSchema,
})

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
    aiActionStepBase,
    aiExtractStepSchema,
    aiAssertStepSchema,
    mapObserveStepSchema,
    mapProposeStepSchema,
    mapGuardedActionStepSchema,
    mapVerifyStepSchema,
  ])
  .superRefine((step, ctx) => {
    if (step.type === 'ai_action' && (step.policy?.retryLimit ?? 0) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['policy', 'retryLimit'],
        message: 'ai_action 不允许自动重试',
      })
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
export type MapObserveStep = z.infer<typeof mapObserveStepSchema>
export type MapProposeStep = z.infer<typeof mapProposeStepSchema>
export type MapGuardedActionStep = z.infer<typeof mapGuardedActionStepSchema>
export type MapVerifyStep = z.infer<typeof mapVerifyStepSchema>
export type Step = z.infer<typeof stepSchema>

export const scenarioInputDeclSchema = z.strictObject({
  key: contextKeySchema.refine(
    (key) => !(FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(key),
    'input 键不得使用对象保留名',
  ),
  label: z.string().trim().min(1).max(128),
})
export type ScenarioInputDecl = z.infer<typeof scenarioInputDeclSchema>
