import { describe, expect, it } from 'vitest'
import {
  STEP_SNIPPET_TEMPLATES,
  instantiateSnippet,
} from './step-snippets'

describe('StepSnippets', () => {
  it('预置包含登录、表格首行与二次确认模版', () => {
    expect(STEP_SNIPPET_TEMPLATES.length).toBeGreaterThanOrEqual(3)
    const ids = STEP_SNIPPET_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('snippet-form-login')
    expect(ids).toContain('snippet-table-first-row')
    expect(ids).toContain('snippet-confirm-dialog')
  })

  it('每次实例化生成全新唯一 UUID，步骤序号自增，无 ID 重复', () => {
    const template = STEP_SNIPPET_TEMPLATES.find((t) => t.id === 'snippet-form-login')!
    const steps1 = instantiateSnippet(template, new Set())
    const steps2 = instantiateSnippet(template, new Set())

    expect(steps1).toHaveLength(5)
    expect(steps2).toHaveLength(5)

    const ids1 = new Set(steps1.map((s) => s.id))
    const ids2 = new Set(steps2.map((s) => s.id))

    // 内部无重复
    expect(ids1.size).toBe(5)
    expect(ids2.size).toBe(5)

    // 两次调用之间无碰撞
    for (const id of ids1) {
      expect(ids2.has(id)).toBe(false)
    }
  })

  it('当变量已存在时，自动分配不冲突的 uniqueOutputKey', () => {
    const tableTemplate = STEP_SNIPPET_TEMPLATES.find((t) => t.id === 'snippet-table-first-row')!
    const usedKeys = new Set(['extracted_row_id'])

    const steps = instantiateSnippet(tableTemplate, usedKeys)
    const extractStep = steps.find((s) => s.type === 'extract')
    expect(extractStep).toBeDefined()
    expect(extractStep?.outputKey).toBe('extracted_row_id2')
  })
})
