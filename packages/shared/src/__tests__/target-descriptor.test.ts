import { describe, expect, it } from 'vitest'
import { targetDescriptorSchema } from '../target-descriptor.js'

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
})
