import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { AlertCircle, Ban, ServerCrash } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { StatusBadge } from '@/components/status-badge'
import type { StatusTone } from '@/components/status-badge'
import {
  MONITOR_FAILURE_TITLE,
  type MonitorFailureKind,
} from './labels'

export function FactCard({
  title,
  value,
  description,
  freshness,
  badge,
  to,
  search,
}: {
  title: string
  value: ReactNode
  description?: ReactNode
  freshness: string
  badge?: { tone: StatusTone; label: string }
  to?: '/evidence'
  search?: Record<string, string | boolean | undefined>
}) {
  const body = (
    <>
      <div className='flex items-start justify-between gap-2'>
        <p className='text-small text-muted-foreground'>{title}</p>
        {badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : null}
      </div>
      <p className='mt-1 text-stat font-semibold tabular-nums break-words'>{value}</p>
      {description ? <p className='mt-1 text-label text-muted-foreground'>{description}</p> : null}
      <p className='mt-2 text-label text-muted-foreground'>{freshness}</p>
    </>
  )
  if (to) {
    return (
      <Link
        to={to}
        search={search}
        aria-label={title}
        className='min-w-0 rounded-lg border border-border-card bg-card p-4 shadow-card hover:border-border'
      >
        {body}
      </Link>
    )
  }
  return (
    <article className='min-w-0 rounded-lg border border-border-card bg-card p-4 shadow-card'>
      {body}
    </article>
  )
}

export function FailureAlert({
  kind,
  description,
}: {
  kind: MonitorFailureKind
  description: string
}) {
  const Icon = kind === 'permission' ? Ban : kind === 'object' ? ServerCrash : AlertCircle
  const variant = kind === 'object' || kind === 'read' ? 'destructive' : 'warning'
  return (
    <Alert variant={variant}>
      <Icon />
      <AlertTitle>{MONITOR_FAILURE_TITLE[kind]}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  )
}

export function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className='space-y-3' aria-label={title}>
      <h2 className='text-section font-semibold'>{title}</h2>
      {children}
    </section>
  )
}

export function PlaceholderSection({
  title,
  message,
}: {
  title: string
  message: string
}) {
  return (
    <Section title={title}>
      <article className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <StatusBadge tone='neutral'>未采集／未上报</StatusBadge>
        <p className='mt-3 text-body'>{message}</p>
        <p className='mt-1 text-label text-muted-foreground'>上次采样尚未开始，不显示 0。</p>
      </article>
    </Section>
  )
}
