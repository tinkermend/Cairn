import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, Check, Copy, ExternalLink, History, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { canOnTarget } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { TargetIdentityIcon } from './target-identity-icon'
import { AUTH_METHOD_LABELS, CAPTCHA_MODE_LABELS, TARGET_STATUS_LABELS } from './labels'
import { ACCOUNT_SESSION_STATUS_LABELS, ACCOUNT_SESSION_STATUS_TONE } from '@/features/sessions/labels'
import { type TargetOverviewItem, formatOverviewTime, readinessLabel, readinessTone } from './target-overview-display'

const actionLabels = {
  view_conditions: '查看运行条件',
  handle_login: '处理登录',
  view_login: '查看登录状态',
  check_login: '检查登录状态',
  view_run: '查看当前运行',
  manage_sessions: '管理账号与会话',
  view_sessions: '查看账号与会话',
  view_target: '查看系统详情',
} as const

function PrimaryAction({ item, onConditions }: { item: TargetOverviewItem; onConditions: () => void }) {
  const readiness = item.readiness
  if (readiness.state === 'forbidden') return <Button asChild className='w-full'><Link to='/targets/$targetId' params={{ targetId: item.target.id }}>查看系统详情</Link></Button>
  const action = readiness.value.nextAction
  const label = actionLabels[action.kind]
  if (action.kind === 'view_conditions') return <Button className='w-full' onClick={onConditions}>{label}</Button>
  if (action.kind === 'handle_login' || action.kind === 'view_login' || action.kind === 'check_login') {
    return action.targetAccountId ? <Button asChild className='w-full'><Link to='/sessions/$targetId/$accountId' params={{ targetId: item.target.id, accountId: action.targetAccountId }}>{label}</Link></Button> : null
  }
  if (action.kind === 'view_run') return action.runId ? <Button asChild className='w-full'><Link to='/runs/$runId' params={{ runId: action.runId }}>{label}</Link></Button> : null
  if (action.kind === 'manage_sessions' || action.kind === 'view_sessions') return <Button asChild className='w-full'><Link to='/sessions/$targetId' params={{ targetId: item.target.id }}>{label}</Link></Button>
  return <Button asChild className='w-full'><Link to='/targets/$targetId' params={{ targetId: item.target.id }}>{label}</Link></Button>
}

export function TargetOverviewPanel({
  item, onDelete, compact = false,
}: {
  item: TargetOverviewItem
  onDelete: (item: TargetOverviewItem) => void
  compact?: boolean
}) {
  const { target } = item
  const user = useAuthStore((state) => state.auth.user)
  const canAddAccount = canOnTarget(user, 'target:write', target.id)
  const canDelete = canOnTarget(user, 'target:delete', target.id) && canOnTarget(user, 'run:delete', target.id)
  const [copied, setCopied] = useState(false)
  const [conditionsOpen, setConditionsOpen] = useState(false)
  const accounts = item.accounts.state === 'available' ? item.accounts.value : null
  const activity = item.activities.state === 'available' ? item.activities.value : null
  const showReadinessReason = item.readiness.state === 'available' && (
    ['need_login', 'identity_mismatch', 'lost', 'needs_check', 'unknown'].includes(item.readiness.value.state)
    || (item.readiness.value.state === 'ready' && Boolean(accounts?.needLoginAccounts))
  )

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(target.entryUrl)
      setCopied(true)
      toast.success('已复制系统入口')
      window.setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('复制失败，请手动复制') }
  }

  return <aside id={compact ? undefined : 'target-overview'} aria-label='系统概览' className={compact ? 'min-w-0 bg-card' : 'min-w-0 overflow-hidden rounded-xl border border-border-card bg-card shadow-card'}>
    <div className='border-b border-border-divider p-4'>
      <div className='flex items-start gap-3'>
        <TargetIdentityIcon iconKey={target.iconKey} accentKey={target.accentKey} size='lg' />
        <div className='min-w-0 flex-1'>
          <h2 className='break-words text-section font-semibold leading-tight text-text-primary'>{target.name}</h2>
          <div className='mt-1'><StatusBadge tone={target.status === 'active' ? 'success' : 'neutral'}>{TARGET_STATUS_LABELS[target.status]}</StatusBadge></div>
        </div>
      </div>
      <div className='mt-3 flex min-w-0 items-center gap-1 rounded-md border border-border-divider bg-surface-subtle px-2 py-1'>
        <span className='min-w-0 flex-1 truncate font-mono text-label text-text-secondary' title={target.entryUrl}>{target.entryUrl}</span>
        <Button variant='ghost' size='icon' className='size-7 shrink-0' onClick={() => void copyUrl()} aria-label='复制系统入口' title='复制系统入口'>{copied ? <Check className='size-3.5' /> : <Copy className='size-3.5' />}</Button>
        <Button variant='ghost' size='icon' className='size-7 shrink-0' asChild><a href={target.entryUrl} target='_blank' rel='noopener noreferrer' aria-label='打开系统入口' title='打开系统入口'><ExternalLink className='size-3.5' /></a></Button>
      </div>
    </div>

    {accounts && item.readiness.state === 'available' ? <section className='space-y-3 border-b border-border-divider p-4' aria-label='运行准备'>
      <div className='flex items-center justify-between gap-2'><h3 className='text-small font-semibold text-text-primary'>运行准备</h3><StatusBadge tone={readinessTone(item)}>{readinessLabel(item)}</StatusBadge></div>
      <div className='grid grid-cols-2 gap-2'>
        <div className='rounded-lg border border-border-divider bg-surface-subtle p-2.5'><span className='text-label text-muted-foreground'>业务账号就绪</span><p className='mt-1 font-mono text-stat font-semibold tabular-nums text-text-primary'>{accounts.eligibleBusinessTotal === 0 ? '—' : accounts.readyAccounts + ' / ' + accounts.eligibleBusinessTotal}</p></div>
        <div className='rounded-lg border border-border-divider bg-surface-subtle p-2.5'><span className='text-label text-muted-foreground'>待关注</span><p className='mt-1 font-mono text-stat font-semibold tabular-nums text-text-primary'>{accounts.attentionAccounts}</p></div>
      </div>
      {accounts.eligibleBusinessTotal === 0 ? <p className='text-label text-muted-foreground'>暂无浏览器业务账号；此项对非浏览器场景不适用。</p> : null}
      {showReadinessReason && item.readiness.state === 'available' ? <p className='text-small text-text-secondary'>{item.readiness.value.reason}</p> : null}
      {(accounts.unpreparedAccounts > 0 || accounts.occupiedAccounts > 0 || (item.runs.state === 'available' && item.runs.value.running > 0)) ? <p className='text-label text-muted-foreground'>{[accounts.unpreparedAccounts > 0 ? accounts.unpreparedAccounts + ' 个待准备' : '', accounts.occupiedAccounts > 0 ? accounts.occupiedAccounts + ' 个使用中' : '', item.runs.state === 'available' && item.runs.value.running > 0 ? item.runs.value.running + ' 个运行中' : ''].filter(Boolean).join(' · ')}</p> : null}
      <PrimaryAction item={item} onConditions={() => setConditionsOpen((open) => !open)} />
      {conditionsOpen ? <div className='rounded-lg border border-border-divider bg-surface-subtle p-3 text-small text-text-secondary'>
        <p>只有浏览器场景需要业务账号与登录会话。运行时仍会按场景与账号策略复核条件。</p>
        {item.scenarios.state === 'available' ? <p className='mt-1'>当前有 {item.scenarios.value.active} 个已启用场景。</p> : <p className='mt-1'>场景信息无权限查看。</p>}
        {canAddAccount ? <Link to='/targets/$targetId' params={{ targetId: target.id }} search={{ action: 'create-account' }} className='mt-2 inline-flex text-link hover:underline'>添加业务账号<ArrowUpRight className='size-3.5' /></Link> : null}
      </div> : null}
    </section> : <section className='border-b border-border-divider p-4'><p className='text-small text-muted-foreground'>无权限查看会话和目标账号状态。</p></section>}

    {accounts ? <section className='border-b border-border-divider p-4' aria-label='目标账号预览'>
      <div className='flex items-center justify-between'><h3 className='text-small font-semibold text-text-primary'>目标账号</h3><Link to='/sessions/$targetId' params={{ targetId: target.id }} className='text-label text-link hover:underline'>查看全部</Link></div>
      {accounts.preview.length === 0 ? <p className='mt-2 text-label text-muted-foreground'>暂无可预览的业务账号。</p> : <div className='mt-2 space-y-1.5'>{accounts.preview.map((account) => <Link key={account.targetAccountId} to='/sessions/$targetId/$accountId' params={{ targetId: target.id, accountId: account.targetAccountId }} className='block rounded-md border border-border-divider px-2.5 py-2 hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-ring'>
        <div className='flex items-center justify-between gap-2'><span className='min-w-0 truncate text-small font-medium text-text-primary' title={account.displayName}>{account.displayName}</span><StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[account.status]}>{ACCOUNT_SESSION_STATUS_LABELS[account.status]}</StatusBadge></div>
        <p className='mt-0.5 truncate text-label text-muted-foreground' title={account.reason}>{account.reason}</p>
      </Link>)}</div>}
      {accounts.hiddenAttentionCount > 0 ? <Link to='/sessions/$targetId' params={{ targetId: target.id }} className='mt-2 block text-label text-link hover:underline'>另有 {accounts.hiddenAttentionCount} 个待关注，查看全部</Link> : null}
    </section> : null}

    <section className='space-y-2 border-b border-border-divider p-4' aria-label='关联资产与活动'>
      <h3 className='text-small font-semibold text-text-primary'>关联资产与活动</h3>
      <div className='grid grid-cols-3 gap-2'>
        {item.scenarios.state === 'available' ? <Link to='/scenarios' search={{ targetId: target.id }} className='flex min-h-20 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><Layers className='size-4 text-link' aria-hidden='true' /><span>关联场景</span><span className='text-center text-label font-normal tabular-nums text-text-secondary'>{item.scenarios.value.total} 个 · {item.scenarios.value.active} 启用</span></Link> : null}
        {item.knowledge.state === 'available' ? <Link to='/targets/$targetId/map' params={{ targetId: target.id }} search={{ view: 'list' }} className='flex min-h-18 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><BookOpen className='size-4 text-link' aria-hidden='true' /><span>知识记录</span></Link> : null}
        {item.runs.state === 'available' ? <Link to='/runs' search={{ targetId: target.id }} className='flex min-h-18 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><History className='size-4 text-link' aria-hidden='true' /><span>执行记录</span></Link> : null}
      </div>
      {item.scenarios.state === 'forbidden' ? <p className='text-label text-muted-foreground'>关联场景无权限查看</p> : null}
      {item.knowledge.state === 'forbidden' ? <p className='text-label text-muted-foreground'>知识记录无权限查看</p> : null}
      {item.runs.state === 'forbidden' ? <p className='text-label text-muted-foreground'>执行记录无权限查看</p> : null}
      {activity ? <div className='border-t border-border-divider pt-2'><p className='text-label font-medium text-text-secondary'>最近活动{activity.sources.length < 2 ? ' · 仅显示可见来源' : ''}</p>{activity.items.length === 0 ? <p className='mt-1 text-label text-muted-foreground'>暂无可见活动</p> : <div className='mt-1 space-y-1.5'>{activity.items.map((event, index) => <div key={event.source + event.occurredAt + index} className='flex items-start justify-between gap-2 text-label'><span className='min-w-0 flex-1 truncate text-text-secondary' title={event.title}>{event.title}</span><time className='shrink-0 text-muted-foreground' dateTime={event.occurredAt} title={new Date(event.occurredAt).toLocaleString('zh-CN')}>{formatOverviewTime(event.occurredAt)}</time></div>)}</div>}</div> : <p className='text-label text-muted-foreground'>最近活动无权限查看</p>}
    </section>

    <section className='space-y-1.5 p-4 text-label text-muted-foreground' aria-label='系统资料'>
      <div className='flex justify-between gap-2'><span>认证方式</span><span>{AUTH_METHOD_LABELS[target.authMethod]}</span></div>
      <div className='flex justify-between gap-2'><span>验证码</span><span>{CAPTCHA_MODE_LABELS[target.captchaMode]}</span></div>
      <div className='flex justify-between gap-2'><span>配置更新于</span><time dateTime={target.updatedAt} title={new Date(target.updatedAt).toLocaleString('zh-CN')}>{formatOverviewTime(target.updatedAt)}</time></div>
    </section>
    <div className='flex items-center justify-between gap-2 border-t border-border-divider p-3'><Button variant='outline' size='sm' asChild><Link to='/targets/$targetId' params={{ targetId: target.id }}>查看系统详情<ArrowUpRight className='size-3.5' /></Link></Button>{canDelete ? <Button variant='ghost' size='sm' className='text-destructive' onClick={() => onDelete(item)}>删除</Button> : null}</div>
  </aside>
}
