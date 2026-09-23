import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TargetDto } from '@cairn/shared'
import {
  ArrowUpRight,
  Check,
  Compass,
  Copy,
  ExternalLink,
  Globe2,
  Layers,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { fetchSessionOverview } from '@/lib/sessions-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
} from './labels'
import {
  ACCOUNT_SESSION_STATUS_LABELS,
  ACCOUNT_SESSION_STATUS_TONE,
} from '@/features/sessions/labels'
import { accountSessionOccupancyText } from '@/features/sessions/occupancy-label'

interface TargetOverviewPanelProps {
  target: TargetDto
  onDelete: (target: TargetDto) => void
}

export function TargetOverviewPanel({ target, onDelete }: TargetOverviewPanelProps) {
  const [copied, setCopied] = useState(false)
  const canReadSession = useCan('session:read')
  const canReadMap = useCan('map:read')

  const sessionQuery = useQuery({
    queryKey: ['sessions-overview', { targetId: target.id }],
    queryFn: () => fetchSessionOverview({ targetId: target.id }),
    enabled: canReadSession && Boolean(target.id),
    staleTime: 10_000,
  })

  const scenarioQuery = useQuery({
    queryKey: ['scenarios', { targetId: target.id }],
    queryFn: () => fetchScenarios({ targetId: target.id, limit: 10 }),
    enabled: Boolean(target.id),
    staleTime: 30_000,
  })

  const sessionSummary = sessionQuery.data?.summary
  const sessionAccounts = sessionQuery.data?.items ?? []
  const scenarioItems = scenarioQuery.data?.items ?? []
  const activeScenarios = scenarioItems.filter((s) => s.status === 'active').length

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(target.entryUrl)
      setCopied(true)
      toast.success('已复制系统入口地址')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <aside
      id='target-overview'
      aria-label='系统概览'
      className='min-w-0 rounded-lg border border-border-card bg-card shadow-card'
    >
      {/* 头部：系统信息 */}
      <div className='border-b border-border-divider p-4'>
        <div className='flex items-center gap-3'>
          <span
            aria-hidden='true'
            className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-selection-background text-primary'
          >
            <Globe2 className='size-5' />
          </span>
          <div className='min-w-0 flex-1'>
            <h2 className='text-section font-semibold break-words leading-tight'>
              {target.name}
            </h2>
            <p className='mt-0.5 font-mono text-label break-all text-muted-foreground'>
              {target.code}
            </p>
          </div>
        </div>
      </div>

      {/* 入口 URL 与快捷操作 */}
      <div className='border-b border-border-divider p-4 space-y-1.5'>
        <span className='text-label font-medium text-text-primary'>系统入口</span>
        <div className='flex items-center justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle px-2.5 py-1.5'>
          <span
            className='truncate font-mono text-small text-text-primary'
            title={target.entryUrl}
          >
            {target.entryUrl}
          </span>
          <div className='flex items-center gap-1 shrink-0'>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground hover:text-text-primary'
              onClick={handleCopyUrl}
              aria-label='复制系统入口'
              title='复制系统入口'
            >
              {copied ? (
                <Check className='size-3.5 text-status-success-foreground' />
              ) : (
                <Copy className='size-3.5' />
              )}
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground hover:text-text-primary'
              asChild
            >
              <a
                href={target.entryUrl}
                target='_blank'
                rel='noopener noreferrer'
                aria-label='在新标签页打开系统入口'
                title='在新标签页打开系统入口'
              >
                <ExternalLink className='size-3.5' />
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* 目标账号与会话健康度 */}
      <div className='border-b border-border-divider p-4 space-y-2.5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-1.5'>
            <Users className='size-4 text-muted-foreground' />
            <span className='text-label font-medium text-text-primary'>目标账号与会话</span>
          </div>
          {canReadSession ? (
            <Link
              to='/sessions/$targetId'
              params={{ targetId: target.id }}
              className='inline-flex items-center gap-0.5 text-label text-link hover:underline'
            >
              维护会话
              <ArrowUpRight className='size-3' />
            </Link>
          ) : null}
        </div>

        <div className='flex items-center justify-between text-label text-muted-foreground'>
          <span>
            {sessionSummary
              ? `就绪 ${sessionSummary.available} / 共 ${target.accountCount} 个`
              : `${target.accountCount} 个账号`}
          </span>
          <span>{AUTH_METHOD_LABELS[target.authMethod]}</span>
        </div>

        {target.accountCount === 0 ? (
          <p className='text-label text-muted-foreground'>
            未配置目标账号，场景无法执行
          </p>
        ) : sessionQuery.isPending ? (
          <p className='text-label text-muted-foreground'>查询会话状态中…</p>
        ) : sessionAccounts.length > 0 ? (
          <div className='space-y-1.5'>
            {sessionAccounts.slice(0, 3).map((account) => (
              <div
                key={account.targetAccountId}
                className='flex items-center justify-between rounded-md border border-border-divider bg-surface-subtle px-2.5 py-1.5 text-small'
              >
                <div className='min-w-0 pr-2'>
                  <div
                    className='truncate font-medium text-text-primary text-small'
                    title={account.accountDisplayName}
                  >
                    {account.accountDisplayName}
                  </div>
                  <div
                    className='truncate font-mono text-label text-muted-foreground'
                    title={account.accountUsername}
                  >
                    {account.accountUsername}
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  <StatusBadge
                    tone={ACCOUNT_SESSION_STATUS_TONE[account.status]}
                    className='text-label px-1.5 py-0.5'
                  >
                    {ACCOUNT_SESSION_STATUS_LABELS[account.status]}
                  </StatusBadge>
                  {accountSessionOccupancyText(account) ? (
                    <span className='tabular-nums text-label text-muted-foreground'>
                      {accountSessionOccupancyText(account)}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            {sessionAccounts.length > 3 ? (
              <p className='text-center text-label text-muted-foreground pt-0.5'>
                另有 {sessionAccounts.length - 3} 个账号
              </p>
            ) : null}
          </div>
        ) : null}

        {target.captchaMode !== 'none' ? (
          <div className='flex items-center justify-between pt-1 text-label text-muted-foreground'>
            <span>验证码防护</span>
            <StatusBadge tone='warning' className='text-label px-1.5 py-0.5'>
              {CAPTCHA_MODE_LABELS[target.captchaMode]}
            </StatusBadge>
          </div>
        ) : null}
      </div>

      {/* 关联业务场景 */}
      <div className='border-b border-border-divider p-4 space-y-2.5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-1.5'>
            <Layers className='size-4 text-muted-foreground' />
            <span className='text-label font-medium text-text-primary'>关联业务场景</span>
          </div>
          <span className='text-label text-muted-foreground'>
            {scenarioItems.length} 个 ({activeScenarios} 启用)
          </span>
        </div>

        {scenarioQuery.isPending ? (
          <p className='text-label text-muted-foreground'>加载关联场景中…</p>
        ) : scenarioItems.length === 0 ? (
          <p className='text-label text-muted-foreground'>暂无关联场景</p>
        ) : (
          <div className='space-y-1.5'>
            {scenarioItems.slice(0, 3).map((scenario) => (
              <div
                key={scenario.id}
                className='flex items-center justify-between rounded-md border border-border-divider bg-surface-subtle px-2.5 py-1.5 text-small'
              >
                <Link
                  to='/scenarios/$scenarioId'
                  params={{ scenarioId: scenario.id }}
                  className='min-w-0 pr-2 truncate font-medium text-small text-text-primary hover:text-link hover:underline'
                  title={scenario.name}
                >
                  {scenario.name}
                </Link>
                <StatusBadge
                  tone={scenario.status === 'active' ? 'success' : 'neutral'}
                  className='shrink-0 text-label px-1.5 py-0.5'
                >
                  {scenario.status === 'active' ? '已启用' : '已停用'}
                </StatusBadge>
              </div>
            ))}
            {scenarioItems.length > 3 ? (
              <p className='text-center text-label text-muted-foreground pt-0.5'>
                另有 {scenarioItems.length - 3} 个场景
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* 知识地图与元数据 */}
      <div className='space-y-2 p-4 text-label text-muted-foreground'>
        {canReadMap ? (
          <div className='flex items-center justify-between'>
            <span>知识地图</span>
            <Link
              to='/targets/$targetId/map'
              params={{ targetId: target.id }}
              className='inline-flex items-center gap-1 text-link hover:underline'
            >
              <Compass className='size-3.5' />
              查看拓扑与元素
              <ArrowUpRight className='size-3' />
            </Link>
          </div>
        ) : null}

        <div className='flex items-center justify-between'>
          <span>最近更新</span>
          <span>
            {new Date(target.updatedAt).toLocaleString('zh-CN', {
              hour12: false,
            })}
          </span>
        </div>
      </div>

      {/* 底部操作 */}
      <div className='flex flex-wrap items-center justify-between gap-2 border-t border-border-divider p-3.5'>
        <Button variant='outline' size='sm' asChild>
          <Link
            to='/targets/$targetId'
            params={{ targetId: target.id }}
          >
            管理系统与账号
            <ArrowUpRight className='size-3.5' />
          </Link>
        </Button>
        <Can allOf={['target:delete', 'run:delete']}>
          <Button
            variant='ghost'
            size='sm'
            className='text-destructive'
            onClick={() => onDelete(target)}
          >
            删除
          </Button>
        </Can>
      </div>
    </aside>
  )
}
