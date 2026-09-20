import * as React from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import type { OverviewOutcomes, OverviewTriggers } from '@cairn/shared'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

const outcomeConfig: ChartConfig = {
  passed: { label: '断言达成 (PASS)', color: 'var(--status-success)' },
  violation: { label: '业务违规 (WARN)', color: 'var(--status-warning)' },
  failed: { label: '断言失败 (FAIL)', color: 'var(--status-error)' },
  notEvaluated: { label: '未求值 (NONE)', color: 'var(--chart-3)' },
}

const triggerConfig: ChartConfig = {
  manual: { label: '控制台手动', color: 'var(--chart-1)' },
  schedule: { label: '定时自动复查', color: 'var(--chart-2)' },
  serviceApi: { label: '开放服务 API', color: 'var(--chart-4)' },
  suiteMember: { label: '场景集批量', color: 'var(--chart-5)' },
}

export function OutcomesDonut({
  outcomes,
  triggers,
}: {
  outcomes?: OverviewOutcomes
  triggers?: OverviewTriggers
}) {
  const [tab, setTab] = React.useState<'outcomes' | 'triggers'>('outcomes')

  const outcomeData = React.useMemo(() => {
    if (!outcomes) return []
    return [
      { name: 'passed', value: outcomes.passed, label: '断言达成', color: 'var(--status-success)' },
      { name: 'violation', value: outcomes.violation, label: '业务违规', color: 'var(--status-warning)' },
      { name: 'failed', value: outcomes.failed, label: '断言失败', color: 'var(--status-error)' },
      { name: 'notEvaluated', value: outcomes.notEvaluated, label: '未求值', color: 'var(--chart-3)' },
    ].filter((item) => item.value > 0)
  }, [outcomes])

  const triggerData = React.useMemo(() => {
    if (!triggers) return []
    return [
      { name: 'manual', value: triggers.manual, label: '控制台手动', color: 'var(--chart-1)' },
      { name: 'schedule', value: triggers.schedule, label: '定时自动复查', color: 'var(--chart-2)' },
      { name: 'serviceApi', value: triggers.serviceApi, label: '开放服务 API', color: 'var(--chart-4)' },
      { name: 'suiteMember', value: triggers.suiteMember, label: '场景集批量', color: 'var(--chart-5)' },
    ].filter((item) => item.value > 0)
  }, [triggers])

  const activeData = tab === 'outcomes' ? outcomeData : triggerData
  const activeConfig = tab === 'outcomes' ? outcomeConfig : triggerConfig
  const totalCount = activeData.reduce((acc, curr) => acc + curr.value, 0)

  // 主导比例
  const topItem = activeData.length > 0 ? [...activeData].sort((a, b) => b.value - a.value)[0] : null
  const topPercent = topItem && totalCount > 0 ? Math.round((topItem.value / totalCount) * 100) : 0

  return (
    <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
      <div className="flex items-center justify-between gap-2 pb-3">
        <div>
          <h2 className="text-section font-semibold text-text-primary">
            {tab === 'outcomes' ? '业务成果断言分布' : '运行触发来源构成'}
          </h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            {tab === 'outcomes'
              ? 'Outcome 契约判定：区分代码跑通与业务达成'
              : '分析场景运行的发起来源渠道'}
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="h-7 bg-surface-subtle p-0.5">
            <TabsTrigger value="outcomes" className="h-6 px-2 text-label">
              业务成果
            </TabsTrigger>
            <TabsTrigger value="triggers" className="h-6 px-2 text-label">
              触发来源
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="relative flex h-[220px] w-full items-center justify-center pt-1">
        {activeData.length === 0 ? (
          <p className="text-body text-muted-foreground">本周期暂无记录</p>
        ) : (
          <>
            <ChartContainer config={activeConfig} className="h-full w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        hideLabel
                        formatter={(value, name) => {
                          const item = activeData.find((d) => d.name === name)
                          const pct = totalCount > 0 ? Math.round((Number(value) / totalCount) * 100) : 0
                          return (
                            <div className="flex items-center justify-between gap-3 text-label">
                              <span className="text-muted-foreground">{item?.label ?? name}:</span>
                              <span className="font-mono font-medium text-foreground">
                                {Number(value).toLocaleString()} ({pct}%)
                              </span>
                            </div>
                          )
                        }}
                      />
                    }
                  />
                  <Pie
                    data={activeData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={58}
                    outerRadius={82}
                    strokeWidth={2}
                    stroke="var(--card)"
                    paddingAngle={2}
                  >
                    {activeData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </ChartContainer>

            {/* 中心指标插槽 */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-stat font-semibold tabular-nums text-text-primary">
                {topPercent}%
              </span>
              <span className="text-label text-muted-foreground line-clamp-1 max-w-[90px] text-center">
                {topItem?.label ?? '占比'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* 底部精简图例条 */}
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border-divider pt-3 text-label">
        {activeData.map((item) => {
          const pct = totalCount > 0 ? Math.round((item.value / totalCount) * 100) : 0
          return (
            <div key={item.name} className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 overflow-hidden">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
                <span className="truncate text-muted-foreground">{item.label}</span>
              </div>
              <span className="font-mono tabular-nums text-text-primary">
                {pct}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
