import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_USAGES,
  accountAllowsBusiness,
  accountAllowsMap,
  mapUsageGuardFor,
} from '../account-usage.js'

describe('账号用途', () => {
  it('business / map / both 资格互斥清晰', () => {
    expect(ACCOUNT_USAGES).toEqual(['business', 'map', 'both'])
    expect(accountAllowsMap('business')).toBe(false)
    expect(accountAllowsMap('map')).toBe(true)
    expect(accountAllowsMap('both')).toBe(true)
    expect(accountAllowsBusiness('map')).toBe(false)
    expect(accountAllowsBusiness('business')).toBe(true)
    expect(accountAllowsBusiness(undefined)).toBe(true)
    expect(mapUsageGuardFor('both')).toBe('Y')
    expect(mapUsageGuardFor('business')).toBeNull()
  })
})
