import { z } from 'zod'

export const ACCOUNT_USAGES = ['business', 'map', 'both'] as const
export type AccountUsage = (typeof ACCOUNT_USAGES)[number]
export const accountUsageSchema = z.enum(ACCOUNT_USAGES)
export const DEFAULT_ACCOUNT_USAGE = 'business' as const

export function accountAllowsMap(usage: AccountUsage | string | null | undefined): boolean {
  return usage === 'map' || usage === 'both'
}

export function accountAllowsBusiness(usage: AccountUsage | string | null | undefined): boolean {
  return usage === 'business' || usage === 'both' || usage == null || usage === ''
}

export function mapUsageGuardFor(usage: AccountUsage | string | null | undefined): string | null {
  return accountAllowsMap(usage) ? 'Y' : null
}
