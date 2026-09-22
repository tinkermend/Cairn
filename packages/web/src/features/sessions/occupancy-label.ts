export function accountSessionOccupancyText(input: {
  liveCount?: number | null
  effectiveCap?: number | null
}): string | null {
  const cap = input.effectiveCap ?? 1
  if (cap <= 1) return null
  return `${input.liveCount ?? 0}/${cap}`
}

export function systemSessionOccupancyHint(input: {
  accountCount: number
  liveSessionCount?: number | null
  sessionCapTotal?: number | null
}): string | null {
  const capTotal = input.sessionCapTotal ?? 0
  if (capTotal <= input.accountCount) return null
  return `会话 ${input.liveSessionCount ?? 0}/${capTotal}`
}
