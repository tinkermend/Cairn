import { describe, expect, it } from 'vitest'
import { apiErrorSchema, errorCodeForStatus, REQUEST_ID_HEADER } from '../error.js'

describe('apiErrorSchema', () => {
  const base = { code: 'NOT_FOUND', message: '资源不存在', requestId: 'req-1' }

  it('接受最小错误体', () => {
    expect(apiErrorSchema.parse(base)).toEqual(base)
  })

  it('接受带 issues 的校验错误', () => {
    const withIssues = {
      ...base,
      code: 'BAD_REQUEST',
      issues: [{ path: 'name', code: 'too_small', message: '不能为空' }],
    }
    expect(apiErrorSchema.parse(withIssues).issues).toHaveLength(1)
  })

  it('requestId 是必填——没有它就无法关联服务端日志', () => {
    const { requestId: _drop, ...without } = base
    expect(() => apiErrorSchema.parse(without)).toThrow()
  })

  it('拒绝空 code', () => {
    expect(() => apiErrorSchema.parse({ ...base, code: '' })).toThrow()
  })
})

describe('errorCodeForStatus', () => {
  it('已知状态码映射到稳定代码', () => {
    expect(errorCodeForStatus(401)).toBe('UNAUTHENTICATED')
    expect(errorCodeForStatus(404)).toBe('NOT_FOUND')
  })

  it('未列出的 5xx 归入 INTERNAL_ERROR', () => {
    expect(errorCodeForStatus(502)).toBe('INTERNAL_ERROR')
  })

  it('未列出的 4xx 归入 REQUEST_FAILED', () => {
    expect(errorCodeForStatus(418)).toBe('REQUEST_FAILED')
  })
})

describe('REQUEST_ID_HEADER', () => {
  it('与命名约定一致（小写，供 header 比较）', () => {
    expect(REQUEST_ID_HEADER).toBe('x-cairn-run-id')
  })
})
