import { describe, expect, it } from 'vitest'
import { citationDisplayLabel } from './citation-label'

describe('citationDisplayLabel (M4 - 细分引用标签展示)', () => {
  it('正确解析场景步骤基础与细分维度引用', () => {
    expect(citationDisplayLabel('step:step-100')).toBe('场景步骤 · step-100')
    expect(citationDisplayLabel('step:step-100:selector')).toBe('步骤定位 · step-100')
    expect(citationDisplayLabel('step:step-100:vars')).toBe('步骤变量 · step-100')
    expect(citationDisplayLabel('step:step-100:flow')).toBe('控制流程 · step-100')
    expect(citationDisplayLabel('step:step-100:assertion')).toBe('步骤断言 · step-100')
  })

  it('正确解析场景事实与草稿状态引用', () => {
    expect(citationDisplayLabel('scenario:sc-200')).toBe('场景事实 · sc-200')
    expect(citationDisplayLabel('scenario:sc-200:draft_status')).toBe('草稿状态 · sc-200')
  })

  it('正确解析运行与帮助引用', () => {
    expect(citationDisplayLabel('run:run-300')).toBe('运行记录 · run-300')
    expect(citationDisplayLabel('stepRun:sr-400')).toBe('步骤执行 · sr-400')
    expect(citationDisplayLabel('attempt:att-500')).toBe('执行尝试 · att-500')
    expect(citationDisplayLabel('help:studio-retry')).toBe('帮助资料 · 步骤重试')
    expect(citationDisplayLabel('help:target-config-loginLeaveTimeoutSeconds')).toBe('字段说明 · 提交后等待离开登录页')
    expect(citationDisplayLabel('platform:knowledge_status:no_matching_facts')).toBe('平台规则')
  })

  it('异常与未知来源优雅降级', () => {
    expect(citationDisplayLabel('unknown')).toBe('来源记录')
    expect(citationDisplayLabel('custom:id-999')).toBe('来源记录 · id-999')
  })
})
