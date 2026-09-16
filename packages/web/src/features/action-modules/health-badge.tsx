import type { ModuleHealthSummary } from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { MODULE_HEALTH_LABELS } from './labels'

export function healthHint(health: ModuleHealthSummary): string {
  const rate = health.verifiedRate === null ? '无通过率' : `通过率 ${(health.verifiedRate * 100).toFixed(0)}%`
  const extra = health.verificationInsufficient ? '；验证强度不足' : ''
  return `${MODULE_HEALTH_LABELS[health.signal]} · ${health.windowDays} 天 · 样本 ${health.sampleCount} · ${rate} · 配置修订 ${health.configRevision}${extra}`
}

export function ModuleHealthBadge({
  health,
  className,
}: {
  health?: ModuleHealthSummary | null
  className?: string
}) {
  if (!health) return null
  const label = health.verificationInsufficient && health.signal === 'unknown'
    ? '验证强度不足'
    : MODULE_HEALTH_LABELS[health.signal]
  return (
    <Badge
      variant={health.signal === 'degraded' ? 'destructive' : 'outline'}
      className={className ?? 'text-label'}
      title={healthHint(health)}
    >
      {label}
    </Badge>
  )
}
