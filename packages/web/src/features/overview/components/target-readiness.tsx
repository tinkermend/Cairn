import { Link } from '@tanstack/react-router'
import { ArrowRight, Globe, ShieldCheck } from 'lucide-react'
import type { SessionSystemOverviewResponse } from '@cairn/shared'

export function TargetReadiness({
  systems,
}: {
  systems?: SessionSystemOverviewResponse
}) {
  const items = systems?.items ?? []

  return (
    <div className="flex flex-col justify-between rounded-lg border border-border-card bg-card p-5 shadow-card">
      <div className="flex items-center justify-between gap-2 pb-3">
        <div>
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={16} className="text-primary-600" aria-hidden />
            <h2 className="text-section font-semibold text-text-primary">
              目标系统与会话健康就绪
            </h2>
          </div>
          <p className="mt-0.5 text-label text-muted-foreground">
            被仿真系统的登录态就绪度，优先免登复用健康会话
          </p>
        </div>
        <div className="flex items-center gap-2 text-label">
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="size-2 rounded-full bg-status-success" aria-hidden /> 就绪
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="size-2 rounded-full bg-status-warning" aria-hidden /> 需认证
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="size-2 rounded-full bg-status-error" aria-hidden /> 异常
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-center divide-y divide-border-divider">
        {items.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-body text-muted-foreground">
            暂未登记被仿真目标系统
          </div>
        ) : (
          items.slice(0, 5).map((sys) => {
            const total = Math.max(1, sys.accountTotal)
            const readyPct = Math.round((sys.readyCount / total) * 100)
            const problemPct = Math.round((sys.problemCount / total) * 100)
            const unreadyPct = Math.max(0, 100 - readyPct - problemPct)

            return (
              <div key={sys.targetId} className="flex flex-col gap-1.5 py-3">
                <div className="flex items-center justify-between text-body">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <Globe size={15} className="text-muted-foreground shrink-0" aria-hidden />
                    <span className="truncate font-medium text-text-primary">
                      {sys.targetName}
                    </span>
                    <span className="font-mono text-label text-muted-foreground">
                      ({sys.targetCode})
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-label font-mono tabular-nums text-text-primary shrink-0">
                    <span>
                      {sys.readyCount}/{sys.accountTotal} 可直接复用
                    </span>
                  </div>
                </div>

                {/* 状态多段色条 */}
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-subtle">
                  {readyPct > 0 && (
                    <div
                      className="bg-status-success transition-[width] duration-300"
                      style={{ width: `${readyPct}%` }}
                      title={`就绪: ${sys.readyCount} 账号`}
                    />
                  )}
                  {problemPct > 0 && (
                    <div
                      className="bg-status-error transition-[width] duration-300"
                      style={{ width: `${problemPct}%` }}
                      title={`异常: ${sys.problemCount} 账号`}
                    />
                  )}
                  {unreadyPct > 0 && (
                    <div
                      className="bg-status-warning/70 transition-[width] duration-300"
                      style={{ width: `${unreadyPct}%` }}
                      title={`未就绪/需登录: ${sys.accountTotal - sys.readyCount - sys.problemCount} 账号`}
                    />
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flex items-center justify-between pt-2">
        <Link
          to="/sessions"
          className="inline-flex items-center gap-1 text-label font-medium text-primary-600 hover:text-primary-700"
        >
          查看浏览器会话管理 <ArrowRight size={13} />
        </Link>
        <Link
          to="/targets"
          className="text-label text-muted-foreground hover:text-text-primary"
        >
          登记目标系统
        </Link>
      </div>
    </div>
  )
}
