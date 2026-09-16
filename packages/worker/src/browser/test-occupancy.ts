import type { SessionGrant } from '@cairn/shared'
import { runWithOccupancy } from './runtime'

export function testOccupancyGrant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000a1',
    leaseId: '00000000-0000-4000-8000-0000000000a2',
    generation: 1,
    sessionFencingToken: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    purpose: 'EXECUTION',
    ownerKind: 'RUN',
    ...overrides,
  }
}

export function withTestOccupancy<T>(fn: () => Promise<T> | T, grant?: SessionGrant): Promise<T> | T {
  return runWithOccupancy(grant ?? testOccupancyGrant(), fn)
}
