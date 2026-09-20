import { describe, expect, it } from 'vitest'
import { arrivalTargetForName, expandArrivalTarget, targetDescriptorSchema } from '../target-descriptor.js'

describe('targetDescriptorSchema', () => {
  it('空 framePath 表示主 frame', () => {
    expect(
      targetDescriptorSchema.parse({
        candidates: [{ by: 'role', value: 'button', name: '查询' }],
      }).framePath,
    ).toEqual([])
  })

  it('拒绝 FrameStep 空对象（不能靠下标）', () => {
    expect(() =>
      targetDescriptorSchema.parse({
        framePath: [{}],
        candidates: [{ by: 'text', value: '确定' }],
      }),
    ).toThrow()
  })

  it('到达名补齐标题之后的菜单项和链接', () => {
    const target = arrivalTargetForName('总览')
    expect(target.candidates).toEqual([
      { by: 'role', value: 'heading', name: '总览' },
      { by: 'role', value: 'menuitem', name: '总览' },
      { by: 'role', value: 'link', name: '总览' },
      { by: 'role', value: 'button', name: '总览' },
      { by: 'text', value: '总览' },
    ])
    expect(
      expandArrivalTarget(
        { framePath: [], candidates: [{ by: 'role', value: 'menuitem', name: '总览' }] },
        '总览',
      ).candidates[0],
    ).toEqual({ by: 'role', value: 'menuitem', name: '总览' })
  })
})
