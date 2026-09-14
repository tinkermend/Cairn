import { describe, expect, it } from 'vitest'
import { clientContextFromRequest, normalizeClientIp } from './client-context'

describe('clientContextFromRequest', () => {
  it('hops=0 时忽略伪造的 X-Forwarded-For，只用套接字地址', () => {
    const client = clientContextFromRequest(
      {
        ip: '203.0.113.9',
        socket: { remoteAddress: '::ffff:10.0.0.4' },
        headers: {
          'x-forwarded-for': '198.51.100.1',
          'user-agent': 'Mozilla/5.0',
        },
      },
      0,
    )
    expect(client.ip).toBe('10.0.0.4')
    expect(client.kind).toBe('web')
  })

  it('hops>0 时使用框架解析后的 req.ip', () => {
    const client = clientContextFromRequest(
      {
        ip: '198.51.100.8',
        socket: { remoteAddress: '10.0.0.1' },
        headers: { origin: 'chrome-extension://abcdef' },
      },
      1,
    )
    expect(client.ip).toBe('198.51.100.8')
    expect(client.kind).toBe('extension')
  })

  it('取不到地址时为 null，不编造 0.0.0.0', () => {
    expect(normalizeClientIp(undefined)).toBeNull()
    expect(
      clientContextFromRequest({ socket: {}, headers: {} }, 0).ip,
    ).toBeNull()
  })
})
