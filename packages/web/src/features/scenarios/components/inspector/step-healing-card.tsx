import { useState } from 'react'
import type { RepairCandidate, Step } from '@cairn/shared'
import { Sparkles, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { stepTargetDescriptor } from '../../studio-document'

export interface StepHealingCardProps {
  step: Step
  health?: {
    status: 'untested' | 'healthy' | 'fallback_warning' | 'failing'
    ruleHitRate: number | null
    fallbackRate: number | null
    ai: number
    located: number
    failed: number
  }
  candidate?: RepairCandidate
  onAdopt?: (candidate: RepairCandidate) => void
  onReject?: (candidateId: string) => void
  disabled?: boolean
}

export function StepHealingCard({
  step,
  health,
  candidate,
  onAdopt,
  onReject,
  disabled,
}: StepHealingCardProps) {
  const [adopting, setAdopting] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // 如果没有健康度警示且没有可用候选，或者已被用户暂时忽略，则不展示
  if (dismissed) return null
  if (!candidate && health?.status !== 'fallback_warning') return null

  const target = stepTargetDescriptor(step)

  const originalPrimary = target?.candidates?.[0]
  const suggestedCandidate = candidate?.patch?.suggestedCandidate
  const evidenceDiff = candidate?.patch?.evidenceDiff
  const rulePercent = health?.ruleHitRate == null ? null : Math.round(health.ruleHitRate * 100)

  const handleAdopt = async () => {
    if (!candidate || !onAdopt) return
    setAdopting(true)
    try {
      await onAdopt(candidate)
    } finally {
      setAdopting(false)
    }
  }

  const handleReject = async () => {
    if (!candidate || !onReject) {
      setDismissed(true)
      return
    }
    try {
      await onReject(candidate.id)
      setDismissed(true)
    } catch {
      // 错误由父级 toast 处理
    }
  }

  return (
    <>
      <div
        data-testid='step-healing-card'
        className='rounded-xl border border-status-warning/40 bg-status-warning-background/10 p-3.5 space-y-3'
      >
        <div className='flex items-start justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <div className='flex size-6 shrink-0 items-center justify-center rounded-full bg-status-warning/20 text-status-warning-foreground'>
              <Sparkles className='size-3.5' />
            </div>
            <div>
              <h4 className='text-body font-semibold text-foreground leading-tight'>
                {candidate ? '检测到可用定位自愈规则' : '目标规则已发生衰减'}
              </h4>
              <p className='text-caption text-muted-foreground mt-0.5'>
                {rulePercent !== null ? `近期规则命中率降至 ${rulePercent}% · ` : ''}
                {health?.ai ? `有 ${health.ai} 次依赖 AI 视觉兜底挽救运行` : '建议更新元素选择器以避免消耗 AI'}
              </p>
            </div>
          </div>

          <button
            type='button'
            className='text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors'
            title='忽略此建议'
            onClick={handleReject}
          >
            <X className='size-4' />
          </button>
        </div>

        {candidate && suggestedCandidate && (
          <div className='space-y-2.5 rounded-lg border border-border-default/80 bg-card p-2.5 text-label'>
            <div className='flex items-center justify-between text-caption text-muted-foreground'>
              <span className='font-medium text-foreground'>规则变更对比与建议置顶</span>
              <span className='inline-flex items-center gap-1 text-status-success-foreground font-medium'>
                <ShieldCheck className='size-3' />
                已验证唯一匹配
              </span>
            </div>

            <div className='space-y-1.5 font-mono text-caption'>
              {originalPrimary && (
                <div className='flex items-center gap-2 text-muted-foreground'>
                  <span className='px-1 py-0.5 rounded bg-muted text-3xs font-sans'>当前首选 (已衰减)</span>
                  <span className='truncate'>{originalPrimary.by}: {originalPrimary.value}</span>
                </div>
              )}
              <div className='flex items-center gap-2 text-primary font-medium'>
                <span className='px-1 py-0.5 rounded bg-primary/10 text-primary text-3xs font-sans'>
                  AI 提议 (推荐新首选)
                </span>
                <span className='truncate'>
                  {suggestedCandidate.by}: {suggestedCandidate.value}
                  {suggestedCandidate.name ? ` (${suggestedCandidate.name})` : ''}
                </span>
              </div>
            </div>

            {evidenceDiff?.matchedElementHtml && (
              <div className='pt-1 border-t border-border-divider/50'>
                <p className='text-3xs text-muted-foreground'>AI 视觉匹配到的真实元素：</p>
                <p className='mt-0.5 truncate text-3xs text-foreground font-mono bg-surface-subtle p-1 rounded'>
                  {evidenceDiff.matchedElementHtml}
                </p>
              </div>
            )}

            <div className='pt-1 border-t border-border-divider/50 text-3xs text-muted-foreground'>
              <p>💡 置顶为首选规则，原规则将自动保留为后备兜底，不满意可按 Ctrl+Z 撤销。</p>
            </div>

            <div className='pt-2 flex items-center justify-between gap-2 border-t border-border-divider/60'>
              <Button
                size='sm'
                variant='default'
                disabled={disabled || adopting}
                onClick={handleAdopt}
                data-testid='adopt-candidate-btn'
                className='text-label font-medium shadow-xs'
              >
                {adopting ? '正在应用...' : '✨ 采用新规则 (原规则保留备用)'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={disabled}
                onClick={handleReject}
                data-testid='reject-candidate-btn'
                className='text-caption text-muted-foreground'
              >
                忽略建议
              </Button>
            </div>
          </div>
        )}
      </div>

    </>
  )
}
