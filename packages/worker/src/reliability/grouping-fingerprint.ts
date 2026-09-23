import { createHash } from 'node:crypto'

export interface GroupingFingerprintInput {
  targetId: string
  accountId?: string
  moduleId?: string
  moduleVersion?: string
  implementationKey?: string
  internalStepId?: string
  errorFamily?: string
}

export function computeGroupingFingerprint(input: GroupingFingerprintInput): string {
  const normalized = [
    input.targetId.trim(),
    (input.accountId ?? '').trim(),
    (input.moduleId ?? '').trim(),
    (input.moduleVersion ?? '').trim(),
    (input.implementationKey ?? '').trim(),
    (input.internalStepId ?? '').trim(),
    (input.errorFamily ?? 'UNKNOWN_ERROR').trim().toUpperCase(),
  ].join('::')

  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}
