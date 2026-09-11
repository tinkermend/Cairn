import { z } from 'zod'
import { assertExpectSchema } from './browser-command.js'
import { executionErrorCategorySchema } from './runtime-error.js'
import { targetDescriptorSchema } from './target-descriptor.js'
import { durationMsSchema, entityIdSchema, jsonValueSchema, timeoutMsSchema } from './wire.js'

/**
 * 可执行 Step。枚举即注册表：没写进这里的 type 过不了 `stepSchema`。
 *
 * AI 等业务类型等对应 Executor 落地再加。提前占位等于告诉调用方「平台已经能跑」。
 */
export const FIXTURE_STEP_TYPES = ['echo', 'delay', 'fail'] as const
export const BROWSER_STEP_TYPES = ['navigate', 'click', 'fill', 'extract', 'assert'] as const
export const EXECUTABLE_STEP_TYPES = [...FIXTURE_STEP_TYPES, ...BROWSER_STEP_TYPES] as const
export type FixtureStepType = (typeof FIXTURE_STEP_TYPES)[number]
export type BrowserStepType = (typeof BROWSER_STEP_TYPES)[number]
export type ExecutableStepType = (typeof EXECUTABLE_STEP_TYPES)[number]
export const executableStepTypeSchema = z.enum(EXECUTABLE_STEP_TYPES)

export function isExecutableStepType(type: string): type is ExecutableStepType {
  return (EXECUTABLE_STEP_TYPES as readonly string[]).includes(type)
}

export function isBrowserStepType(type: string): type is BrowserStepType {
  return (BROWSER_STEP_TYPES as readonly string[]).includes(type)
}

export const EFFECT_TYPES = ['READ_ONLY', 'IDEMPOTENT', 'SIDE_EFFECT'] as const
export type EffectType = (typeof EFFECT_TYPES)[number]
export const effectTypeSchema = z.enum(EFFECT_TYPES)

/** context 写入名 / Echo.from。只校验形状，key 是否已存在由 Engine 检查。 */
export const contextKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/, 'context key 须为字母开头的标识符，最长 128')

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
  })
  .refine((input) => (input.value !== undefined) !== (input.from !== undefined), {
    message: 'echo 必须恰好提供 value 或 from 其中一个',
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

export const clickInputSchema = z.strictObject({
  target: targetDescriptorSchema,
})
export type ClickInput = z.infer<typeof clickInputSchema>

export const fillInputSchema = z
  .strictObject({
    target: targetDescriptorSchema,
    value: z.string().max(16_384).optional(),
    from: contextKeySchema.optional(),
  })
  .refine((input) => (input.value !== undefined) !== (input.from !== undefined), {
    message: 'fill 必须恰好提供 value 或 from 其中一个',
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

export const stepSchema = z.discriminatedUnion('type', [
  echoStepSchema,
  delayStepSchema,
  failStepSchema,
  navigateStepSchema,
  clickStepSchema,
  fillStepSchema,
  extractStepSchema,
  assertStepSchema,
])
export type EchoStep = z.infer<typeof echoStepSchema>
export type DelayStep = z.infer<typeof delayStepSchema>
export type FailStep = z.infer<typeof failStepSchema>
export type NavigateStep = z.infer<typeof navigateStepSchema>
export type ClickStep = z.infer<typeof clickStepSchema>
export type FillStep = z.infer<typeof fillStepSchema>
export type ExtractStep = z.infer<typeof extractStepSchema>
export type AssertStep = z.infer<typeof assertStepSchema>
export type Step = z.infer<typeof stepSchema>
