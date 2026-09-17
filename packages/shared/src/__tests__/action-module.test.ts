import { describe, expect, it } from 'vitest'
import {
  deriveExecutionMode,
  moduleContentSchema,
  moduleContractSchema,
  moduleKeySchema,
} from '../action-module.js'
import type { Step } from '../step.js'

describe('AM-A: 模块定义与契约 (C0)', () => {
  const dummyTargetId = '00000000-0000-4000-8000-000000000001'
  const step1Id = '00000000-0000-4000-8000-000000000011'
  const step2Id = '00000000-0000-4000-8000-000000000012'
  const assertStepId = '00000000-0000-4000-8000-000000000013'

  describe('AMA-01: 契约 Schema 正反例', () => {
    it('合法 key 通过，非法 key 被拒绝', () => {
      expect(moduleKeySchema.parse('order.query')).toBe('order.query')
      expect(moduleKeySchema.parse('order.query.detail')).toBe('order.query.detail')
      expect(moduleKeySchema.parse('auth')).toBe('auth')

      // 非法：大写、下划线开头、特殊字符、点开头结尾等
      expect(() => moduleKeySchema.parse('Order.Query')).toThrow()
      expect(() => moduleKeySchema.parse('.order.query')).toThrow()
      expect(() => moduleKeySchema.parse('order.query.')).toThrow()
      expect(() => moduleKeySchema.parse('order..query')).toThrow()
      expect(() => moduleKeySchema.parse('order-query')).toThrow()
      expect(() => moduleKeySchema.parse('')).toThrow()
      expect(() => moduleKeySchema.parse('a'.repeat(65))).toThrow()
    })

    it('输入 key 重复时 schema 拒绝', () => {
      expect(() =>
        moduleContractSchema.parse({
          inputs: [
            { key: 'orderId', label: '订单ID', valueType: 'string', required: true },
            { key: 'orderId', label: '重复ID', valueType: 'string', required: true },
          ],
          outputs: [],
          effectCeiling: 'READ_ONLY',
          preconditions: [],
          postconditions: [],
        }),
      ).toThrow(/重复/)
    })

    it('输出 key 重复时 schema 拒绝', () => {
      expect(() =>
        moduleContractSchema.parse({
          inputs: [],
          outputs: [
            { key: 'result', label: '结果1', shape: { kind: 'scalar', type: 'string' } },
            { key: 'result', label: '结果2', shape: { kind: 'scalar', type: 'string' } },
          ],
          effectCeiling: 'READ_ONLY',
          preconditions: [],
          postconditions: [],
        }),
      ).toThrow(/重复/)
    })

    it('实现数量必须为 1–3', () => {
      const content = {
        contract: {
          inputs: [],
          outputs: [],
          effectCeiling: 'READ_ONLY',
          preconditions: [],
          postconditions: [],
        },
        implementations: [],
      }
      expect(() => moduleContentSchema.parse(content)).toThrow()
    })
  })

  describe('AMA-04: 执行方式派生', () => {
    const echoStep: Step = {
      id: step1Id,
      name: '回显',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'test' },
    }
    const aiActionStep: Step = {
      id: step2Id,
      name: 'AI操作',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: '点击提交' },
    }
    const aiAssertStep: Step = {
      id: assertStepId,
      name: 'AI断言',
      type: 'ai_assert',
      effectType: 'READ_ONLY',
      input: { instruction: '检查成功' },
    }

    it('纯确定性步骤 -> DETERMINISTIC', () => {
      expect(deriveExecutionMode([echoStep])).toBe('DETERMINISTIC')
    })

    it('纯 AI 步骤 -> AI', () => {
      expect(deriveExecutionMode([aiActionStep, aiAssertStep])).toBe('AI')
    })

    it('确定性与 AI 混编 -> HYBRID', () => {
      expect(deriveExecutionMode([echoStep, aiActionStep])).toBe('HYBRID')
    })
  })
})
