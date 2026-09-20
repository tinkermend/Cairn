import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, CheckCircle, Flame } from 'lucide-react'
import type { ScenarioRankingItem } from '@cairn/shared'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

export function ScenarioRankings({
  topScenarios = [],
  troubledScenarios = [],
}: {
  topScenarios?: ScenarioRankingItem[]
  troubledScenarios?: ScenarioRankingItem[]
}) {
  const [tab, setTab] = React.useState<'top' | 'troubled'>('top')
  const items = tab === 'top' ? topScenarios : troubledScenarios

  const maxVolume = Math.max(1, ...items.map((i) => (tab === 'top' ? i.runCount : i.failCount)))

  return (
    <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <div className="flex items-center gap-1.5">
            {tab === 'top' ? (
              <Flame size={16} className="text-status-warning" aria-hidden />
            ) : (
              <AlertTriangle size={16} className="text-status-error" aria-hidden />
            )}
            <h2 className="text-section font-semibold text-text-primary">
              {tab === 'top' ? '高频活跃场景排行 Top 5' : '需关注故障场景 Top 5'}
            </h2>
          </div>
          <p className="mt-0.5 text-label text-muted-foreground">
            {tab === 'top'
              ? '当前周期执行量最高的核心业务场景'
              : '失败次数与故障率高企、需优先复盘与修复的场景'}
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="h-7 bg-surface-subtle p-0.5">
            <TabsTrigger value="top" className="h-6 px-2 text-label">
              高频榜
            </TabsTrigger>
            <TabsTrigger value="troubled" className="h-6 px-2 text-label">
              故障榜
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-1 flex-col justify-center divide-y divide-border-divider">
        {items.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-body text-muted-foreground">
            {tab === 'top' ? '暂无场景执行记录' : '太棒了！本周期暂无故障场景'}
          </div>
        ) : (
          items.map((item, index) => {
            const barVal = tab === 'top' ? item.runCount : item.failCount
            const percent = Math.min(100, Math.round((barVal / maxVolume) * 100))
            const ratePercent = Math.round(item.successRate * 100)

            return (
              <Link
                key={item.scenarioId}
                to="/scenarios/$scenarioId"
                params={{ scenarioId: item.scenarioId }}
                className="group flex flex-col gap-1.5 py-3 transition-[background-color] duration-150 hover:bg-surface-subtle/60 rounded px-1.5 -mx-1.5"
              >
                <div className="flex items-center justify-between text-body">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-full text-label font-bold ${
                        index === 0
                          ? 'bg-primary-500 text-white'
                          : index === 1
                            ? 'bg-primary-100 text-primary-700 dark:bg-primary-950 dark:text-primary-300'
                            : 'bg-surface-subtle text-muted-foreground'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span className="truncate font-medium text-text-primary group-hover:text-primary-600">
                      {item.scenarioName}
                    </span>
                    <span className="shrink-0 text-label text-muted-foreground">
                      ({item.targetName})
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-label">
                    <span className="font-mono font-medium tabular-nums text-text-primary">
                      {tab === 'top' ? `${item.runCount} 次` : `${item.failCount} 次失败`}
                    </span>
                    <span
                      className={`inline-flex items-center gap-0.5 text-label ${
                        ratePercent >= 90
                          ? 'text-status-success'
                          : ratePercent >= 70
                            ? 'text-status-warning'
                            : 'text-status-error'
                      }`}
                    >
                      {ratePercent >= 90 ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                      {ratePercent}%
                    </span>
                  </div>
                </div>

                {/* 迷你横向进度条 */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      tab === 'top' ? 'bg-primary-500' : 'bg-status-error'
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </Link>
            )
          })
        )}
      </div>

      <div className="pt-2">
        <Link
          to="/scenarios"
          className="inline-flex items-center gap-1 text-label font-medium text-primary-600 hover:text-primary-700"
        >
          查看全部业务场景 <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  )
}
