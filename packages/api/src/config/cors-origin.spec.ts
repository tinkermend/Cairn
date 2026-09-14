import { describe, expect, it } from 'vitest'
import { isAllowedCorsOrigin } from './cors-origin'

const web = ['http://localhost:5173'] as const

describe('CORS origin', () => {
  it('放行控制台白名单和无 Origin 的非浏览器调用', () => {
    expect(isAllowedCorsOrigin(undefined, web)).toBe(true)
    expect(isAllowedCorsOrigin('http://localhost:5173', web)).toBe(true)
    expect(isAllowedCorsOrigin('https://evil.example', web)).toBe(false)
  })

  it('放行识途录制器扩展页，不要求把扩展 ID 写进环境变量', () => {
    expect(isAllowedCorsOrigin('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef', web)).toBe(
      true,
    )
  })

  it('白名单为 * 时仍放行任意 Origin', () => {
    expect(isAllowedCorsOrigin('https://other.example', ['*'])).toBe(true)
  })
})
