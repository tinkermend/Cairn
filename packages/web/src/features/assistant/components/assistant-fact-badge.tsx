import { useEffect, useState } from 'react'
import type { AssistantFact } from '@cairn/shared'
import { Clock, ExternalLink, ShieldCheck } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'
import { citationDisplayLabel } from '../citation-label'

export interface AssistantFactItemProps {
  fact: AssistantFact
  defaultExpanded?: boolean
  className?: string
  onNavigateCitation?: (citation: string) => void
  canNavigateCitation?: (citation: string) => boolean
}

export function AssistantFactItem({
  fact,
  defaultExpanded = false,
  className,
  onNavigateCitation,
  canNavigateCitation,
}: AssistantFactItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [isExpired, setIsExpired] = useState<boolean | null>(null)
  useEffect(() => {
    const validUntil = fact.validUntil
    if (!validUntil) return
    const updateExpiry = () => setIsExpired(new Date(validUntil).getTime() < Date.now())
    updateExpiry()
    const timer = window.setInterval(updateExpiry, 60_000)
    return () => window.clearInterval(timer)
  }, [fact.validUntil])

  const citations = fact.citations ?? []

  const scopeKind =
    typeof fact.scope === 'string'
      ? fact.scope
      : fact.scope && typeof fact.scope === 'object'
        ? fact.scope.kind
        : undefined

  return (
    <div
      data-slot='assistant-fact-item'
      className={cn(
        'rounded-md border border-border-default bg-surface-card p-2.5 transition-colors text-small shadow-2xs',
        className,
      )}
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-start gap-2 flex-1 min-w-0'>
          <ShieldCheck className='size-4 text-primary-600 mt-0.5 shrink-0' aria-hidden />
          <div className='space-y-1 flex-1 min-w-0'>
            <div className='text-body font-normal text-text-primary leading-snug break-words'>
              {fact.text}
            </div>

            <div className='flex flex-wrap items-center gap-1.5 pt-0.5'>
              {scopeKind ? (
                <StatusBadge
                  tone={scopeKind === 'platform' ? 'info' : 'neutral'}
                  className='text-label py-0 px-1.5'
                  hideIcon
                >
                  {scopeKind === 'platform' ? '平台系统事实' : '目标业务事实'}
                </StatusBadge>
              ) : null}

              {fact.validUntil && isExpired !== null ? (
                isExpired ? (
                  <StatusBadge tone='warning' className='text-label py-0 px-1.5'>
                    时效已过期
                  </StatusBadge>
                ) : (
                  <StatusBadge tone='success' className='text-label py-0 px-1.5'>
                    时效有效
                  </StatusBadge>
                )
              ) : null}

              {fact.observedAt ? (
                <span className='inline-flex items-center gap-1 text-label text-text-muted font-mono'>
                  <Clock className='size-2.5' aria-hidden />
                  {new Date(fact.observedAt).toLocaleTimeString()} 观测
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {citations.length > 0 ? (
          <button
            type='button'
            onClick={() => setExpanded(!expanded)}
            className='shrink-0 text-label font-medium text-primary-600 hover:text-primary-700 underline underline-offset-2'
          >
            {citations.length} 处依据 {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>

      {expanded && citations.length > 0 ? (
        <div className='mt-2 pt-2 border-t border-border-divider space-y-1'>
          <div className='text-label font-medium text-text-muted'>事实证据链：</div>
          <div className='flex flex-wrap gap-1'>
            {citations.map((cite) => {
              const navigable = Boolean(onNavigateCitation && canNavigateCitation?.(cite))
              const label = citationDisplayLabel(cite)
              const citationClass = 'inline-flex items-center gap-1 rounded border border-border-default bg-surface-subtle px-1.5 py-0.5 text-label text-text-secondary'
              return navigable ? (
                <button
                  key={cite}
                  type='button'
                  onClick={() => onNavigateCitation?.(cite)}
                  className={cn(citationClass, 'hover:border-primary-400 hover:text-primary-600')}
                  title={cite}
                  aria-label={`打开${label}`}
                >
                  {label}
                  <ExternalLink className='size-2.5' aria-hidden='true' />
                </button>
              ) : (
                <span key={cite} className={citationClass} title={cite}>
                  {label}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
