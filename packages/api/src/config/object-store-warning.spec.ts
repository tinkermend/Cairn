import { describe, expect, it, vi } from 'vitest'
import { warnLocalObjectStoreTopology } from './object-store-warning'

describe('warnLocalObjectStoreTopology', () => {
  it('非 development + local 给出告警且不抛错', () => {
    const warn = vi.fn()
    expect(() =>
      warnLocalObjectStoreTopology({ CAIRN_ENV: 'production', CAIRN_OBJECT_STORE: 'local' }, warn),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/CAIRN_OBJECT_STORE=local/)
  })

  it('development 或 s3 不告警', () => {
    const warn = vi.fn()
    warnLocalObjectStoreTopology({ CAIRN_ENV: 'development', CAIRN_OBJECT_STORE: 'local' }, warn)
    warnLocalObjectStoreTopology({ CAIRN_ENV: 'production', CAIRN_OBJECT_STORE: 's3' }, warn)
    expect(warn).not.toHaveBeenCalled()
  })
})
