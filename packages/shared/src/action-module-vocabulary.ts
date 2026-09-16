/** 无运行/编写依赖的 C0 词表，避免 Scenario → Authoring → Module → Scenario 初始化环。 */
import { z } from 'zod'

export const MODULE_EXECUTION_MODES = ['DETERMINISTIC', 'AI', 'HYBRID'] as const
export type ModuleExecutionMode = (typeof MODULE_EXECUTION_MODES)[number]
export const moduleExecutionModeSchema = z.enum(MODULE_EXECUTION_MODES)

export const implementationKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, '实现 key 须为小写字母开头的标识符，最长 32 字符')
export type ImplementationKey = z.infer<typeof implementationKeySchema>

