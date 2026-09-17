import { describe, expect, it } from 'vitest'
import { compileScenarioDocument } from '../compiler.js'
import type { ScenarioDocument, Step } from '@cairn/shared'

const ids = {
  a: '00000000-0000-4000-8000-000000000071',
  b: '00000000-0000-4000-8000-000000000072',
  c: '00000000-0000-4000-8000-000000000073',
  d: '00000000-0000-4000-8000-000000000074',
  e: '00000000-0000-4000-8000-000000000075',
}

function echo(id: string, name: string, extra: { from?: string; value?: string; outputKey?: string }): Step {
  return {
    id,
    name,
    type: 'echo',
    effectType: 'READ_ONLY',
    outputKey: extra.outputKey,
    input: extra.from ? { from: extra.from } : { value: extra.value ?? 'x' },
  }
}

function navigate(id: string, url = 'https://lab.example'): Step {
  return { id, name: '打开', type: 'navigate', effectType: 'SIDE_EFFECT', input: { url } }
}

function document(steps: Step[], inputs: ScenarioDocument['inputs'] = []): ScenarioDocument {
  return { schemaVersion: 1, inputs, steps }
}

describe('compileScenarioDocument', () => {
  it('相同文档两次编译产物与诊断码相同，且产物等于源文档', () => {
    const source = document([
      navigate(ids.a),
      echo(ids.b, '回显', { value: 'ok', outputKey: 'echoed' }),
    ])
    const first = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    const second = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(first.definition).toEqual(source)
    expect(first.diagnostics.map((item) => item.code)).toEqual(second.diagnostics.map((item) => item.code))
    expect(first.ok).toBe(second.ok)
    expect(first.definition).not.toHaveProperty('policy')
  })

  it('保存期未解析 from 是 warning，发布期是 error', () => {
    const source = document([echo(ids.a, '读单号', { from: 'orderId' })])
    const saved = compileScenarioDocument(source, { mode: 'save' })
    expect(saved.ok).toBe(true)
    expect(saved.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNRESOLVED_REF', severity: 'warning' })]),
    )
    const released = compileScenarioDocument(source, { mode: 'release' })
    expect(released.ok).toBe(false)
    expect(released.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNRESOLVED_REF', severity: 'error' })]),
    )
  })

  it('声明输入后 from 可解析', () => {
    const source = document([echo(ids.a, '读单号', { from: 'orderId' })], [{ key: 'orderId', label: '单号' }])
    const result = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.some((item) => item.code === 'SCENARIO_UNRESOLVED_REF')).toBe(false)
  })

  it('前向引用阻断发布', () => {
    const source = document([
      echo(ids.a, '先读', { from: 'later' }),
      echo(ids.b, '后写', { value: '1', outputKey: 'later' }),
    ])
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'SCENARIO_FORWARD_REF')).toBe(true)
  })

  it('未知 type 阻断', () => {
    const source = document([echo(ids.a, '回显', { value: '1' })])
    const result = compileScenarioDocument(source, { mode: 'release', executableTypes: ['navigate'] })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_UNKNOWN_STEP_TYPE' })]),
    )
  })

  it('停用 Target 在发布期是 error，保存期是 warning', () => {
    const source = document([echo(ids.a, '回显', { value: '1' })])
    expect(compileScenarioDocument(source, { mode: 'save', target: { exists: true, status: 'disabled' } }).ok).toBe(true)
    expect(
      compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'disabled' } }).ok,
    ).toBe(false)
  })

  it('重复 id / outputKey / input 键与保留名阻断发布', () => {
    const source = document(
      [
        echo(ids.a, '先写', { value: '1', outputKey: 'echoed' }),
        echo(ids.a, '同 id', { value: '2', outputKey: 'echoed' }),
      ],
      [
        { key: 'orderId', label: '单号' },
        { key: 'orderId', label: '又一份单号' },
        { key: 'constructor', label: '陷阱' },
      ],
    )
    const result = compileScenarioDocument(source, { mode: 'release' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'SCENARIO_INPUT_KEY_DUPLICATE',
      'SCENARIO_INPUT_KEY_FORBIDDEN',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_OUTPUT_KEY_DUPLICATE',
      'SCENARIO_STEP_ID_DUPLICATE',
    ])
  })

  it('对象输出未给 fromField 时阻断，字段名必须存在', () => {
    const extract: Step = {
      id: ids.a,
      name: '提取',
      type: 'ai_extract',
      effectType: 'READ_ONLY',
      outputKey: 'order',
      input: {
        instruction: '读取订单',
        outputSchema: { kind: 'object', fields: [{ name: 'orderNo', type: 'string' }] },
      },
    }
    const missing = compileScenarioDocument(
      document([extract, echo(ids.b, '回填', { from: 'order' })]),
      { mode: 'release' },
    )
    expect(missing.ok).toBe(false)
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_FROM_FIELD_MISSING' })]),
    )
    const unknown = compileScenarioDocument(
      document([
        extract,
        {
          id: ids.b,
          name: '回填',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { from: 'order', fromField: 'missing' },
        },
      ]),
      { mode: 'release' },
    )
    expect(unknown.ok).toBe(false)
    expect(unknown.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_FROM_FIELD_UNKNOWN' })]),
    )
  })

  it('AI Action 禁止自动重试，AI Assert 可充当断言', () => {
    const retried = compileScenarioDocument(
      document([
        {
          id: ids.a,
          name: '动作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          policy: { retryLimit: 1 },
          input: { instruction: '查询' },
        },
      ]),
      { mode: 'release' },
    )
    expect(retried.ok).toBe(false)
    expect(retried.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_AI_RETRY_FORBIDDEN' })]),
    )
    const asserted = compileScenarioDocument(
      document([
        navigate(ids.a),
        {
          id: ids.b,
          name: '判断',
          type: 'ai_assert',
          effectType: 'READ_ONLY',
          input: { instruction: '已成功' },
        },
      ]),
      { mode: 'release', target: { exists: true, status: 'active' } },
    )
    expect(asserted.ok).toBe(true)
    expect(asserted.diagnostics.some((item) => item.code === 'SCENARIO_NO_ASSERT')).toBe(false)
  })

  it('仅 CSS 定位、无断言、未使用输入给出 warning', () => {
    const source = document(
      [
        navigate(ids.a),
        {
          id: ids.b,
          name: '点',
          type: 'click',
          effectType: 'SIDE_EFFECT',
          input: { target: { framePath: [], candidates: [{ by: 'css', value: '#ok' }] } },
        },
        {
          id: ids.c,
          name: '抽',
          type: 'extract',
          effectType: 'READ_ONLY',
          input: { target: { framePath: [], candidates: [{ by: 'label', value: '名称' }] }, as: 'text' },
        },
      ],
      [{ key: 'unused', label: '未用' }],
    )
    const result = compileScenarioDocument(source, { mode: 'release', target: { exists: true, status: 'active' } })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'SCENARIO_EXTRACT_NO_OUTPUT_KEY',
      'SCENARIO_INPUT_UNUSED',
      'SCENARIO_NO_ASSERT',
      'SCENARIO_WEAK_LOCATOR',
    ])
  })
})
