import { describe, expect, it } from 'vitest'
import { parseModelJson } from './model-session'

describe('模型 JSON 解析', () => {
  it('接受裸对象和 markdown 围栏', () => {
    expect(parseModelJson('{"capabilityId":"run.diagnose"}')).toEqual({
      capabilityId: 'run.diagnose',
    })
    expect(parseModelJson('```json\n{"summary":"场景共 1 步"}\n```')).toEqual({
      summary: '场景共 1 步',
    })
  })
})
