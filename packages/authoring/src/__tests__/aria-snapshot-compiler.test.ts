import { describe, expect, it } from 'vitest'
import { compileScenarioDocument } from '../compiler.js'
import type { ScenarioDocument } from '@cairn/shared'

describe('TC-PAS-A02: 编译闸门校验 aria_snapshot 模板', () => {
  function makeScenario(template: string): ScenarioDocument {
    return {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000001',
      name: '测试场景',
      targetId: '00000000-0000-4000-8000-000000000002',
      inputs: [],
      steps: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          name: '断言页面结构',
          type: 'assert',
          input: {
            expect: {
              kind: 'aria_snapshot',
              template,
            },
          },
        },
      ],
    }
  }

  it('合法 YAML 列表模板编译通过', () => {
    const doc = makeScenario('- button "提交"\n- heading "标题"')
    const res = compileScenarioDocument(doc, { target: { exists: true, status: 'active' } })
    const err = res.diagnostics.find((d) => d.code === 'SCENARIO_ASSERT_TEMPLATE_INVALID')
    expect(err).toBeUndefined()
  })

  it('YAML 语法错误在编译期被拦截', () => {
    const doc = makeScenario('::: invalid [[[')
    const res = compileScenarioDocument(doc, { target: { exists: true, status: 'active' } })
    const err = res.diagnostics.find((d) => d.code === 'SCENARIO_ASSERT_TEMPLATE_INVALID')
    expect(err).toBeDefined()
    expect(err?.severity).toBe('error')
    expect(res.ok).toBe(false)
  })

  it('根节点非列表（比如对象或标量）在编译期被拦截', () => {
    const doc = makeScenario('key: value\nanother: 123')
    const res = compileScenarioDocument(doc, { target: { exists: true, status: 'active' } })
    const err = res.diagnostics.find((d) => d.code === 'SCENARIO_ASSERT_TEMPLATE_INVALID')
    expect(err).toBeDefined()
    expect(err?.message).toContain('根节点必须是列表')
    expect(res.ok).toBe(false)
  })
})
