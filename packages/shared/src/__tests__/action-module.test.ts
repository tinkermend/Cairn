import { describe, expect, it } from 'vitest'
import {
  compileModuleContent,
  deriveExecutionMode,
  moduleContentSchema,
  moduleContractSchema,
  moduleKeySchema,
  type ModuleContent,
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

  describe('compileModuleContent 校验规则', () => {
    const validAssertStep: Step = {
      id: assertStepId,
      name: '结果断言',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        expect: {
          kind: 'text_contains',
          value: '订单详情',
        },
      },
    }

    it('发布时实现为空会报错 MODULE_IMPLEMENTATION_EMPTY', () => {
      const content: ModuleContent = {
        contract: {
          inputs: [],
          outputs: [],
          effectCeiling: 'READ_ONLY',
          preconditions: [],
          postconditions: [],
        },
        implementations: [
          {
            implementationKey: 'default',
            kind: 'structured_steps',
            steps: [],
            outputMapping: {},
          },
        ],
      }
      const saveResult = compileModuleContent(content, { mode: 'save' })
      expect(saveResult.diagnostics.some((d) => d.code === 'MODULE_IMPLEMENTATION_EMPTY')).toBe(false)

      const releaseResult = compileModuleContent(content, { mode: 'release' })
      expect(releaseResult.ok).toBe(false)
      expect(releaseResult.diagnostics.some((d) => d.code === 'MODULE_IMPLEMENTATION_EMPTY')).toBe(true)
    })

    describe('AMA-02: 副作用上限', () => {
      it('READ_ONLY 模块含 SIDE_EFFECT 步骤时发布阻断 MODULE_EFFECT_EXCEEDS_CEILING', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '页面正确',
                verification: { kind: 'step', stepId: assertStepId },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: step1Id,
                  name: '点击按钮',
                  type: 'click',
                  effectType: 'SIDE_EFFECT',
                  input: {
                    target: {
                      framePath: [],
                      candidates: [{ by: 'role', value: 'button', name: '提交' }],
                    },
                  },
                },
                validAssertStep,
              ],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_EFFECT_EXCEEDS_CEILING')).toBe(true)

        // 改为 SIDE_EFFECT 后通过
        const modifiedContent: ModuleContent = {
          ...content,
          contract: {
            ...content.contract,
            effectCeiling: 'SIDE_EFFECT',
          },
        }
        const modifiedResult = compileModuleContent(modifiedContent, { mode: 'release' })
        expect(modifiedResult.diagnostics.some((d) => d.code === 'MODULE_EFFECT_EXCEEDS_CEILING')).toBe(false)
      })
    })

    describe('AMA-03: 结果验证', () => {
      it('没有可执行后置条件：保存给警告，发布被阻断 MODULE_VERIFICATION_MISSING', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '人工确认界面完整',
                verification: { kind: 'manual_requirement' },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: step1Id,
                  name: '等待加载',
                  type: 'wait',
                  effectType: 'READ_ONLY',
                  input: { kind: 'time', durationMs: 1000 },
                },
              ],
              outputMapping: {},
            },
          ],
        }

        // 保存时警告
        const saveResult = compileModuleContent(content, { mode: 'save' })
        const saveDiag = saveResult.diagnostics.find((d) => d.code === 'MODULE_VERIFICATION_MISSING')
        expect(saveDiag).toBeDefined()
        expect(saveDiag?.severity).toBe('warning')

        // 发布时错误
        const releaseResult = compileModuleContent(content, { mode: 'release' })
        expect(releaseResult.ok).toBe(false)
        const releaseDiag = releaseResult.diagnostics.find((d) => d.code === 'MODULE_VERIFICATION_MISSING')
        expect(releaseDiag).toBeDefined()
        expect(releaseDiag?.severity).toBe('error')
      })

      it('含交互步骤但后置条件断言在交互之前，触发 MODULE_VERIFICATION_TOO_WEAK', () => {
        const earlyAssertId = '00000000-0000-4000-8000-000000000009'
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'SIDE_EFFECT',
            preconditions: [],
            postconditions: [
              {
                meaning: '前期断言',
                verification: { kind: 'step', stepId: earlyAssertId },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: earlyAssertId,
                  name: '初始断言',
                  type: 'assert',
                  effectType: 'READ_ONLY',
                  input: { expect: { kind: 'text_contains', value: '首页' } },
                },
                {
                  id: step1Id,
                  name: '点击按钮',
                  type: 'click',
                  effectType: 'SIDE_EFFECT',
                  input: {
                    target: {
                      framePath: [],
                      candidates: [{ by: 'role', value: 'button', name: '搜索' }],
                    },
                  },
                },
              ],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_VERIFICATION_TOO_WEAK')).toBe(true)
      })
    })

    describe('输出映射检查', () => {
      it('输出未映射或映射到不存在的 outputKey 时报 MODULE_OUTPUT_UNMAPPED', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [
              { key: 'extractedName', label: '名称', shape: { kind: 'scalar', type: 'string' } },
            ],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '必须输出',
                verification: { kind: 'output_required', outputKey: 'extractedName' },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: step1Id,
                  name: '提取',
                  type: 'extract',
                  effectType: 'READ_ONLY',
                  outputKey: 'actualName',
                  input: {
                    target: {
                      framePath: [],
                      candidates: [{ by: 'text', value: '标题' }],
                    },
                    as: 'text',
                  },
                },
                validAssertStep,
              ],
              outputMapping: {
                extractedName: 'nonExistentKey',
              },
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_OUTPUT_UNMAPPED')).toBe(true)
      })
    })

    describe('输入未引用警告', () => {
      it('声明的输入没有被引用时产生 MODULE_INPUT_UNUSED 警告', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [
              { key: 'unusedInput', label: '未使用输入', valueType: 'string', required: false },
            ],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              { meaning: '完成', verification: { kind: 'step', stepId: assertStepId } },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [validAssertStep],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'save' })
        expect(result.diagnostics.some((d) => d.code === 'MODULE_INPUT_UNUSED')).toBe(true)
      })
    })

    describe('AMA-05: 沿用步骤约束', () => {
      it('模块内 ai_action 的 retryLimit > 0 会被拒绝', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'SIDE_EFFECT',
            preconditions: [],
            postconditions: [
              { meaning: '完成', verification: { kind: 'step', stepId: assertStepId } },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: step1Id,
                  name: 'AI动作',
                  type: 'ai_action',
                  effectType: 'SIDE_EFFECT',
                  policy: { retryLimit: 2 },
                  input: { instruction: '点击' },
                },
                validAssertStep,
              ],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'SCENARIO_AI_RETRY_FORBIDDEN')).toBe(true)
      })
    })

    describe('条件引用无效检查', () => {
      it('引用不存在的 stepId 报 MODULE_CONDITION_STEP_INVALID', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '验证',
                verification: { kind: 'step', stepId: '00000000-0000-4000-8000-999999999999' },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [validAssertStep],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_CONDITION_STEP_INVALID')).toBe(true)
      })

      it('引用的步骤类型不是 assert 或 ai_assert 报 MODULE_CONDITION_STEP_INVALID', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '验证',
                verification: { kind: 'step', stepId: step1Id }, // step1Id 是 echo 步骤
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [
                {
                  id: step1Id,
                  name: '回显',
                  type: 'echo',
                  effectType: 'READ_ONLY',
                  input: { value: 'hi' },
                },
              ],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_CONDITION_STEP_INVALID')).toBe(true)
      })

      it('output_required 引用未声明的输出报 MODULE_CONDITION_OUTPUT_INVALID', () => {
        const content: ModuleContent = {
          contract: {
            inputs: [],
            outputs: [],
            effectCeiling: 'READ_ONLY',
            preconditions: [],
            postconditions: [
              {
                meaning: '验证',
                verification: { kind: 'output_required', outputKey: 'notDeclared' },
              },
            ],
          },
          implementations: [
            {
              implementationKey: 'default',
              kind: 'structured_steps',
              steps: [validAssertStep],
              outputMapping: {},
            },
          ],
        }

        const result = compileModuleContent(content, { mode: 'release' })
        expect(result.ok).toBe(false)
        expect(result.diagnostics.some((d) => d.code === 'MODULE_CONDITION_OUTPUT_INVALID')).toBe(true)
      })
    })
  })
})

describe('AM-A review regressions', () => {
  const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const assertion = (n: number): Step => ({ id: id(n), type: 'assert', name: '页面容器存在', effectType: 'READ_ONLY', input: { expect: { kind: 'text_contains', value: '条' } } })
  const click: Step = { id: id(2), type: 'click', name: '查询', effectType: 'SIDE_EFFECT', input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '查询' }] } } }
  const content = (): ModuleContent => ({ contract: { inputs: [], outputs: [], effectCeiling: 'SIDE_EFFECT', preconditions: [{ meaning: '允许查询', verification: { kind: 'step', stepId: id(1) } }], postconditions: [{ meaning: '结果存在', verification: { kind: 'step', stepId: id(3) } }] }, implementations: [{ implementationKey: 'default', kind: 'structured_steps', steps: [assertion(1), click, assertion(3)], outputMapping: {} }] })
  it('交互之后的静态容器断言仍阻断发布；加载消失判据后允许发布', () => {
    const c = content()
    expect(compileModuleContent(c, { mode: 'release' }).diagnostics).toContainEqual(expect.objectContaining({ code: 'MODULE_VERIFICATION_TOO_WEAK', severity: 'error', fieldPath: ['contract', 'postconditions'] }))
    c.implementations[0]!.steps.splice(2, 0, { id: id(4), type: 'wait', name: '等待结果加载完成', effectType: 'READ_ONLY', input: { kind: 'hidden', target: { framePath: [], candidates: [{ by: 'testId', value: 'loading' }] } } })
    expect(compileModuleContent(c, { mode: 'release' }).ok).toBe(true)
  })
  it.each(['missing', 'manual', 'late'] as const)('写操作的 %s 前置保护被阻断', (variant) => {
    const c = content()
    c.contract.preconditions = variant === 'missing' ? [] : [{ meaning: '允许操作', verification: variant === 'manual' ? { kind: 'manual_requirement' } : { kind: 'step', stepId: id(3) } }]
    expect(compileModuleContent(c, { mode: 'release' }).diagnostics).toContainEqual(expect.objectContaining({ code: 'MODULE_PRECONDITION_MISSING', severity: 'error' }))
  })
  it('交互前提取的旧输出不能满足结果刷新判据', () => {
    const c = content()
    c.contract.outputs = [{ key: 'result', label: '结果', shape: { kind: 'scalar', type: 'string' } }]
    c.contract.postconditions = [{ meaning: '输出已刷新', verification: { kind: 'output_required', outputKey: 'result' } }]
    c.implementations[0]!.outputMapping = { result: 'value' }
    c.implementations[0]!.steps.unshift({ id: id(5), type: 'extract', name: '提取', effectType: 'READ_ONLY', outputKey: 'value', input: { target: { framePath: [], candidates: [{ by: 'testId', value: 'result' }] }, as: 'text' } })
    expect(compileModuleContent(c, { mode: 'release' }).diagnostics.some((d) => d.code === 'MODULE_VERIFICATION_TOO_WEAK')).toBe(true)
    const extract = c.implementations[0]!.steps.shift()!
    c.implementations[0]!.steps.push(extract)
    expect(compileModuleContent(c, { mode: 'release' }).ok).toBe(true)
  })
  it('空草稿仍返回契约诊断和字段路径', () => {
    const c = content(); c.implementations[0]!.steps = []
    const result = compileModuleContent(c, { mode: 'save' })
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MODULE_VERIFICATION_MISSING', severity: 'warning' }))
    expect(result.diagnostics.every((d) => d.fieldPath?.length)).toBe(true)
  })
  it('在编译入口校验步骤数量、非法 key 和对象保留名', () => {
    const c = content(); c.contract.inputs = [{ key: 'constructor', label: '非法输入', valueType: 'string', required: true }]
    expect(compileModuleContent(c, { mode: 'save' }).diagnostics[0]?.code).toBe('MODULE_SCHEMA_INVALID')
    c.contract.inputs = []; c.implementations[0]!.steps = Array.from({ length: 33 }, (_, i) => assertion(i + 10))
    expect(compileModuleContent(c, { mode: 'release' }).ok).toBe(false)
  })
  it('前向引用带模块诊断与能力开关诊断', () => {
    const c = content()
    c.implementations[0]!.steps.unshift({ id: id(5), name: '引用未来输出', type: 'echo', effectType: 'READ_ONLY', input: { from: 'future' } })
    c.implementations[0]!.steps[2]!.outputKey = 'future'
    const result = compileModuleContent(c, { mode: 'release', executableTypes: ['assert', 'click'] })
    expect(result.diagnostics.some((d) => d.code === 'MODULE_INPUT_UNDECLARED')).toBe(true)
    expect(result.diagnostics.some((d) => d.code === 'SCENARIO_UNKNOWN_STEP_TYPE')).toBe(true)
  })
})
