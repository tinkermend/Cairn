import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type {
  ScheduleDefinition,
  ScheduleSkipReason,
  ScheduleWeekday,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMapJobPolicy, fetchMapSafeEntries } from '@/lib/map-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import {
  fetchSchedules,
  setScheduleEnabled,
} from '@/lib/schedules-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { StatusBadge } from '@/components/status-badge'
import { Clock, ExternalLink } from 'lucide-react'
import { SKIP_LABELS } from '../schedules/labels'
import { ScheduleEditorDialog } from '../schedules/editor'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'

const WEEKDAYS: { value: ScheduleWeekday; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
]

function formatTimeRule(def: ScheduleDefinition) {
  if (def.timeRule.kind === 'interval') {
    return `每 ${Math.round(def.timeRule.intervalMs / 60000)} 分钟`
  }
  const days = def.timeRule.weekdays
    .map((d) => WEEKDAYS.find((w) => w.value === d)?.label ?? `周${d}`)
    .join('、')
  const windows = def.timeRule.windows
    .map((w) => `${w.windowStart}–${w.windowEnd}`)
    .join(', ')
  return `${def.timezone} · ${days} · ${windows}`
}

function formatInstant(value: string | null, timeZone: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone })
}

function admissionLabel(status: string, reason: ScheduleSkipReason | null) {
  if (status === 'PENDING') return '待准入'
  if (status === 'ADMITTED') return '已准入（已创建作业，不等于采集完成）'
  if (status === 'FAILED') return '准入失败'
  return reason ? `已跳过 · ${SKIP_LABELS[reason]}` : '已跳过'
}

export function AutoRefreshCard({ targetId }: { targetId: string }) {
  const canRead = useCan('schedule:read')
  const canScheduleWrite = useCan('schedule:write')
  const canMapMaintain = useCan('map:maintain')
  const canWrite = canScheduleWrite && canMapMaintain
  const queryClient = useQueryClient()
  const [editorOpen, setEditorOpen] = useState(false)

  const schedulesQuery = useQuery({
    queryKey: ['schedules', targetId, 'map_refresh'],
    queryFn: () =>
      fetchSchedules({ targetId, consumerKey: 'map_refresh', limit: 20 }),
    enabled: canRead,
  })
  const configQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
    enabled: canRead,
  })
  const policyQuery = useQuery({
    queryKey: ['map', targetId, 'job-policy'],
    queryFn: () => fetchMapJobPolicy(targetId),
    enabled: canRead,
  })
  const entriesQuery = useQuery({
    queryKey: ['map', targetId, 'safe-entries'],
    queryFn: () => fetchMapSafeEntries(targetId),
    enabled: canRead,
  })
  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts', 'schedule'],
    queryFn: () =>
      fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canRead,
  })
  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
    enabled: canRead,
  })

  const schedule = schedulesQuery.data?.items.find(
    (item) => item.consumerKey === 'map_refresh'
  )
  const scheduleConsumer =
    schedule?.definition.consumer.type === 'map_refresh'
      ? schedule.definition.consumer
      : null

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      setScheduleEnabled(schedule!.scheduleId, {
        expectedRevision: schedule!.revision,
        idempotencyKey: `enabled-${Date.now()}`,
        enabled,
        cancelAdmittedJobs: !enabled,
      }),
    onSuccess: (result) => {
      toast.success(result.enabled ? '已启用新窗口触发' : '已停止未来触发')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '更新启停失败'
      )
    },
  })

  if (!canRead) return null

  const factoryOn =
    configQuery.data?.document.mapScheduledRefreshEnabled === true
  const jobsOn = policyQuery.data?.policy.manualJobsEnabled === true
  const entries = entriesQuery.data?.items ?? []
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])
  const last = schedule?.lastOccurrence

  const boundAccount = accountsQuery.data?.items.find(
    (a) => a.id === scheduleConsumer?.targetAccountId
  )
  const boundEntry = entries.find(
    (e) => e.entryId === scheduleConsumer?.entryId
  )

  return (
    <section className='space-y-4 rounded-xl border border-border-card bg-surface p-4 shadow-card'>
      {/* 头部：标题、状态与动作 */}
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-card pb-3'>
        <div className='space-y-0.5'>
          <div className='flex items-center gap-2'>
            <Clock className='size-5 text-link shrink-0' />
            <h2 className='text-section font-semibold text-text-primary'>
              知识地图采集
            </h2>
            <StatusBadge
              tone={schedule ? (schedule.enabled ? 'success' : 'neutral') : 'neutral'}
            >
              {schedule
                ? schedule.enabled
                  ? '计划已启用'
                  : '计划已停用'
                : '未配置计划'}
            </StatusBadge>
          </div>
          <p className='text-caption text-text-muted'>
            定时访问已知资产，采集最新观察并核验变化。错过时间窗口不会补跑。
          </p>
        </div>

        <div className='flex flex-wrap items-center gap-3 shrink-0'>
          {canWrite && schedule ? (
            <div className='flex items-center gap-2'>
              <Label
                htmlFor='auto-refresh-switch'
                className='text-caption font-medium text-text-primary cursor-pointer'
              >
                {schedule.enabled ? '计划已开启' : '开启计划'}
              </Label>
              <Switch
                id='auto-refresh-switch'
                aria-label='开启计划'
                checked={schedule.enabled}
                disabled={enabledMutation.isPending}
                onCheckedChange={(val) => enabledMutation.mutate(val)}
              />
            </div>
          ) : null}

          {canWrite ? (
            schedule ? (
              <Button
                variant='outline'
                size='sm'
                onClick={() => setEditorOpen(true)}
              >
                编辑计划
              </Button>
            ) : (
              <Button
                size='sm'
                onClick={() => setEditorOpen(true)}
              >
                配置定时采集
              </Button>
            )
          ) : null}

          <Link
            to='/schedules'
            search={{ consumerKey: 'map_refresh' }}
            className='inline-flex items-center gap-1 text-caption text-link hover:underline'
          >
            <ExternalLink className='size-3.5' />
            在定时任务中查看
          </Link>
        </div>
      </div>

      {schedulesQuery.isPending || configQuery.isPending ? (
        <p className='text-label text-muted-foreground'>采集计划加载中…</p>
      ) : schedulesQuery.isError ? (
        <p className='text-label text-muted-foreground'>
          暂时无法读取采集计划。
        </p>
      ) : (
        <>
          {!factoryOn ? (
            <Alert>
              <AlertDescription>
                出厂关闭。即使保存或启用计划，也不会物化新窗口。
              </AlertDescription>
            </Alert>
          ) : null}
          {!jobsOn ? (
            <Alert>
              <AlertDescription>
                该目标尚未开放手工地图作业，到期准入会被跳过。
              </AlertDescription>
            </Alert>
          ) : null}
          {entries.length === 0 ? (
            <p className='text-label text-muted-foreground'>
              还没有安全进入路径，不能设置定时采集。
            </p>
          ) : null}
          {accounts.length === 0 ? (
            <p className='text-label text-muted-foreground'>
              {MAP_ACCOUNT_REQUIRED}
            </p>
          ) : null}

          {!schedule ? (
            <p className='text-body'>当前没有知识地图采集计划，默认关闭。</p>
          ) : (
            <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3 rounded-lg border border-border-divider bg-surface-subtle p-3.5 text-body'>
              <div className='space-y-1'>
                <span className='text-caption text-muted-foreground font-medium'>
                  采集规则
                </span>
                <p className='font-medium text-text-primary'>
                  {formatTimeRule(schedule.definition)}
                </p>
              </div>

              <div className='space-y-1'>
                <span className='text-caption text-muted-foreground font-medium'>
                  地图用途账号
                </span>
                <p className='font-medium text-text-primary'>
                  {boundAccount
                    ? `${boundAccount.displayName} (${boundAccount.username})`
                    : scheduleConsumer?.targetAccountId || '—'}
                </p>
              </div>

              <div className='space-y-1'>
                <span className='text-caption text-muted-foreground font-medium'>
                  安全进入路径
                </span>
                <p className='font-medium text-text-primary'>
                  {boundEntry ? boundEntry.name : scheduleConsumer?.entryId || '—'}
                </p>
              </div>

              <div className='space-y-1'>
                <span className='text-caption text-muted-foreground font-medium'>
                  下次窗口
                </span>
                <p className='text-text-primary'>
                  {formatInstant(schedule.nextDueAt, schedule.definition.timezone)}
                </p>
              </div>

              <div className='space-y-1 sm:col-span-2'>
                <span className='text-caption text-muted-foreground font-medium'>
                  最近一次执行
                </span>
                <p className='text-text-primary'>
                  {last
                    ? `${admissionLabel(last.admissionStatus, last.reason)}${
                        last.firstRunId
                          ? ` · 运行 ${last.firstRunId.slice(0, 8)}`
                          : ''
                      }`
                    : '还没有窗口'}
                </p>
              </div>
            </div>
          )}

          {!canWrite && !schedule ? (
            <p className='text-label text-muted-foreground'>
              需要调度写入和地图维护权限才能设置知识地图采集。
            </p>
          ) : null}
        </>
      )}

      {editorOpen ? (
        <ScheduleEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          existing={schedule ?? null}
          context={{
            type: 'map_refresh',
            targetId,
            targetName: targetQuery.data?.name,
            name: '知识地图采集',
          }}
        />
      ) : null}
    </section>
  )
}
