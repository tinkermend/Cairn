import { describe, expect, it } from 'vitest'
import {
  apiErrorSchema,
  errorCodeForStatus,
  isRequestId,
  REQUEST_ID_HEADER,
  requestIdValueSchema,
  resolveRequestId,
  UPSTREAM_REQUEST_ID_HEADER,
} from '../error.js'

describe('apiErrorSchema', () => {
  const base = { code: 'NOT_FOUND', message: '资源不存在', requestId: 'req-1' }

  it('接受最小错误体', () => {
    expect(apiErrorSchema.parse(base)).toEqual(base)
  })

  it('接受带 details 的领域错误', () => {
    expect(apiErrorSchema.parse({ ...base, details: { revision: 2 } }).details).toEqual({
      revision: 2,
    })
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
  // 头名是对外契约：断言字面串，避免改名后测试跟着常量一起自动全绿。
  it('出站只写平台私有头，与关联 ID 语义一致', () => {
    expect(REQUEST_ID_HEADER).toBe('x-cairn-request-id')
    expect(UPSTREAM_REQUEST_ID_HEADER).toBe('x-request-id')
  })

  it('不再接受旧头 x-cairn-run-id', () => {
    expect(resolveRequestId({ 'x-cairn-run-id': 'legacy-1' })).toBeUndefined()
  })
})

describe('resolveRequestId', () => {
  it('平台私有头优先', () => {
    expect(
      resolveRequestId({
        [REQUEST_ID_HEADER]: 'req-1',
        [UPSTREAM_REQUEST_ID_HEADER]: 'gw-1',
      }),
    ).toBe('req-1')
  })

  it('私有头缺失时接住网关已有的请求 ID', () => {
    expect(resolveRequestId({ [UPSTREAM_REQUEST_ID_HEADER]: 'gw-1' })).toBe('gw-1')
  })

  it('都没有时返回 undefined，由调用方自生成', () => {
    expect(resolveRequestId({})).toBeUndefined()
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: '' })).toBeUndefined()
  })

  it('重复头取第一个值', () => {
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: ['req-1', 'req-2'] })).toBe('req-1')
  })

  it('超长的值不被采纳——它会原样进响应头与每一行日志', () => {
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: 'a'.repeat(128) })).toHaveLength(128)
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: 'a'.repeat(129) })).toBeUndefined()
  })

  it('形状不合规的值不被采纳', () => {
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: 'req 1' })).toBeUndefined()
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: 'req/../1' })).toBeUndefined()
    expect(resolveRequestId({ [REQUEST_ID_HEADER]: '你好' })).toBeUndefined()
  })

  it('私有头不合规时继续看网关头，而不是直接放弃', () => {
    expect(
      resolveRequestId({
        [REQUEST_ID_HEADER]: 'bad value',
        [UPSTREAM_REQUEST_ID_HEADER]: 'gw-1',
      }),
    ).toBe('gw-1')
  })

  it('UUID 与常见网关 ID 形状都在允许集内', () => {
    for (const id of [
      '8a92cbb2-a6c5-4929-8968-e7d2eb39f611',
      '0a1b2c3d4e5f6071',
      'req_2f8a.9-b:1',
    ]) {
      expect(isRequestId(id)).toBe(true)
      expect(requestIdValueSchema.parse(id)).toBe(id)
    }
  })
})
