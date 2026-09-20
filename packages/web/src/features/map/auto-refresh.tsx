import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScheduleDefinition, ScheduleSkipReason, ScheduleWeekday } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMapJobPolicy, fetchMapSafeEntries } from '@/lib/map-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import {
  createSchedule,
  fetchSchedules,
  previewSchedule,
  setScheduleEnabled,
  updateSchedule,
} from '@/lib/schedules-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const WEEKDAYS: { value: ScheduleWeekday; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
]

const SKIP_LABELS: Record<ScheduleSkipReason, string> = {
  WINDOW_CLOSED: '错过窗口，不补跑',
  DST_NONEXISTENT: '夏令时不存在该本地时间',
  INVALID_RESOLVED_WINDOW: '解析后的窗口无效',
  FACTORY_DISABLED: '平台尚未开放自动复查',
  SCHEDULE_DISABLED: '计划已停用',
  MANUAL_JOBS_DISABLED: '该目标尚未开放手工作业',
  AUTH_PREPARATION_REQUIRED: '认证尚未准备',
  SAFETY_BASIS_REQUIRED: '缺少安全进入依据',
  NO_ELIGIBLE_ASSETS: '没有可纳入的资产',
  COVERED_BY_RUN: '已被正式运行覆盖',
  PERMISSION_REVOKED: '授权已被收回',
  MAP_ACCOUNT_USAGE_REQUIRED: '账号已收回地图用途',
  WORKER_UNAVAILABLE: '没有可执行的节点',
  TARGET_PAUSED: '目标已停用',
  ACTIVE_SLICE_EXISTS: '同目标已有进行中的地图作业',
}

function defaultDefinition(targetId: string): ScheduleDefinition {
  return {
    timezone: 'Asia/Shanghai',
    weekdays: [1, 2, 3, 4, 5],
    windowStart: '02:00',
    windowEnd: '03:00',
    misfire: 'skip',
    consumer: {
      type: 'map_refresh',
      targetId,
      targetAccountId: '',
      entryId: '',
      selectedAssetRefs: [],
    },
  }
}

function formatInstant(value: string | null, timeZone: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone })
}

function admissionLabel(status: string, reason: ScheduleSkipReason | null) {
  if (status === 'PENDING') return '待准入'
  if (status === 'ADMITTED') return '已准入（已创建作业，不等于复查成功）'
  if (status === 'FAILED') return '准入失败'
  return reason ? `已跳过 · ${SKIP_LABELS[reason]}` : '已跳过'
}

export function AutoRefreshCard({ targetId }: { targetId: string }) {
  const canRead = useCan('schedule:read')
  const canWrite = useCan('schedule:write') && useCan('map:maintain')
  const queryClient = useQueryClient()
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [weekdays, setWeekdays] = useState<ScheduleWeekday[]>([1, 2, 3, 4, 5])
  const [windowStart, setWindowStart] = useState('02:00')
  const [windowEnd, setWindowEnd] = useState('03:00')
  const [accountId, setAccountId] = useState('')
  const [entryId, setEntryId] = useState('')
  const [hydrated, setHydrated] = useState(false)

  const schedulesQuery = useQuery({
    queryKey: ['schedules', targetId],
    queryFn: () => fetchSchedules({ targetId, limit: 20 }),
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
    queryFn: () => fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canWrite,
  })

  const schedule = schedulesQuery.data?.items[0]
  useEffect(() => {
    if (!schedule || hydrated) return
    setTimezone(schedule.definition.timezone)
    setWeekdays(schedule.definition.weekdays)
    setWindowStart(schedule.definition.windowStart)
    setWindowEnd(schedule.definition.windowEnd)
    setAccountId(schedule.definition.consumer.targetAccountId)
    setEntryId(schedule.definition.consumer.entryId)
    setHydrated(true)
  }, [hydrated, schedule])

  const definition = useMemo<ScheduleDefinition>(
    () => ({
      ...defaultDefinition(targetId),
      timezone: timezone.trim() || 'Asia/Shanghai',
      weekdays: weekdays.length ? weekdays : [1],
      windowStart,
      windowEnd,
      consumer: {
        type: 'map_refresh',
        targetId,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: schedule?.definition.consumer.selectedAssetRefs ?? [],
      },
    }),
    [accountId, entryId, schedule, targetId, timezone, weekdays, windowEnd, windowStart],
  )

  const previewMutation = useMutation({
    mutationFn: () => previewSchedule({ definition }),
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '预览窗口失败')
    },
  })
  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        expectedRevision: schedule?.revision ?? 0,
        idempotencyKey: `refresh-${Date.now()}`,
        definition,
      }
      return schedule ? updateSchedule(schedule.scheduleId, body) : createSchedule(body)
    },
    onSuccess: (result) => {
      toast.success(result.created ? '已保存自动复查计划' : '已更新自动复查计划')
      void queryClient.invalidateQueries({ queryKey: ['schedules', targetId] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '保存计划失败')
    },
  })
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
      void queryClient.invalidateQueries({ queryKey: ['schedules', targetId] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新启停失败')
    },
  })

  if (!canRead) return null

  const factoryOn = configQuery.data?.document.mapScheduledRefreshEnabled === true
  const jobsOn = policyQuery.data?.policy.manualJobsEnabled === true
  const entries = entriesQuery.data?.items ?? []
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])
  const last = schedule?.lastOccurrence
  const readyToSave = Boolean(accountId && entryId && weekdays.length && timezone.trim())

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>自动复查</h2>
      <p className='text-label text-muted-foreground'>
        到点只产生一次准入意图，实际执行仍走现有地图作业。错过窗口不会补跑。
      </p>
      {schedulesQuery.isPending || configQuery.isPending ? (
        <p className='text-label text-muted-foreground'>自动复查计划加载中…</p>
      ) : schedulesQuery.isError ? (
        <p className='text-label text-muted-foreground'>暂时无法读取自动复查计划。</p>
      ) : (
        <>
          {!factoryOn ? (
            <Alert>
              <AlertDescription>出厂关闭。即使保存或启用计划，也不会物化新窗口。</AlertDescription>
            </Alert>
          ) : null}
          {!jobsOn ? (
            <Alert>
              <AlertDescription>该目标尚未开放手工地图作业，到期准入会被跳过。</AlertDescription>
            </Alert>
          ) : null}
          {entries.length === 0 ? (
            <p className='text-label text-muted-foreground'>还没有安全进入路径，不能设置自动复查。</p>
          ) : null}
          {!schedule ? (
            <p className='text-body'>当前没有自动复查计划，默认关闭。</p>
          ) : (
            <div className='space-y-1 text-body'>
              <p>当前：{schedule.enabled ? '计划已启用' : '计划已停用'}</p>
              <p className='text-label text-muted-foreground'>
                下次窗口 {formatInstant(schedule.nextDueAt, schedule.definition.timezone)}
              </p>
              <p className='text-label text-muted-foreground'>
                最近一次{' '}
                {last
                  ? `${admissionLabel(last.admissionStatus, last.reason)}${
                      last.firstRunId ? ` · 运行 ${last.firstRunId.slice(0, 8)}` : ''
                    }`
                  : '还没有窗口'}
              </p>
            </div>
          )}
          {canWrite ? (
            <div className='space-y-3'>
              <div className='space-y-2'>
                <Label htmlFor='refresh-timezone'>IANA 时区</Label>
                <Input
                  id='refresh-timezone'
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder='Asia/Shanghai'
                />
              </div>
              <fieldset className='space-y-2'>
                <legend className='text-label'>星期</legend>
                <div className='flex flex-wrap gap-2'>
                  {WEEKDAYS.map((day) => (
                    <label key={day.value} className='flex items-center gap-1 text-body'>
                      <input
                        type='checkbox'
                        checked={weekdays.includes(day.value)}
                        onChange={() =>
                          setWeekdays((current) =>
                            current.includes(day.value)
                              ? current.filter((item) => item !== day.value)
                              : [...current, day.value].sort((left, right) => left - right),
                          )
                        }
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-2'>
                  <Label htmlFor='refresh-start'>开始（本地）</Label>
                  <Input
                    id='refresh-start'
                    value={windowStart}
                    onChange={(event) => setWindowStart(event.target.value)}
                    placeholder='02:00'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='refresh-end'>结束（本地）</Label>
                  <Input
                    id='refresh-end'
                    value={windowEnd}
                    onChange={(event) => setWindowEnd(event.target.value)}
                    placeholder='03:00'
                  />
                </div>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='refresh-account'>目标账号</Label>
                <select
                  id='refresh-account'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  <option value=''>选择账号</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
                {accounts.length === 0 ? (
                  <p className='text-label text-muted-foreground'>{MAP_ACCOUNT_REQUIRED}</p>
                ) : null}
              </div>
              <div className='space-y-2'>
                <Label htmlFor='refresh-entry'>进入路径</Label>
                <select
                  id='refresh-entry'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={entryId}
                  onChange={(event) => setEntryId(event.target.value)}
                >
                  <option value=''>选择路径</option>
                  {entries.map((entry) => (
                    <option key={entry.entryId} value={entry.entryId}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button
                  variant='outline'
                  disabled={previewMutation.isPending || !readyToSave}
                  onClick={() => previewMutation.mutate()}
                >
                  预览窗口
                </Button>
                <Button disabled={saveMutation.isPending || !readyToSave} onClick={() => saveMutation.mutate()}>
                  保存计划
                </Button>
                {schedule ? (
                  <Button
                    variant='outline'
                    disabled={enabledMutation.isPending}
                    onClick={() => enabledMutation.mutate(!schedule.enabled)}
                  >
                    {schedule.enabled ? '停止未来触发' : '启用新窗口'}
                  </Button>
                ) : null}
              </div>
              {previewMutation.data ? (
                <ul className='space-y-1 text-label text-muted-foreground'>
                  {previewMutation.data.gaps.map((gap) => (
                    <li key={gap.code}>{gap.message}</li>
                  ))}
                  {previewMutation.data.windows.map((window) => (
                    <li key={window.localSlotKey}>
                      {window.kind === 'ok'
                        ? `${window.localStartDate} ${formatInstant(window.windowStartUtc, definition.timezone)}`
                        : `${window.localStartDate} 跳过 · ${SKIP_LABELS[window.reason]}`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className='text-label text-muted-foreground'>需要调度写入和地图维护权限才能设置自动复查。</p>
          )}
        </>
      )}
    </section>
  )
}
