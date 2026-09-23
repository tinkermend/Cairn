import { useMemo, useState } from 'react'
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
  createSchedule,
  fetchSchedules,
  previewSchedule,
  setScheduleEnabled,
  updateSchedule,
} from '@/lib/schedules-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { SKIP_LABELS } from '../schedules/labels'
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
const DEFAULT_WEEKDAYS: ScheduleWeekday[] = [1, 2, 3, 4, 5]

type RefreshDraft = {
  timezone: string
  weekdays: ScheduleWeekday[]
  windowStart: string
  windowEnd: string
  accountId: string
  entryId: string
}

function defaultDefinition(targetId: string): ScheduleDefinition {
  return {
    timezone: 'Asia/Shanghai',
    weekdays: DEFAULT_WEEKDAYS,
    windowStart: '02:00',
    windowEnd: '03:00',
    misfire: 'skip',
    timeRule: {
      kind: 'calendar',
      timezone: 'Asia/Shanghai',
      weekdays: DEFAULT_WEEKDAYS,
      windows: [
        { ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' },
      ],
      misfire: 'skip',
    },
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
  const [draft, setDraft] = useState<{
    targetId: string
    fields: Partial<RefreshDraft>
  } | null>(null)

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
    enabled: canWrite,
  })

  const schedule = schedulesQuery.data?.items.find(
    (item) => item.consumerKey === 'map_refresh'
  )
  const edits = draft?.targetId === targetId ? draft.fields : null
  const scheduleConsumer =
    schedule?.definition.consumer.type === 'map_refresh'
      ? schedule.definition.consumer
      : null
  const timezone =
    edits?.timezone ?? schedule?.definition.timezone ?? 'Asia/Shanghai'
  const weekdays =
    edits?.weekdays ?? schedule?.definition.weekdays ?? DEFAULT_WEEKDAYS
  const windowStart =
    edits?.windowStart ?? schedule?.definition.windowStart ?? '02:00'
  const windowEnd =
    edits?.windowEnd ?? schedule?.definition.windowEnd ?? '03:00'
  const accountId = edits?.accountId ?? scheduleConsumer?.targetAccountId ?? ''
  const entryId = edits?.entryId ?? scheduleConsumer?.entryId ?? ''
  const updateDraft = <K extends keyof RefreshDraft>(
    key: K,
    value: RefreshDraft[K]
  ) => {
    setDraft((current) => ({
      targetId,
      fields: {
        ...(current?.targetId === targetId ? current.fields : {}),
        [key]: value,
      },
    }))
  }
  const existingTimeRule = schedule?.definition.timeRule
  const requiresFullEditor = Boolean(
    existingTimeRule &&
    (existingTimeRule.kind !== 'calendar' ||
      existingTimeRule.windows.length !== 1)
  )

  const definition = useMemo<ScheduleDefinition>(() => {
    const initial = defaultDefinition(targetId)
    const existing = schedule?.definition
    const calendarRule =
      existing?.timeRule?.kind === 'calendar' ? existing.timeRule : null
    const resolvedTimezone = timezone.trim() || 'Asia/Shanghai'
    const resolvedWeekdays: ScheduleWeekday[] = weekdays.length ? weekdays : [1]
    return {
      ...initial,
      ...existing,
      timezone: resolvedTimezone,
      weekdays: resolvedWeekdays,
      windowStart,
      windowEnd,
      misfire: 'skip',
      timeRule: {
        kind: 'calendar',
        timezone: resolvedTimezone,
        weekdays: resolvedWeekdays,
        windows: [
          {
            ruleId: calendarRule?.windows[0]?.ruleId ?? 'default',
            windowStart,
            windowEnd,
          },
        ],
        misfire: 'skip',
      },
      consumer: {
        type: 'map_refresh',
        targetId,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs:
          existing?.consumer.type === 'map_refresh'
            ? existing.consumer.selectedAssetRefs
            : [],
      },
    }
  }, [
    accountId,
    entryId,
    schedule,
    targetId,
    timezone,
    weekdays,
    windowEnd,
    windowStart,
  ])

  const previewMutation = useMutation({
    mutationFn: () => previewSchedule({ definition }),
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '预览窗口失败'
      )
    },
  })
  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        expectedRevision: schedule?.revision ?? 0,
        idempotencyKey: `refresh-${Date.now()}`,
        definition,
      }
      return schedule
        ? updateSchedule(schedule.scheduleId, body)
        : createSchedule(body)
    },
    onSuccess: (result) => {
      toast.success(
        result.created ? '已保存知识地图采集计划' : '已更新知识地图采集计划'
      )
      void queryClient.invalidateQueries({ queryKey: ['schedules', targetId] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '保存计划失败'
      )
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
  const readyToSave = Boolean(
    accountId && entryId && weekdays.length && timezone.trim()
  )

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>知识地图采集</h2>
      <p className='text-label text-muted-foreground'>
        定时访问已知资产，采集最新观察并核验变化。错过时间窗口不会补跑。
      </p>
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
          {!schedule ? (
            <p className='text-body'>当前没有知识地图采集计划，默认关闭。</p>
          ) : (
            <div className='space-y-1 text-body'>
              <p>当前：{schedule.enabled ? '计划已启用' : '计划已停用'}</p>
              <p className='text-label text-muted-foreground'>
                下次窗口{' '}
                {formatInstant(
                  schedule.nextDueAt,
                  schedule.definition.timezone
                )}
              </p>
              <p className='text-label text-muted-foreground'>
                最近一次{' '}
                {last
                  ? `${admissionLabel(last.admissionStatus, last.reason)}${
                      last.firstRunId
                        ? ` · 运行 ${last.firstRunId.slice(0, 8)}`
                        : ''
                    }`
                  : '还没有窗口'}
              </p>
            </div>
          )}
          {canWrite && requiresFullEditor ? (
            <Alert>
              <AlertDescription>
                此计划使用间隔或多个时间窗口，请到{' '}
                <Link to='/schedules' className='text-primary hover:underline'>
                  定时任务
                </Link>{' '}
                编辑。这里仅支持单个日历窗口，以免覆盖现有规则。
              </AlertDescription>
            </Alert>
          ) : canWrite ? (
            <div className='space-y-3'>
              <div className='space-y-2'>
                <Label htmlFor='refresh-timezone'>IANA 时区</Label>
                <Input
                  id='refresh-timezone'
                  value={timezone}
                  onChange={(event) =>
                    updateDraft('timezone', event.target.value)
                  }
                  placeholder='Asia/Shanghai'
                />
              </div>
              <fieldset className='space-y-2'>
                <legend className='text-label'>星期</legend>
                <div className='flex flex-wrap gap-2'>
                  {WEEKDAYS.map((day) => (
                    <label
                      key={day.value}
                      className='flex items-center gap-1 text-body'
                    >
                      <input
                        type='checkbox'
                        checked={weekdays.includes(day.value)}
                        onChange={() =>
                          updateDraft(
                            'weekdays',
                            weekdays.includes(day.value)
                              ? weekdays.filter((item) => item !== day.value)
                              : [...weekdays, day.value].sort(
                                  (left, right) => left - right
                                )
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
                    onChange={(event) =>
                      updateDraft('windowStart', event.target.value)
                    }
                    placeholder='02:00'
                  />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='refresh-end'>结束（本地）</Label>
                  <Input
                    id='refresh-end'
                    value={windowEnd}
                    onChange={(event) =>
                      updateDraft('windowEnd', event.target.value)
                    }
                    placeholder='03:00'
                  />
                </div>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='refresh-account'>目标账号</Label>
                <SelectField
                  id='refresh-account'
                  className='w-full'
                  value={accountId}
                  onValueChange={(value) => updateDraft('accountId', value)}
                >
                  <SelectFieldOption value=''>选择账号</SelectFieldOption>
                  {accounts.map((account) => (
                    <SelectFieldOption key={account.id} value={account.id}>
                      {account.displayName}
                    </SelectFieldOption>
                  ))}
                </SelectField>
                {accounts.length === 0 ? (
                  <p className='text-label text-muted-foreground'>
                    {MAP_ACCOUNT_REQUIRED}
                  </p>
                ) : null}
              </div>
              <div className='space-y-2'>
                <Label htmlFor='refresh-entry'>进入路径</Label>
                <SelectField
                  id='refresh-entry'
                  className='w-full'
                  value={entryId}
                  onValueChange={(value) => updateDraft('entryId', value)}
                >
                  <SelectFieldOption value=''>选择路径</SelectFieldOption>
                  {entries.map((entry) => (
                    <SelectFieldOption
                      key={entry.entryId}
                      value={entry.entryId}
                    >
                      {entry.name}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button
                  variant='outline'
                  disabled={previewMutation.isPending || !readyToSave}
                  onClick={() => previewMutation.mutate()}
                >
                  预览窗口
                </Button>
                <Button
                  disabled={saveMutation.isPending || !readyToSave}
                  onClick={() => saveMutation.mutate()}
                >
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
            <p className='text-label text-muted-foreground'>
              需要调度写入和地图维护权限才能设置知识地图采集。
            </p>
          )}
        </>
      )}
    </section>
  )
}
