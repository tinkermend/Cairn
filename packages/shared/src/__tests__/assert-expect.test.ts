import { describe, expect, it } from 'vitest'
import { ASSERT_KINDS, assertExpectSchema, BROWSER_STEP_ERROR_CODES } from '../browser-command.js'

describe('TC-PAS-A01: assertExpectSchema 与错误码契约', () => {
  it('ASSERT_KINDS 包含 aria_snapshot', () => {
    expect(ASSERT_KINDS).toContain('aria_snapshot')
  })

  it('BROWSER_STEP_ERROR_CODES 包含 ASSERT_TEMPLATE_INVALID', () => {
    expect(BROWSER_STEP_ERROR_CODES).toContain('ASSERT_TEMPLATE_INVALID')
  })

  it('aria_snapshot 合法结构与长度边界校验', () => {
    const valid = {
      kind: 'aria_snapshot',
      template: '- button "提交"\n- heading "标题"',
    }
    const parsed = assertExpectSchema.safeParse(valid)
    expect(parsed.success).toBe(true)

    // 空字符串拒绝
    expect(assertExpectSchema.safeParse({ kind: 'aria_snapshot', template: '' }).success).toBe(false)

    // 超长拒绝 (16384 上限)
    expect(
      assertExpectSchema.safeParse({
        kind: 'aria_snapshot',
        template: 'a'.repeat(16385),
      }).success,
    ).toBe(false)

    // 严格对象拒绝多余字段
    expect(
      assertExpectSchema.safeParse({
        kind: 'aria_snapshot',
        template: '- button',
        extra: 'forbidden',
      }).success,
    ).toBe(false)
  })
})
