import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepairCandidate } from '@cairn/shared'
import { fetchScenarioResolutionStats } from '@/lib/scenarios-api'
import {
  fetchScenarioRepairCandidates,
  adoptRepairCandidate,
  rejectRepairCandidate,
} from '@/lib/repair-api'
import { toast } from 'sonner'

export type StepLocatorStatus = 'untested' | 'healthy' | 'fallback_warning' | 'failing'

export interface StepLocatorHealth {
  stepId: string
  status: StepLocatorStatus
  deterministic: number
  map: number
  ai: number
  failed: number
  located: number
  ruleHitRate: number | null
  fallbackRate: number | null
  activeCandidate?: RepairCandidate
}

export interface ScenarioLocatorHealthResult {
  healthMap: Map<string, StepLocatorHealth>
  overallScore: number
  healthyCount: number
  warningCount: number
  failingCount: number
  candidateCount: number
  candidates: RepairCandidate[]
  isLoading: boolean
  isError: boolean
  adoptCandidate: (candidate: RepairCandidate, currentDraftRevision: number) => Promise<void>
  rejectCandidate: (candidateId: string) => Promise<void>
  batchAdoptAll: (currentDraftRevision: number) => Promise<{ adoptedCount: number }>
}

export function useScenarioLocatorHealth(
  scenarioId: string,
  steps?: readonly { id: string; name?: string }[],
  onApplyCandidatesToDraft?: (candidates: Array<{ stepId: string; candidate: NonNullable<RepairCandidate['patch']['suggestedCandidate']> }>) => void,
): ScenarioLocatorHealthResult {
  const queryClient = useQueryClient()

  const statsQuery = useQuery({
    queryKey: ['scenarios', scenarioId, 'resolution-stats'],
    queryFn: () => fetchScenarioResolutionStats(scenarioId),
    enabled: Boolean(scenarioId),
  })

  const candidatesQuery = useQuery({
    queryKey: ['scenario-repair-candidates', scenarioId],
    queryFn: () => fetchScenarioRepairCandidates(scenarioId),
    enabled: Boolean(scenarioId),
  })

  const rawStats = statsQuery.data?.items ?? []
  const allCandidates = candidatesQuery.data ?? []

  // 仅筛选待处理或已验证的有效候选
  const activeCandidates = useMemo(() => {
    return allCandidates.filter(
      (c) => c.status === 'proposed' || c.status === 'validated' || c.status === 'validating',
    )
  }, [allCandidates])

  const candidateByStep = useMemo(() => {
    const map = new Map<string, RepairCandidate>()
    for (const c of activeCandidates) {
      const stepId = c.patchTargetRef.stepId
      if (stepId && !map.has(stepId)) {
        map.set(stepId, c)
      }
    }
    return map
  }, [activeCandidates])

  const healthMap = useMemo(() => {
    const map = new Map<string, StepLocatorHealth>()

    // 1. 聚合历史运行数据
    const aggregatedStats = new Map<
      string,
      { deterministic: number; map: number; ai: number; failed: number }
    >()
    for (const item of rawStats) {
      const cur = aggregatedStats.get(item.stepId) ?? {
        deterministic: 0,
        map: 0,
        ai: 0,
        failed: 0,
      }
      cur.deterministic += item.deterministic
      cur.map += item.map
      cur.ai += item.ai
      cur.failed += item.failed
      aggregatedStats.set(item.stepId, cur)
    }

    // 2. 遍历已知步骤构建健康度
    if (steps) {
      for (const step of steps) {
        const counts = aggregatedStats.get(step.id) ?? {
          deterministic: 0,
          map: 0,
          ai: 0,
          failed: 0,
        }
        const located = counts.deterministic + counts.map + counts.ai
        const ruleHitRate = located === 0 ? null : (counts.deterministic + counts.map) / located
        const fallbackRate = located === 0 ? null : counts.ai / located

        let status: StepLocatorStatus = 'untested'
        if (counts.failed > 0 && located === 0) {
          status = 'failing'
        } else if (counts.ai > 0) {
          status = 'fallback_warning'
        } else if (located > 0) {
          status = 'healthy'
        }

        map.set(step.id, {
          stepId: step.id,
          status,
          ...counts,
          located,
          ruleHitRate,
          fallbackRate,
          activeCandidate: candidateByStep.get(step.id),
        })
      }
    }

    return map
  }, [rawStats, steps, candidateByStep])

  // 计算全局健康度得分与计数
  const { overallScore, healthyCount, warningCount, failingCount } = useMemo(() => {
    let healthy = 0
    let warning = 0
    let failing = 0

    for (const health of healthMap.values()) {
      if (health.status === 'healthy') healthy++
      else if (health.status === 'fallback_warning') warning++
      else if (health.status === 'failing') failing++
    }

    // 100 分扣减制
    const score = Math.max(0, 100 - warning * 10 - failing * 25)

    return {
      overallScore: score,
      healthyCount: healthy,
      warningCount: warning,
      failingCount: failing,
    }
  }, [healthMap])

  const adoptCandidate = async (candidate: RepairCandidate, currentDraftRevision: number) => {
    try {
      const suggestedCandidate = candidate.patch.suggestedCandidate
      const stepId = candidate.patchTargetRef.stepId
      if (suggestedCandidate && stepId && onApplyCandidatesToDraft) {
        onApplyCandidatesToDraft([{ stepId, candidate: suggestedCandidate }])
      }

      await adoptRepairCandidate(candidate.id, { expectedRevision: currentDraftRevision })
      toast.success('已采纳新定位规则！新规则已置顶，原规则已保留为备用。按 Ctrl+Z 可撤销。')
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
      void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'repair-candidates'] })
      void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'resolution-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
    } catch {
      toast.error('采纳修复规则失败，请稍后重试')
    }
  }

  const rejectCandidate = async (candidateId: string) => {
    try {
      await rejectRepairCandidate(candidateId)
      toast.info('已忽略此自愈建议')
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
      void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'repair-candidates'] })
    } catch {
      toast.error('操作失败')
    }
  }

  const batchAdoptAll = async (currentDraftRevision: number) => {
    const listToAdopt: Array<{ stepId: string; candidate: NonNullable<RepairCandidate['patch']['suggestedCandidate']> }> = []
    const candidateIds: string[] = []

    for (const c of activeCandidates) {
      const stepId = c.patchTargetRef.stepId
      const suggested = c.patch.suggestedCandidate
      if (stepId && suggested) {
        listToAdopt.push({ stepId, candidate: suggested })
        candidateIds.push(c.id)
      }
    }

    if (listToAdopt.length === 0) {
      toast.info('当前没有待采纳的自愈建议')
      return { adoptedCount: 0 }
    }

    if (onApplyCandidatesToDraft) {
      onApplyCandidatesToDraft(listToAdopt)
    }

    let successCount = 0
    for (const id of candidateIds) {
      try {
        await adoptRepairCandidate(id, { expectedRevision: currentDraftRevision })
        successCount++
      } catch {
        // 部分单条失败继续尝试其他
      }
    }

    toast.success(`成功一键自愈 ${successCount} 个步骤的定位规则！`)
    void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
    void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'repair-candidates'] })
    void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'resolution-stats'] })
    void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
    return { adoptedCount: successCount }
  }

  return {
    healthMap,
    overallScore,
    healthyCount,
    warningCount,
    failingCount,
    candidateCount: activeCandidates.length,
    candidates: activeCandidates,
    isLoading: statsQuery.isLoading || candidatesQuery.isLoading,
    isError: statsQuery.isError || candidatesQuery.isError,
    adoptCandidate,
    rejectCandidate,
    batchAdoptAll,
  }
}
