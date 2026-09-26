import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchScenarioResolutionStats } from '@/lib/scenarios-api'
import { CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ScenarioResolutionStatsProps {
  scenarioId: string
  steps?: readonly { id: string; name?: string }[]
  onSelectStep?: (stepId: string) => void
}

interface AggregatedStepStats {
  stepId: string
  stepName: string
  stepIndex: number | null
  existsInDraft: boolean
  deterministic: number
  map: number
  ai: number
  failed: number
  located: number
  ruleHitRate: number | null
  fallbackRate: number | null
}

export function ScenarioResolutionStats({
  scenarioId,
  steps,
  onSelectStep,
}: ScenarioResolutionStatsProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showHistorical, setShowHistorical] = useState(false)
  const query = useQuery({
    queryKey: ['scenarios', scenarioId, 'resolution-stats'],
    queryFn: () => fetchScenarioResolutionStats(scenarioId),
  })

  const stepMap = useMemo(() => {
    const map = new Map<string, { step: { id: string; name?: string }; index: number }>()
    if (steps) {
      steps.forEach((step, idx) => {
        map.set(step.id, { step, index: idx })
      })
    }
    return map
  }, [steps])

  const items = query.data?.items ?? []

  const aggregatedList = useMemo(() => {
    if (items.length === 0) return []
    const byStep = new Map<
      string,
      {
        deterministic: number
        map: number
        ai: number
        failed: number
        historicalName?: string | null
      }
    >()
    for (const item of items) {
      const existing = byStep.get(item.stepId) ?? {
        deterministic: 0,
        map: 0,
        ai: 0,
        failed: 0,
        historicalName: item.stepName ?? null,
      }
      existing.deterministic += item.deterministic
      existing.map += item.map
      existing.ai += item.ai
      existing.failed += item.failed
      if (!existing.historicalName && item.stepName) {
        existing.historicalName = item.stepName
      }
      byStep.set(item.stepId, existing)
    }

    const list: AggregatedStepStats[] = []
    for (const [stepId, counts] of byStep.entries()) {
      const located = counts.deterministic + counts.map + counts.ai
      const ruleHitRate = located === 0 ? null : (counts.deterministic + counts.map) / located
      const fallbackRate = located === 0 ? null : counts.ai / located
      const stepMeta = stepMap.get(stepId)
      const rawName = stepMeta?.step.name || counts.historicalName
      const stepName = stepMeta
        ? (rawName || '未命名步骤')
        : (rawName ? `历史步骤 · ${rawName}` : '未命名历史步骤')

      list.push({
        stepId,
        stepName,
        stepIndex: stepMeta ? stepMeta.index + 1 : null,
        existsInDraft: Boolean(stepMeta),
        ...counts,
        located,
        ruleHitRate,
        fallbackRate,
      })
    }

    // 优先按草稿内步骤顺序排序，历史步骤排在最后
    return list.sort((a, b) => {
      if (a.stepIndex !== null && b.stepIndex !== null) return a.stepIndex - b.stepIndex
      if (a.stepIndex !== null) return -1
      if (b.stepIndex !== null) return 1
      return a.stepId.localeCompare(b.stepId)
    })
  }, [items, stepMap])

  if (query.isError) {
    return <p className='text-label text-muted-foreground'>解析统计暂时读不到。</p>
  }
  if (query.isLoading) return <p className='text-label text-muted-foreground'>正在读取定位健康度…</p>
  if (aggregatedList.length === 0) return null

  const activeSteps = aggregatedList.filter((s) => s.existsInDraft)
  const historicalSteps = aggregatedList.filter((s) => !s.existsInDraft)

  // 统计以当前草稿为主；若草稿全未测过则看整体
  const targetForSummary = activeSteps.length > 0 ? activeSteps : aggregatedList
  const stepsWithAi = targetForSummary.filter((s) => s.ai > 0).length
  const stepsWithFailures = targetForSummary.filter((s) => s.failed > 0 && s.located === 0).length

  const renderStepItem = (item: AggregatedStepStats) => {
    const rulePercent =
      item.ruleHitRate == null ? null : Math.round(item.ruleHitRate * 100)
    const fallbackPercent =
      item.fallbackRate == null ? null : Math.round(item.fallbackRate * 100)
    const isWarning = item.ai > 0
    const isError = item.located === 0 && item.failed > 0

    return (
      <li
        key={item.stepId}
        className={cn(
          'rounded-md border p-2 text-label transition-colors',
          isError
            ? 'border-status-error/30 bg-status-error-background/10'
            : isWarning
              ? 'border-status-warning/30 bg-status-warning-background/10'
              : 'border-border-default/60 bg-card',
          item.existsInDraft && onSelectStep
            ? 'cursor-pointer hover:border-primary/50 hover:shadow-xs'
            : 'opacity-90',
        )}
        onClick={() => {
          if (item.existsInDraft && onSelectStep) {
            onSelectStep(item.stepId)
          }
        }}
        title={
          item.existsInDraft
            ? '点击在编辑器中选中此步骤'
            : `此步骤曾在历史运行中执行（ID: ${item.stepId.slice(0, 8)}），当前草稿中已无此步骤`
        }
      >
        <div className='flex items-center justify-between gap-2'>
          <div className='flex items-center gap-1.5 min-w-0'>
            {isError ? (
              <XCircle className='size-3.5 shrink-0 text-status-error-foreground' />
            ) : isWarning ? (
              <AlertTriangle className='size-3.5 shrink-0 text-status-warning-foreground' />
            ) : (
              <CheckCircle2 className='size-3.5 shrink-0 text-status-success-foreground' />
            )}
            <span className='font-medium text-foreground truncate'>
              {item.stepIndex !== null ? `第 ${item.stepIndex} 步 · ` : ''}
              {item.stepName}
            </span>
            {!item.existsInDraft && (
              <span className='shrink-0 rounded bg-muted px-1.5 py-0.2 text-3xs text-muted-foreground'>
                已从草稿移除
              </span>
            )}
          </div>
          <span
            className={cn(
              'shrink-0 text-2xs px-1.5 py-0.5 rounded font-medium',
              isError
                ? 'bg-status-error-background text-status-error-foreground'
                : isWarning
                  ? 'bg-status-warning-background text-status-warning-foreground'
                  : 'bg-status-success-background text-status-success-foreground',
            )}
          >
            {isError
              ? `定位失败 (${item.failed})`
              : isWarning
                ? `规则命中 ${rulePercent}%（AI 兜底 ${fallbackPercent}%）`
                : '规则稳定 (100%)'}
          </span>
        </div>
        <div className='mt-1 flex items-center justify-between text-2xs text-muted-foreground'>
          <span>
            {item.located > 0 ? (
              isWarning ? (
                <>
                  命中 {item.located} 次（规则命中率 {rulePercent}% · AI 兜底 {item.ai} 次）
                </>
              ) : (
                <>成功命中 {item.located} 次（全靠规则直接定位，零 AI 消耗）</>
              )
            ) : (
              <>未能成功定位目标</>
            )}
          </span>
          {item.failed > 0 && item.located > 0 ? (
            <span className='text-status-error-foreground'>失败 {item.failed} 次</span>
          ) : null}
        </div>
      </li>
    )
  }

  return (
    <section
      data-testid='scenario-resolution-stats'
      className='rounded-lg border border-border-divider/80 bg-surface-subtle/50 p-3 space-y-2.5'
      aria-label='元素定位稳定性'
    >
      <div className='flex items-center justify-between'>
        <button
          type='button'
          className='flex items-center gap-1.5 text-left font-semibold text-body text-foreground hover:text-primary transition-colors'
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronRight className='size-4 text-muted-foreground' />
          ) : (
            <ChevronDown className='size-4 text-muted-foreground' />
          )}
          <span>元素定位稳定性（规则命中率）</span>
        </button>
        <div className='flex items-center gap-1 text-2xs'>
          {stepsWithAi > 0 && (
            <span className='px-1.5 py-0.5 rounded bg-status-warning-background text-status-warning-foreground font-medium'>
              {stepsWithAi} 步发生规则衰减
            </span>
          )}
          {stepsWithFailures > 0 && (
            <span className='px-1.5 py-0.5 rounded bg-status-error-background text-status-error-foreground font-medium'>
              {stepsWithFailures} 步定位失败
            </span>
          )}
          {stepsWithAi === 0 && stepsWithFailures === 0 && (
            <span className='px-1.5 py-0.5 rounded bg-status-success-background text-status-success-foreground font-medium'>
              全部规则 100% 命中
            </span>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          <p className='text-label text-muted-foreground leading-normal'>
            统计历史运行中各步骤定位目标元素的健康度。规则命中率 100% 表示满分稳定（全部规则直接命中）；一旦发生衰减扣减（如 90%、80%），说明部分运行依赖了 AI 视觉自愈兜底，建议更新对应步骤的选择器。
          </p>

          {activeSteps.length > 0 ? (
            <ul className='space-y-1.5 pt-1'>
              {activeSteps.map(renderStepItem)}
            </ul>
          ) : (
            <p className='text-label text-muted-foreground py-1'>
              当前草稿中的步骤暂无定位运行记录。
            </p>
          )}

          {historicalSteps.length > 0 && (
            <div className='pt-2 border-t border-border-divider/60 space-y-1.5'>
              <button
                type='button'
                className='flex items-center gap-1.5 text-label font-medium text-muted-foreground hover:text-foreground transition-colors'
                onClick={() => setShowHistorical(!showHistorical)}
              >
                {showHistorical ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
                <span>已从当前草稿移除的历史步骤 ({historicalSteps.length})</span>
              </button>
              {showHistorical && (
                <>
                  <p className='text-2xs text-muted-foreground leading-normal'>
                    以下步骤曾在历史运行中执行并留存定位记录，但在当前草稿中已不存在。保留供参考定位衰减历史。
                  </p>
                  <ul className='space-y-1.5 pt-0.5'>
                    {historicalSteps.map(renderStepItem)}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
