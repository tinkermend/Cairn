import { describe, expect, it } from 'vitest'
import {
  claimRecordingBindingBodySchema,
  normalizeApiOrigin,
  recordingStudioPath,
  urlAllowedForRecording,
} from '../recording-import.js'

describe('录制导入契约', () => {
  it('领取必须带 ticket 或 bindingId，origin 去掉尾斜杠', () => {
    expect(() =>
      claimRecordingBindingBodySchema.parse({ apiOrigin: 'http://localhost:3030' }),
    ).toThrow()
    expect(
      claimRecordingBindingBodySchema.parse({
        bindingId: '11111111-1111-4111-8111-111111111111',
        apiOrigin: 'http://localhost:3030',
      }).bindingId,
    ).toBe('11111111-1111-4111-8111-111111111111')
    expect(normalizeApiOrigin('http://localhost:3030/')).toBe('http://localhost:3030')
    expect(recordingStudioPath('33333333-3333-4333-8333-333333333333')).toBe(
      '/scenarios/33333333-3333-4333-8333-333333333333',
    )
    expect(urlAllowedForRecording('https://shop.example.com/orders', ['https://shop.example.com'])).toBe(true)
    expect(urlAllowedForRecording('https://evil.example/orders', ['https://shop.example.com'])).toBe(false)
  })
})
