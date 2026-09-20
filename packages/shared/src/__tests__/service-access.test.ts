import { describe, expect, it } from 'vitest'
import {
  serviceCallerQuerySchema,
  serviceCallerQueryValueSchema,
  serviceCredentialMetadataBodySchema,
  serviceIpWhitelistBodySchema,
  serviceRequestLogQuerySchema,
} from '../service-access.js'
import { isIpAllowedByAllowlist, normalizeIpAddress, normalizeIpAllowlist } from '../service-network.js'

describe('service access console contracts', () => {
  it('parses includeArchived only from exact boolean values', () => {
    expect(serviceCallerQuerySchema.parse({}).includeArchived).toBe(false)
    expect(serviceCallerQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true)
    expect(serviceCallerQuerySchema.parse({ includeArchived: 'false' }).includeArchived).toBe(false)
    expect(serviceCallerQueryValueSchema.parse({ includeArchived: true }).includeArchived).toBe(true)
    for (const value of ['TRUE', 'FALSE', '1', '0', '', true, false, ['false'], { value: 'false' }]) {
      expect(() => serviceCallerQuerySchema.parse({ includeArchived: value })).toThrow()
    }
  })

  it('keeps service-key display metadata separate and bounded', () => {
    expect(
      serviceCredentialMetadataBodySchema.parse({
        name: '生产接入 Key',
        notes: '轮换窗口：周三',
        expectedMetadataRevision: 2,
      }),
    ).toEqual({
      name: '生产接入 Key',
      notes: '轮换窗口：周三',
      expectedMetadataRevision: 2,
    })
    expect(
      serviceCredentialMetadataBodySchema.parse({
        name: '生产接入 Key',
        notes: '   ',
        expectedMetadataRevision: 3,
      }).notes,
    ).toBeNull()
    expect(() =>
      serviceCredentialMetadataBodySchema.parse({
        name: 'Key',
        notes: null,
        expectedMetadataRevision: 0,
      }),
    ).toThrow()
  })

  it('normalizes IPv4/IPv6 CIDR policies and fails closed for unknown sources', () => {
    expect(normalizeIpAddress('::ffff:203.0.113.8')).toBe('203.0.113.8')
    expect(normalizeIpAddress('203.0.113.8::')).toBeNull()
    expect(normalizeIpAllowlist(['203.0.113.199/24', '2001:0db8::/32'])).toEqual([
      '203.0.113.0/24',
      '2001:db8::/32',
    ])
    expect(
      serviceIpWhitelistBodySchema.parse({ entries: ['203.0.113.199/24', '2001:0db8::/32'] }),
    ).toEqual({ entries: ['203.0.113.0/24', '2001:db8::/32'] })
    expect(() => serviceIpWhitelistBodySchema.parse({ entries: ['203.0.113.1', '203.0.113.1'] })).toThrow()
    expect(isIpAllowedByAllowlist('203.0.113.8', ['203.0.113.0/24'])).toBe(true)
    expect(isIpAllowedByAllowlist('203.0.114.8', ['203.0.113.0/24'])).toBe(false)
    expect(isIpAllowedByAllowlist('2001:db8:1::8', ['2001:db8::/32'])).toBe(true)
    expect(isIpAllowedByAllowlist(null, ['203.0.113.0/24'])).toBe(false)
  })

  it('rejects inverted request-log time ranges', () => {
    expect(() =>
      serviceRequestLogQuerySchema.parse({
        startAt: '2026-09-20T00:00:00.000Z',
        endAt: '2026-09-19T00:00:00.000Z',
      }),
    ).toThrow()
  })
})
