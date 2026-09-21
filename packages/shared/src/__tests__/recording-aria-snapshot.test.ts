import { describe, expect, it } from 'vitest'
import { normalizeRecording } from '../recording.js'

describe('TC-PAS-A03: 录制解封与 assertSnapshot 映射', () => {
  it('assertSnapshot 成功映射为 assert 步骤，包含 aria_snapshot 模板并脱敏', () => {
    const rawTemplate = '- heading "用户列表"\n- textbox "密码": mySecretPass123\n- button "导出"'
    const events = [
      {
        name: 'assertSnapshot',
        snapshot: rawTemplate,
      },
    ]

    const res = normalizeRecording(events)
    expect(res.items).toHaveLength(1)
    const item = res.items[0]!
    expect(item.status).toBe('mapped')
    expect(item.candidateStepType).toBe('assert')
    expect(item.name).toBe('断言快照')
    expect(item.input).toBeDefined()
    const input = item.input as { expect: { kind: string; template: string } }
    expect(input.expect.kind).toBe('aria_snapshot')
    // 验证脱敏：密码被替换为 ***
    expect(input.expect.template).toContain('textbox "密码": ***')
    expect(input.expect.template).not.toContain('mySecretPass123')
  })

  it('markedSensitive 命中时，assertSnapshot 被标记为未解析且诊断说明敏感', () => {
    const events = [
      {
        name: 'assertSnapshot',
        snapshot: '- button "秘密"',
        markedSensitive: true,
      },
    ]

    const res = normalizeRecording(events)
    expect(res.items).toHaveLength(1)
    const item = res.items[0]!
    expect(item.status).toBe('unresolved')
    expect(item.diagnostics.join(' ')).toContain('含敏感值')
  })

  it('assertValue / assertChecked 仍然保持未映射状态', () => {
    const events = [
      {
        name: 'assertValue',
        value: '123',
      },
      {
        name: 'assertChecked',
        checked: true,
      },
    ]

    const res = normalizeRecording(events)
    expect(res.items).toHaveLength(2)
    expect(res.items[0]?.status).toBe('unresolved')
    expect(res.items[0]?.diagnostics.join(' ')).toContain('尚不能映射到现有断言种类')
    expect(res.items[1]?.status).toBe('unresolved')
    expect(res.items[1]?.diagnostics.join(' ')).toContain('尚不能映射到现有断言种类')
  })
})
