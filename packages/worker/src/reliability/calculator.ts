import {
  DEFAULT_RELIABILITY_POLICY,
  type EvidenceScores,
  type ReliabilityPolicyDto,
} from '@cairn/shared'

export interface StepResolutionSample {
  stepRunId: string
  attemptId: string
  targetId: string
  scopeDigest: string
  isPrimaryHit: boolean
  isFallback: boolean
  hasRetry: boolean
  durationMs: number
  success: boolean
  errorFamily?: string
  subjectRef: {
    kind: 'map_object' | 'module_step' | 'scenario_step' | 'run' | 'outcome'
    id: string
    objectId?: string
    stepId?: string
    moduleId?: string
    scenarioId?: string
  }
}

export interface WindowMetrics {
  sampleCount: number
  primaryHitCount: number
  fallbackCount: number
  retryStepCount: number
  primaryHitRate: number
  fallbackRate: number
  retryRate: number
  ewmaLatencyMs: number
  ewmaSuccessRate: number
  p95LatencyMs: number
  medianLatencyMs: number
}

export function updateEwma(previous: number, current: number, alpha: number, isInitial = false): number {
  if (isInitial || previous === 0 || previous === undefined) return current
  const clampedAlpha = Math.max(0.01, Math.min(0.99, alpha))
  return clampedAlpha * current + (1 - clampedAlpha) * previous
}

export function computeEwma(current: number, previous: number, alpha: number): number {
  return updateEwma(previous, current, alpha)
}

export function computeWindowMetrics(
  samples: StepResolutionSample[],
  previousEwmaLatency = 0,
  previousEwmaSuccessRate = 1.0,
  alpha = DEFAULT_RELIABILITY_POLICY.ewmaAlpha,
): WindowMetrics {
  const sampleCount = samples.length
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      primaryHitCount: 0,
      fallbackCount: 0,
      retryStepCount: 0,
      primaryHitRate: 1.0,
      fallbackRate: 0.0,
      retryRate: 0.0,
      ewmaLatencyMs: previousEwmaLatency,
      ewmaSuccessRate: previousEwmaSuccessRate,
      p95LatencyMs: 0,
      medianLatencyMs: 0,
    }
  }

  let primaryHitCount = 0
  let fallbackCount = 0
  let retryStepCount = 0
  let successCount = 0
  const latencies: number[] = []

  for (const s of samples) {
    if (s.isPrimaryHit) primaryHitCount++
    if (s.isFallback) fallbackCount++
    if (s.hasRetry) retryStepCount++
    if (s.success) successCount++
    latencies.push(s.durationMs)
  }

  latencies.sort((a, b) => a - b)
  const medianLatencyMs = latencies[Math.floor(latencies.length / 2)] ?? 0
  const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
  const p95LatencyMs = latencies[p95Index] ?? 0

  const primaryHitRate = sampleCount > 0 ? primaryHitCount / sampleCount : 1.0
  const fallbackRate = sampleCount > 0 ? fallbackCount / sampleCount : 0.0
  const retryRate = sampleCount > 0 ? retryStepCount / sampleCount : 0.0
  const batchSuccessRate = sampleCount > 0 ? successCount / sampleCount : 1.0
  const avgLatency = latencies.reduce((sum, v) => sum + v, 0) / sampleCount

  const ewmaLatencyMs = updateEwma(previousEwmaLatency, avgLatency, alpha, previousEwmaLatency === 0)
  const ewmaSuccessRate = updateEwma(previousEwmaSuccessRate, batchSuccessRate, alpha, previousEwmaSuccessRate === 1.0 && sampleCount > 0)

  return {
    sampleCount,
    primaryHitCount,
    fallbackCount,
    retryStepCount,
    primaryHitRate,
    fallbackRate,
    retryRate,
    ewmaLatencyMs,
    ewmaSuccessRate,
    p95LatencyMs,
    medianLatencyMs,
  }
}

export interface RuleBreach {
  ruleCode: 'PRIMARY_HIT_RATE_DROP' | 'FALLBACK_RATE_SPIKE' | 'LATENCY_DEGRADATION' | 'LOW_SUCCESS_RATE'
  severity: 'P1' | 'P2' | 'P3' | 'P4'
  message: string
  observedValue: number
  thresholdValue: number
}

export function evaluateReliabilityRules(
  metrics: WindowMetrics,
  policy: ReliabilityPolicyDto = DEFAULT_RELIABILITY_POLICY,
  baselineLatency = 0,
): RuleBreach[] {
  const breaches: RuleBreach[] = []

  // Skip checks if insufficient samples
  if (metrics.sampleCount < policy.minComparableSamples) {
    return breaches
  }

  // 1. Primary hit rate drop
  if (metrics.primaryHitRate < policy.primaryHitRateThreshold) {
    breaches.push({
      ruleCode: 'PRIMARY_HIT_RATE_DROP',
      severity: metrics.primaryHitRate < 0.6 ? 'P2' : 'P3',
      message: `主定位命中率下降至 ${(metrics.primaryHitRate * 100).toFixed(1)}%（阈值 ${(policy.primaryHitRateThreshold * 100).toFixed(1)}%）`,
      observedValue: metrics.primaryHitRate,
      thresholdValue: policy.primaryHitRateThreshold,
    })
  }

  // 2. Fallback rate spike
  if (metrics.fallbackRate > policy.fallbackRateThreshold) {
    breaches.push({
      ruleCode: 'FALLBACK_RATE_SPIKE',
      severity: metrics.fallbackRate > 0.4 ? 'P2' : 'P3',
      message: `备用定位 Fallback 率上升至 ${(metrics.fallbackRate * 100).toFixed(1)}%（阈值 ${(policy.fallbackRateThreshold * 100).toFixed(1)}%）`,
      observedValue: metrics.fallbackRate,
      thresholdValue: policy.fallbackRateThreshold,
    })
  }

  // 3. Latency degradation (if baseline latency known)
  if (baselineLatency > 0 && metrics.ewmaLatencyMs > baselineLatency * policy.latencyIncreaseRatioThreshold) {
    const ratio = metrics.ewmaLatencyMs / baselineLatency
    breaches.push({
      ruleCode: 'LATENCY_DEGRADATION',
      severity: 'P3',
      message: `执行平滑耗时增至 ${Math.round(metrics.ewmaLatencyMs)}ms，超基准 ${(ratio * 100 - 100).toFixed(0)}%`,
      observedValue: metrics.ewmaLatencyMs,
      thresholdValue: baselineLatency * policy.latencyIncreaseRatioThreshold,
    })
  }

  return breaches
}

export function computeEvidenceScores(input: {
  breachesCount: number
  supportingSamplesCount: number
  counterSamplesCount: number
  hasStructuralChangeCandidate?: boolean
  hasBusinessRejection?: boolean
}): EvidenceScores {
  let supportingScore = 0
  let counterScore = 0
  const supportingFactors: string[] = []
  const counterFactors: string[] = []

  if (input.breachesCount > 0) {
    supportingScore += 30
    supportingFactors.push(`触发 ${input.breachesCount} 项退化检测规则阈值`)
  }
  if (input.supportingSamplesCount > 0) {
    const pts = Math.min(40, input.supportingSamplesCount * 8)
    supportingScore += pts
    supportingFactors.push(`收集到 ${input.supportingSamplesCount} 次同条件异常重现事实`)
  }
  if (input.hasStructuralChangeCandidate) {
    supportingScore += 30
    supportingFactors.push('页面观察证实存在结构或属性漂移候选')
  }

  if (input.hasBusinessRejection) {
    counterScore += 40
    counterFactors.push('定位命中但业务断言失败（倾向于业务数据或权限问题而非定位漂移）')
  }
  if (input.counterSamplesCount > 0) {
    const pts = Math.min(50, input.counterSamplesCount * 10)
    counterScore += pts
    counterFactors.push(`存在 ${input.counterSamplesCount} 次相近条件下的成功正常样本`)
  }

  return {
    supportingScore: Math.min(100, supportingScore),
    counterScore: Math.min(100, counterScore),
    supportingFactors,
    counterFactors,
  }
}
