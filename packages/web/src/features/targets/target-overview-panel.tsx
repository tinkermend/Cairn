import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, Check, Copy, ExternalLink, History, Layers, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { canOnTarget } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { TargetIdentityIcon } from './target-identity-icon'
import { AUTH_METHOD_LABELS, CAPTCHA_MODE_LABELS, TARGET_STATUS_LABELS } from './labels'
import { ACCOUNT_SESSION_STATUS_LABELS, ACCOUNT_SESSION_STATUS_TONE } from '@/features/sessions/labels'
import { type TargetOverviewItem, formatOverviewTime } from './target-overview-display'

export function TargetOverviewPanel({
  item, onDelete, onEdit, editing = false, compact = false,
}: {
  item: TargetOverviewItem
  onDelete: (item: TargetOverviewItem) => void
  onEdit?: (item: TargetOverviewItem) => void
  editing?: boolean
  compact?: boolean
}) {
  const { target } = item
  const user = useAuthStore((state) => state.auth.user)
  const canEdit = canOnTarget(user, 'target:write', target.id)
  const canAddAccount = canOnTarget(user, 'target:write', target.id)
  const canDelete = canOnTarget(user, 'target:delete', target.id) && canOnTarget(user, 'run:delete', target.id)
  const [copied, setCopied] = useState(false)
  const [conditionsOpen, setConditionsOpen] = useState(false)
  const accounts = item.accounts.state === 'available' ? item.accounts.value : null

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(target.entryUrl)
      setCopied(true)
      toast.success('已复制系统入口')
      window.setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('复制失败，请手动复制') }
  }

  return <aside id={compact ? undefined : 'target-overview'} aria-label='系统概览' className={compact ? 'min-w-0 bg-card' : 'min-w-0 overflow-hidden rounded-xl border border-border-card bg-card shadow-card'}>
    <div className='space-y-3 border-b border-border-divider p-4'>
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-start gap-3 min-w-0 flex-1'>
          <TargetIdentityIcon iconKey={target.iconKey} accentKey={target.accentKey} size='lg' />
          <div className='min-w-0 flex-1'>
            <h2 className='break-words text-section font-semibold leading-tight text-text-primary'>{target.name}</h2>
            <div className='mt-1'><StatusBadge tone={target.status === 'active' ? 'success' : 'neutral'}>{TARGET_STATUS_LABELS[target.status]}</StatusBadge></div>
          </div>
        </div>
        <div className='flex items-center gap-1 shrink-0'>
          {canEdit && onEdit ? (
            <Button
              variant='outline'
              size='sm'
              className='h-7 gap-1 px-2 text-label'
              loading={editing}
              disabled={editing}
              onClick={() => onEdit(item)}
            >
              <Pencil className='size-3' />
              编辑
            </Button>
          ) : null}
          <Button
            variant='ghost'
            size='sm'
            className='h-7 gap-1 px-2 text-label text-link hover:text-link'
            asChild
          >
            <Link to='/targets/$targetId' params={{ targetId: target.id }}>
              详情
              <ArrowUpRight className='size-3' />
            </Link>
          </Button>
        </div>
      </div>

      <div className='flex min-w-0 items-center gap-1 rounded-md border border-border-divider bg-surface-subtle px-2 py-1'>
        <span className='min-w-0 flex-1 truncate font-mono text-label text-text-secondary' title={target.entryUrl}>{target.entryUrl}</span>
        <Button variant='ghost' size='icon' className='size-7 shrink-0' onClick={() => void copyUrl()} aria-label='复制系统入口' title='复制系统入口'>{copied ? <Check className='size-3.5' /> : <Copy className='size-3.5' />}</Button>
        <Button variant='ghost' size='icon' className='size-7 shrink-0' asChild><a href={target.entryUrl} target='_blank' rel='noopener noreferrer' aria-label='打开系统入口' title='打开系统入口'><ExternalLink className='size-3.5' /></a></Button>
      </div>

      <div className='grid grid-cols-3 divide-x divide-border-divider rounded-lg border border-border-divider bg-surface-subtle/50 py-2 text-center text-label'>
        <div className='px-1 min-w-0'>
          <span className='block text-muted-foreground'>认证方式</span>
          <span className='mt-0.5 block truncate font-medium text-text-primary' title={AUTH_METHOD_LABELS[target.authMethod]}>
            {AUTH_METHOD_LABELS[target.authMethod]}
          </span>
        </div>
        <div className='px-1 min-w-0'>
          <span className='block text-muted-foreground'>验证码</span>
          <span className='mt-0.5 block truncate font-medium text-text-primary' title={CAPTCHA_MODE_LABELS[target.captchaMode]}>
            {CAPTCHA_MODE_LABELS[target.captchaMode]}
          </span>
        </div>
        <div className='px-1 min-w-0'>
          <span className='block text-muted-foreground'>配置更新</span>
          <time
            className='mt-0.5 block truncate font-medium text-text-primary'
            dateTime={target.updatedAt}
            title={new Date(target.updatedAt).toLocaleString('zh-CN')}
          >
            {formatOverviewTime(target.updatedAt)}
          </time>
        </div>
      </div>
    </div>

    {accounts ? <section className='border-b border-border-divider p-4' aria-label='目标账号预览'>
      <div className='flex items-center justify-between'>
        <h3 className='text-small font-semibold text-text-primary'>目标账号</h3>
        <Link to='/sessions' search={{ view: 'systems', targetId: target.id }} className='text-label text-link hover:underline'>
          管理账号与会话
          <ArrowUpRight className='size-3 inline-block ml-0.5' />
        </Link>
      </div>
      {accounts.preview.length === 0 ? <p className='mt-2 text-label text-muted-foreground'>暂无可预览的业务账号。</p> : <div className='mt-2 space-y-1.5'>{accounts.preview.slice(0, 2).map((account) => <Link key={account.targetAccountId} to='/sessions/$targetId/$accountId' params={{ targetId: target.id, accountId: account.targetAccountId }} className='block rounded-md border border-border-divider px-2.5 py-1.5 hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-ring'>
        <div className='flex items-center justify-between gap-2'>
          <span className='min-w-0 truncate text-small font-medium text-text-primary' title={account.displayName}>{account.displayName}</span>
          <div className='flex items-center gap-1.5 shrink-0'>
            <StatusBadge tone={ACCOUNT_SESSION_STATUS_TONE[account.status]}>{ACCOUNT_SESSION_STATUS_LABELS[account.status]}</StatusBadge>
          </div>
        </div>
        <p className='mt-0.5 truncate text-label text-muted-foreground' title={account.reason}>{account.reason}</p>
      </Link>)}</div>}
      {item.readiness.state === 'available' && item.readiness.value.nextAction.kind === 'handle_login' && item.readiness.value.nextAction.targetAccountId ? (
        <div className='mt-2.5'>
          <Button asChild size='sm' className='w-full'>
            <Link to='/sessions/$targetId/$accountId' params={{ targetId: target.id, accountId: item.readiness.value.nextAction.targetAccountId }}>
              处理登录
              <ArrowUpRight className='size-3.5' />
            </Link>
          </Button>
        </div>
      ) : null}
      {item.readiness.state === 'available' && item.readiness.value.nextAction.kind === 'view_conditions' ? (
        <div className='mt-2.5 space-y-2'>
          <Button variant='outline' size='sm' className='w-full' onClick={() => setConditionsOpen((open) => !open)}>
            查看运行条件
          </Button>
          {conditionsOpen ? (
            <div className='rounded-lg border border-border-divider bg-surface-subtle p-3 text-small text-text-secondary'>
              <p>只有浏览器场景需要业务账号与登录会话。运行时仍会按场景与账号策略复核条件。</p>
              {item.scenarios.state === 'available' ? <p className='mt-1'>当前有 {item.scenarios.value.active} 个已启用场景。</p> : <p className='mt-1'>场景信息无权限查看。</p>}
              {canAddAccount ? <Link to='/targets/$targetId' params={{ targetId: target.id }} search={{ action: 'create-account' }} className='mt-2 inline-flex text-link hover:underline'>添加业务账号<ArrowUpRight className='size-3.5' /></Link> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {(accounts.hiddenAttentionCount > 0 || accounts.preview.length > 2) ? <Link to='/sessions' search={{ view: 'systems', targetId: target.id }} className='mt-2 block text-label text-link hover:underline'>另有 {accounts.hiddenAttentionCount + Math.max(0, accounts.preview.length - 2)} 个账号，查看全部</Link> : null}
    </section> : <section className='border-b border-border-divider p-4' aria-label='目标账号预览'>
      <h3 className='text-small font-semibold text-text-primary'>目标账号</h3>
      <p className='mt-2 text-label text-muted-foreground'>无权限查看会话和目标账号状态。</p>
    </section>}

    <section className='space-y-2 border-b border-border-divider p-4' aria-label='关联资产'>
      <h3 className='text-small font-semibold text-text-primary'>关联资产</h3>
      <div className='grid grid-cols-3 gap-2'>
        {item.scenarios.state === 'available' ? <Link to='/scenarios' search={{ targetId: target.id }} className='flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 py-1.5 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><Layers className='size-3.5 text-link' aria-hidden='true' /><span>关联场景</span><span className='text-center text-label font-normal tabular-nums text-text-secondary'>{item.scenarios.value.total} 个 · {item.scenarios.value.active} 启用</span></Link> : null}
        {item.knowledge.state === 'available' ? <Link to='/targets/$targetId/map' params={{ targetId: target.id }} search={{ view: 'list' }} className='flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 py-1.5 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><BookOpen className='size-3.5 text-link' aria-hidden='true' /><span>知识记录</span></Link> : null}
        {item.runs.state === 'available' ? <Link to='/runs' search={{ targetId: target.id }} className='flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border-divider bg-surface-subtle px-1 py-1.5 text-label font-medium text-text-primary hover:border-selection-border hover:bg-action-hover focus-visible:outline-2 focus-visible:outline-ring'><History className='size-3.5 text-link' aria-hidden='true' /><span>执行记录</span></Link> : null}
      </div>
      {item.scenarios.state === 'forbidden' ? <p className='text-label text-muted-foreground'>关联场景无权限查看</p> : null}
      {item.knowledge.state === 'forbidden' ? <p className='text-label text-muted-foreground'>知识记录无权限查看</p> : null}
      {item.runs.state === 'forbidden' ? <p className='text-label text-muted-foreground'>执行记录无权限查看</p> : null}
    </section>

    <div className='flex flex-wrap items-center justify-between gap-2 p-3'>
      <div className='flex items-center gap-2'>
        <Button variant='default' size='sm' asChild>
          <Link to='/targets/$targetId' params={{ targetId: target.id }}>
            查看系统详情
            <ArrowUpRight className='size-3.5' />
          </Link>
        </Button>
        {canEdit && onEdit ? (
          <Button
            variant='outline'
            size='sm'
            onClick={() => onEdit(item)}
            loading={editing}
            disabled={editing}
          >
            <Pencil className='size-3.5' />
            编辑系统
          </Button>
        ) : null}
      </div>
      {canDelete ? (
        <Button
          variant='ghost'
          size='sm'
          className='text-destructive hover:bg-destructive/10 hover:text-destructive'
          onClick={() => onDelete(item)}
        >
          删除
        </Button>
      ) : null}
    </div>
  </aside>
}
