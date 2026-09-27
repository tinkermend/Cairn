import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  accountAllowsMap,
  requiredRunInputKeys,
  canonicalJson,
  SCHEDULE_INTERVAL_MIN_MS,
  type AnalysisMode,
  type ScheduleConsumerType,
  type ScheduleDefinition,
  type ScheduleDto,
  type JsonValue,
  type ScheduleWeekday,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { fetchScenario, fetchScenarios } from '@/lib/scenarios-api'
import {
  createSchedule,
  previewSchedule,
  setScheduleEnabled,
  updateSchedule,
} from '@/lib/schedules-api'
import { fetchSuites, fetchSuite } from '@/lib/suites-api'
import { fetchTargetAccounts, fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MultiSelectField } from '@/components/ui/multi-select-field'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  RunInputFields,
  missingRunInput,
  runInputValues,
} from '@/features/runs/run-input-fields'
import { CONSUMER_LABELS, MODE_LABELS } from './labels'

const WEEKDAYS: { value: ScheduleWeekday; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
]

function formatLocalTime(isoUtc: string, timeZone: string) {
  try {
    return new Date(isoUtc).toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone.trim() || 'Asia/Shanghai',
    })
  } catch {
    return isoUtc
  }
}

function getScheduleSummaryText({
  ruleKind,
  weekdays,
  windowStart,
  windowEnd,
  intervalMin,
  extraWindows,
}: {
  ruleKind: 'calendar' | 'interval'
  weekdays: ScheduleWeekday[]
  windowStart: string
  windowEnd: string
  intervalMin: number
  extraWindows: { ruleId: string; windowStart: string; windowEnd: string }[]
}): string {
  if (ruleKind === 'interval') {
    return `全天每隔 ${intervalMin} 分钟持续触发 1 次（按固定间隔循环执行）。`
  }
  const dayLabels = WEEKDAYS.filter((d) => weekdays.includes(d.value)).map(
    (d) => d.label
  )
  let dayDesc = ''
  if (dayLabels.length === 7) {
    dayDesc = '每天'
  } else if (
    dayLabels.length === 5 &&
    [1, 2, 3, 4, 5].every((val) => weekdays.includes(val as ScheduleWeekday))
  ) {
    dayDesc = '每个工作日（周一至周五）'
  } else if (
    dayLabels.length === 2 &&
    [6, 7].every((val) => weekdays.includes(val as ScheduleWeekday))
  ) {
    dayDesc = '周末（周六、周日）'
  } else if (dayLabels.length > 0) {
    dayDesc = `每${dayLabels.join('、')}`
  } else {
    dayDesc = '未选择执行日期'
  }

  const times = [
    `${windowStart}（截止 ${windowEnd}）`,
    ...extraWindows.map((w) => `${w.windowStart}（截止 ${w.windowEnd}）`),
  ]
  const count = times.length
  return `${dayDesc}在指定时刻发起 1 次执行（每日共 ${count} 次单次触发）：${times.join('、')}。到达触发时刻立即排入准入；若因节点排队或离线，超过最晚截止时刻仍未受理则主动跳过，避免影响业务高峰期。`
}

export type ScenarioOrSuiteObjectContext = {
  type: 'scenario_run' | 'suite_run'
  targetId: string
  targetName?: string
  objectId: string
  name: string
  versionId?: string | null
}

export type ScheduleObjectContext = ScenarioOrSuiteObjectContext | {
  type: 'map_ingest'
  targetId: string
  targetName?: string
  name: string
}

function emptyDefinition(
  type: ScheduleConsumerType,
  targetId: string
): ScheduleDefinition {
  const timeRule = {
    kind: 'calendar' as const,
    timezone: 'Asia/Shanghai',
    weekdays: [1, 2, 3, 4, 5] as ScheduleWeekday[],
    windows: [{ ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' }],
    misfire: 'skip' as const,
  }
  const base = {
    timeRule,
    timezone: timeRule.timezone,
    weekdays: timeRule.weekdays,
    windowStart: '02:00',
    windowEnd: '03:00',
    misfire: 'skip' as const,
  }
  if (type === 'scenario_run') {
    return {
      ...base,
      consumer: {
        type,
        targetId,
        scenarioId: '',
        scenarioVersionId: '',
        accountBinding: {},
        input: {},
      },
    }
  }
  if (type === 'suite_run') {
    return {
      ...base,
      consumer: {
        type,
        targetId,
        suiteId: '',
        suiteVersionId: '',
        members: [],
        policy: {},
      },
    }
  }
  if (type === 'knowledge_analysis') {
    return {
      ...base,
      name: '知识分析',
      timeRule: {
        kind: 'interval',
        intervalMs: SCHEDULE_INTERVAL_MIN_MS,
        anchorUtc: new Date().toISOString(),
        misfire: 'coalesce',
      },
      timezone: 'UTC',
      weekdays: [1, 2, 3, 4, 5, 6, 7] as ScheduleWeekday[],
      windowStart: '00:00',
      windowEnd: '23:59',
      misfire: 'coalesce',
      consumer: {
        type,
        targetId,
        mode: 'map_quality',
        source: { includeFailures: true },
        strategyVersion: 'analysis-strategy@1',
        budget: { maxItems: 50, useAi: false },
      },
    }
  }
  if (type === 'map_ingest') {
    return {
      ...base,
      consumer: { type, targetId },
    }
  }
  throw new Error(`未知调度类型：${type as string}`)
}

export function ScheduleEditorDialog({
  open,
  onOpenChange,
  existing,
  context,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing?: ScheduleDto | null
  context?: ScheduleObjectContext
}) {
  const canWrite = useCan('schedule:write')
  const saveRequest = useRef<{ signature: string; key: string } | null>(null)
  const queryClient = useQueryClient()
  const [type, setType] = useState<ScheduleConsumerType>(
    existing?.consumerKey ?? context?.type ?? 'scenario_run'
  )
  const [name, setName] = useState(
    existing?.name ??
      (context ? `${context.name} · 定时执行` : '')
  )
  const [targetId, setTargetId] = useState(
    existing?.targetId ?? context?.targetId ?? ''
  )
  const [timezone, setTimezone] = useState(
    existing?.definition.timezone ?? 'Asia/Shanghai'
  )
  const [weekdays, setWeekdays] = useState<ScheduleWeekday[]>(
    existing?.definition.weekdays ?? [1, 2, 3, 4, 5]
  )
  const [windowStart, setWindowStart] = useState(
    existing?.definition.windowStart ?? '02:00'
  )
  const [windowEnd, setWindowEnd] = useState(
    existing?.definition.windowEnd ?? '03:00'
  )
  const [ruleKind, setRuleKind] = useState<'calendar' | 'interval'>(
    existing?.definition.timeRule.kind ?? 'calendar'
  )
  const [intervalMin, setIntervalMin] = useState(
    existing?.definition.timeRule.kind === 'interval'
      ? existing.definition.timeRule.intervalMs / 60000
      : 5
  )
  const [anchor] = useState(() => new Date().toISOString())
  const [extraWindows, setExtraWindows] = useState(
    existing?.definition.timeRule.kind === 'calendar'
      ? existing.definition.timeRule.windows.slice(1)
      : []
  )
  const [inputEdits, setInputEdits] = useState<
    Record<string, { values: Record<string, string>; extraText?: string }>
  >({})
  const [scenarioId, setScenarioId] = useState(
    existing?.definition.consumer.type === 'scenario_run'
      ? existing.definition.consumer.scenarioId
      : context?.type === 'scenario_run'
        ? context.objectId
        : ''
  )
  const [scenarioVersionId] = useState(
    existing?.definition.consumer.type === 'scenario_run'
      ? existing.definition.consumer.scenarioVersionId
      : context?.type === 'scenario_run'
        ? (context.versionId ?? '')
        : ''
  )
  const [accountId, setAccountId] = useState(
    existing?.definition.consumer.type === 'scenario_run'
      ? (existing.definition.consumer.accountBinding.targetAccountId ?? '')
      : existing?.definition.consumer.type === 'map_ingest'
        ? (existing.definition.consumer.targetAccountId ?? '')
        : ''
  )
  const [suiteId, setSuiteId] = useState(
    existing?.definition.consumer.type === 'suite_run'
      ? existing.definition.consumer.suiteId
      : context?.type === 'suite_run'
        ? context.objectId
        : ''
  )
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(
    existing?.definition.consumer.type === 'knowledge_analysis'
      ? existing.definition.consumer.mode
      : 'map_quality'
  )
  const [useAi, setUseAi] = useState(
    existing?.definition.consumer.type === 'knowledge_analysis'
      ? existing.definition.consumer.budget.useAi
      : false
  )
  const [maxItems, setMaxItems] = useState(
    existing?.definition.consumer.type === 'knowledge_analysis'
      ? existing.definition.consumer.budget.maxItems
      : 50
  )
  const [maxTokens, setMaxTokens] = useState(
    existing?.definition.consumer.type === 'knowledge_analysis'
      ? (existing.definition.consumer.budget.maxTokens ?? 32000)
      : 32000
  )
  const [source, setSource] = useState(
    existing?.definition.consumer.type === 'knowledge_analysis'
      ? existing.definition.consumer.source
      : ({
          includeFailures: true,
        } as import('@cairn/shared').AnalysisSourceScope)
  )

  const targetsQuery = useQuery({
    queryKey: ['targets', 'schedule-editor'],
    queryFn: () => fetchTargets({ limit: 100 }),
  })
  const scenariosQuery = useQuery({
    queryKey: ['scenarios', targetId],
    queryFn: () => fetchScenarios({ targetId, limit: 100 }),
    enabled:
      Boolean(targetId) &&
      (type === 'scenario_run' ||
        (type === 'knowledge_analysis' && analysisMode === 'run_incremental')),
  })
  const suitesQuery = useQuery({
    queryKey: ['suites', targetId],
    queryFn: () => fetchSuites({ targetId, limit: 50 }),
    enabled:
      Boolean(targetId) &&
      (type === 'suite_run' ||
        (type === 'knowledge_analysis' && analysisMode === 'run_incremental')),
  })
  const suiteQuery = useQuery({
    queryKey: ['suite-detail', suiteId],
    queryFn: () => fetchSuite(suiteId),
    enabled: Boolean(suiteId) && type === 'suite_run',
  })
  const accountsQuery = useQuery({
    queryKey: ['target-accounts', targetId],
    queryFn: () =>
      fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: Boolean(targetId) && type !== 'knowledge_analysis',
  })
  const canReadConfig = useCan('platform-config:read')
  const configQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
    enabled: canReadConfig,
  })

  const selectedScenario = scenariosQuery.data?.items.find(
    (item) => item.id === scenarioId
  )
  const scenarioDetailQuery = useQuery({
    queryKey: ['scenario', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
    enabled: Boolean(scenarioId) && type === 'scenario_run',
  })
  const fixedVersionId =
    existing?.definition.consumer.type === 'scenario_run' &&
    existing.definition.consumer.scenarioId === scenarioId
      ? existing.definition.consumer.scenarioVersionId
      : context?.type === 'scenario_run'
        ? scenarioVersionId
        : undefined
  const historicalInput = Boolean(
    fixedVersionId &&
    scenarioDetailQuery.data?.published &&
    scenarioDetailQuery.data.published.versionId !== fixedVersionId
  )
  /** Newer publications must never change the required inputs of a frozen plan. */
  const inputDecls = useMemo(() => {
    const published = scenarioDetailQuery.data?.published
    return published &&
      (!fixedVersionId || published.versionId === fixedVersionId)
      ? requiredRunInputKeys(published.definition)
      : []
  }, [scenarioDetailQuery.data, fixedVersionId])
  const baselineInput = useMemo<Record<string, JsonValue>>(() => {
    const consumer = existing?.definition.consumer
    return consumer?.type === 'scenario_run' &&
      consumer.scenarioId === scenarioId
      ? consumer.input
      : {}
  }, [existing, scenarioId])
  const inputKey = `${scenarioId}:${fixedVersionId ?? scenarioDetailQuery.data?.published?.versionId ?? ''}`
  const edits = inputEdits[inputKey]
  const extraText = edits?.extraText ?? null
  const inputValues = useMemo(
    () => ({
      ...Object.fromEntries(
        inputDecls.map((decl) => {
          const value = baselineInput[decl.key]
          return [
            decl.key,
            value === undefined
              ? ''
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value),
          ]
        })
      ),
      ...edits?.values,
    }),
    [inputDecls, baselineInput, edits?.values]
  )
  const extraInput = useMemo<Record<string, JsonValue>>(() => {
    const declared = new Set(inputDecls.map((decl) => decl.key))
    return Object.fromEntries(
      Object.entries(baselineInput).filter(([key]) => !declared.has(key))
    )
  }, [baselineInput, inputDecls])
  const { runInput, inputError } = useMemo(() => {
    let extras: Record<string, JsonValue> = extraInput
    if (extraText !== null) {
      try {
        const value: unknown = JSON.parse(extraText)
        if (!value || Array.isArray(value) || typeof value !== 'object')
          throw new Error('not an object')
        extras = value as Record<string, JsonValue>
      } catch {
        return {
          runInput: {} as Record<string, JsonValue>,
          inputError: '其他输入须为有效的 JSON 对象',
        }
      }
    }
    const missing = missingRunInput(inputDecls, inputValues)
    const fields: Record<string, JsonValue> = runInputValues(
      inputDecls,
      inputValues
    )
    // Unedited values retain their original JSON type and content.
    for (const decl of inputDecls)
      if (
        edits?.values[decl.key] === undefined &&
        baselineInput[decl.key] !== undefined
      )
        fields[decl.key] = baselineInput[decl.key]
    return {
      runInput: { ...extras, ...fields },
      inputError: missing ? `请填写「${missing.label}」` : '',
    }
  }, [
    extraInput,
    extraText,
    inputDecls,
    inputValues,
    edits?.values,
    baselineInput,
  ])
  const existingIntervalAnchor =
    existing?.definition.timeRule.kind === 'interval'
      ? existing.definition.timeRule.anchorUtc
      : undefined
  const definition = useMemo<ScheduleDefinition>(() => {
    const base =
      existing?.consumerKey === type
        ? existing.definition
        : emptyDefinition(type, targetId)
    const timeRule =
      ruleKind === 'interval'
        ? {
            kind: 'interval' as const,
            intervalMs: Math.max(intervalMin, 5) * 60 * 1000,
            anchorUtc: existingIntervalAnchor ?? anchor,
            startDelayMs:
              existing?.definition.timeRule.kind === 'interval'
                ? existing.definition.timeRule.startDelayMs
                : undefined,
            misfire:
              type === 'knowledge_analysis'
                ? ('coalesce' as const)
                : ('skip' as const),
          }
        : {
            kind: 'calendar' as const,
            timezone: timezone.trim() || 'Asia/Shanghai',
            weekdays: (weekdays.length ? weekdays : [1]) as ScheduleWeekday[],
            windows: [
              {
                ruleId:
                  existing?.definition.timeRule.kind === 'calendar'
                    ? existing.definition.timeRule.windows[0].ruleId
                    : 'default',
                windowStart,
                windowEnd,
              },
              ...extraWindows,
            ],
            misfire:
              type === 'knowledge_analysis'
                ? ('coalesce' as const)
                : ('skip' as const),
          }
    if (type === 'scenario_run') {
      return {
        ...base,
        name: name || selectedScenario?.name,
        timeRule,
        timezone: timeRule.kind === 'calendar' ? timeRule.timezone : 'UTC',
        weekdays:
          timeRule.kind === 'calendar' ? timeRule.weekdays : base.weekdays,
        windowStart:
          timeRule.kind === 'calendar' ? windowStart : base.windowStart,
        windowEnd: timeRule.kind === 'calendar' ? windowEnd : base.windowEnd,
        misfire: timeRule.misfire,
        consumer: {
          type,
          targetId,
          scenarioId,
          scenarioVersionId:
            (existing?.definition.consumer.type === 'scenario_run' &&
              existing.definition.consumer.scenarioId === scenarioId) ||
            context?.type === 'scenario_run'
              ? scenarioVersionId
              : selectedScenario?.latestVersionId || '',
          accountBinding: accountId
            ? { targetAccountId: accountId }
            : existing?.definition.consumer.type === 'scenario_run' &&
                !existing.definition.consumer.accountBinding.targetAccountId
              ? existing.definition.consumer.accountBinding
              : {},
          input: runInput,
        },
      }
    }
    if (type === 'suite_run') {
      const published = suiteQuery.data?.published
      const frozen =
        existing?.definition.consumer.type === 'suite_run' &&
        existing.definition.consumer.suiteId === suiteId
          ? existing.definition.consumer
          : undefined
      return {
        ...base,
        name: name || suiteQuery.data?.name,
        timeRule,
        timezone: timeRule.kind === 'calendar' ? timeRule.timezone : 'UTC',
        weekdays:
          timeRule.kind === 'calendar' ? timeRule.weekdays : base.weekdays,
        windowStart,
        windowEnd,
        misfire: timeRule.misfire,
        consumer: {
          type,
          targetId,
          suiteId,
          suiteVersionId: frozen?.suiteVersionId ?? published?.id ?? '',
          members:
            frozen?.members ??
            published?.document.members.map((member) => ({
              memberId: member.memberId,
              scenarioId: member.scenarioId,
              scenarioVersionId: member.scenarioVersionId,
              targetAccountId: member.targetAccountId,
              input: member.input,
            })) ??
            [],
          sharedInput: frozen
            ? frozen.sharedInput
            : published?.document.sharedInput,
          defaultTargetAccountId: frozen
            ? frozen.defaultTargetAccountId
            : published?.document.defaultTargetAccountId,
          policy: frozen?.policy ?? {
            failurePolicy: published?.document.failurePolicy,
          },
        },
      }
    }
    if (type === 'knowledge_analysis') {
      return {
        ...base,
        name: name || '知识分析',
        timeRule,
        timezone: timeRule.kind === 'calendar' ? timeRule.timezone : 'UTC',
        weekdays:
          timeRule.kind === 'calendar'
            ? timeRule.weekdays
            : ([1, 2, 3, 4, 5, 6, 7] as ScheduleWeekday[]),
        windowStart: timeRule.kind === 'calendar' ? windowStart : '00:00',
        windowEnd: timeRule.kind === 'calendar' ? windowEnd : '23:59',
        misfire: timeRule.misfire,
        consumer: {
          type,
          targetId,
          mode: analysisMode,
          source,
          strategyVersion:
            existing?.definition.consumer.type === 'knowledge_analysis'
              ? existing.definition.consumer.strategyVersion
              : 'analysis-strategy@1',
          budget: { maxItems, maxTokens, useAi },
        },
      }
    }
    if (type === 'map_ingest') {
      return {
        ...base,
        name: name || '知识地图采集',
        timeRule,
        timezone: timeRule.kind === 'calendar' ? timeRule.timezone : 'UTC',
        weekdays:
          timeRule.kind === 'calendar' ? timeRule.weekdays : base.weekdays,
        windowStart,
        windowEnd,
        misfire: timeRule.misfire,
        consumer: {
          type,
          targetId,
          targetAccountId: accountId || undefined,
        },
      }
    }
    throw new Error(`未知调度类型：${type as string}`)
  }, [
    accountId,
    anchor,
    extraWindows,
    runInput,
    maxItems,
    maxTokens,
    source,
    context?.type,
    existing,
    analysisMode,
    existingIntervalAnchor,
    intervalMin,
    name,
    ruleKind,
    scenarioId,
    scenarioVersionId,
    selectedScenario?.latestVersionId,
    selectedScenario?.name,
    suiteId,
    suiteQuery.data?.name,
    suiteQuery.data?.published,
    targetId,
    timezone,
    type,
    useAi,
    weekdays,
    windowEnd,
    windowStart,
  ])

  const scheduleSummary = useMemo(
    () =>
      getScheduleSummaryText({
        ruleKind,
        weekdays,
        windowStart,
        windowEnd,
        intervalMin,
        extraWindows,
      }),
    [ruleKind, weekdays, windowStart, windowEnd, intervalMin, extraWindows]
  )

  const previewMutation = useMutation({
    mutationFn: () => previewSchedule({ definition }),
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '预览失败'
      ),
  })
  function saveBody() {
    const signature = canonicalJson({
      scheduleId: existing?.scheduleId,
      revision: existing?.revision ?? 0,
      definition,
    })
    if (saveRequest.current?.signature !== signature)
      saveRequest.current = {
        signature,
        key: `schedule:${crypto.randomUUID()}`,
      }
    return {
      expectedRevision: existing?.revision ?? 0,
      idempotencyKey: saveRequest.current.key,
      definition,
    }
  }
  const saveMutation = useMutation({
    mutationFn: () => {
      const body = saveBody()
      return existing
        ? updateSchedule(existing.scheduleId, body)
        : createSchedule(body)
    },
    onSuccess: async (result) => {
      toast.success(result.created ? '已保存调度，默认停用' : '已更新调度')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '保存失败'
      ),
  })
  const enableMutation = useMutation({
    mutationFn: async () => {
      const saved = existing
        ? await updateSchedule(existing.scheduleId, saveBody())
        : await createSchedule(saveBody())
      try {
        return await setScheduleEnabled(saved.schedule.scheduleId, {
          expectedRevision: saved.schedule.revision,
          idempotencyKey: `enable-${Date.now()}`,
          enabled: true,
          cancelAdmittedJobs: false,
        })
      } catch (error) {
        // Saving succeeded. Return to the refreshed list so retrying cannot
        // create a duplicate plan or use the editor's previous revision.
        void queryClient.invalidateQueries({ queryKey: ['schedules'] })
        onOpenChange(false)
        if (error instanceof Error)
          error.message = `调度已保存，启用失败：${error.message}`
        throw error
      }
    },
    onSuccess: () => {
      toast.success('已保存并启用')
      void queryClient.invalidateQueries({ queryKey: ['schedules'] })
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : '启用失败'),
  })

  const taskAvailability: Record<ScheduleConsumerType, boolean | undefined> = {
    scenario_run: configQuery.data?.document.scenarioScheduledRunEnabled,
    suite_run: configQuery.data?.document.suiteScheduledRunEnabled,
    knowledge_analysis: configQuery.data?.document.knowledgeAnalysisEnabled,
    map_ingest: configQuery.data?.document.mapScheduledRefreshEnabled,
  }
  const taskAvailable = taskAvailability[type]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{existing ? '编辑调度' : '新建调度'}</DialogTitle>
          <DialogDescription>
            选择任务和目标系统，按需设置账号、输入与排期。保存后默认停用；启用前请预览执行时间，并确认平台已开放相应任务。
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <div className='grid gap-2 md:grid-cols-2'>
            <div className='grid gap-1'>
              <Label htmlFor='schedule-type'>任务类型</Label>
              <SelectField
                id='schedule-type'

                disabled={Boolean(existing) || Boolean(context) || !canWrite}
                value={type}
                onValueChange={(value) => {
                  setType(value as ScheduleConsumerType)
                  setAccountId('')
                }}
              >
                {Object.entries(CONSUMER_LABELS).map(([value, label]) => (
                  <SelectFieldOption key={value} value={value}>
                    {label}
                  </SelectFieldOption>
                ))}
              </SelectField>
            </div>
            <div className='grid gap-1'>
              <Label htmlFor='schedule-name'>名称</Label>
              <Input
                id='schedule-name'
                value={name}
                disabled={!canWrite}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='schedule-target'>目标系统</Label>
            <SelectField
              id='schedule-target'

              disabled={Boolean(existing) || Boolean(context) || !canWrite}
              value={targetId}
              onValueChange={(value) => {
                setTargetId(value)
                setScenarioId('')
                setSuiteId('')
                setAccountId('')
                setSource({ includeFailures: true })
              }}
            >
              <SelectFieldOption value=''>选择目标</SelectFieldOption>
              {context &&
              !targetsQuery.data?.items.some(
                (item) => item.id === context.targetId
              ) ? (
                <SelectFieldOption value={context.targetId}>
                  {context.targetName ?? '当前目标系统'}
                </SelectFieldOption>
              ) : null}
              {(targetsQuery.data?.items ?? []).map((item) => (
                <SelectFieldOption key={item.id} value={item.id}>
                  {item.name}
                </SelectFieldOption>
              ))}
            </SelectField>
          </div>
          {type === 'scenario_run' ? (
            <div className='grid gap-2 md:grid-cols-2'>
              <div className='grid gap-1'>
                <Label htmlFor='schedule-scenario'>场景</Label>
                <SelectField
                  id='schedule-scenario'

                  disabled={Boolean(context) || !canWrite}
                  value={scenarioId}
                  onValueChange={(value) => setScenarioId(value)}
                >
                  <SelectFieldOption value=''>选择已发布场景</SelectFieldOption>
                  {context?.type === 'scenario_run' &&
                  !scenariosQuery.data?.items.some(
                    (item) => item.id === context.objectId
                  ) ? (
                    <SelectFieldOption value={context.objectId}>
                      {context.name}
                    </SelectFieldOption>
                  ) : null}
                  {(scenariosQuery.data?.items ?? []).map((item) => (
                    <SelectFieldOption key={item.id} value={item.id}>
                      {item.name}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>
              <div className='grid gap-1'>
                <Label htmlFor='schedule-account'>目标账号</Label>
                <SelectField
                  id='schedule-account'

                  disabled={!canWrite}
                  value={accountId}
                  onValueChange={(value) => setAccountId(value)}
                >
                  <SelectFieldOption value=''>按场景规则解析</SelectFieldOption>
                  {(accountsQuery.data?.items ?? []).map((item) => (
                    <SelectFieldOption key={item.id} value={item.id}>
                      {item.displayName}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>
            </div>
          ) : null}
          {type === 'suite_run' ? (
            <div className='grid gap-1'>
              <Label htmlFor='schedule-suite'>场景集</Label>
              <SelectField
                id='schedule-suite'

                disabled={Boolean(context) || !canWrite}
                value={suiteId}
                onValueChange={(value) => setSuiteId(value)}
              >
                <SelectFieldOption value=''>选择已发布场景集</SelectFieldOption>
                {context?.type === 'suite_run' &&
                !suitesQuery.data?.items.some(
                  (item) => item.id === context.objectId
                ) ? (
                  <SelectFieldOption value={context.objectId}>
                    {context.name}
                  </SelectFieldOption>
                ) : null}
                {(suitesQuery.data?.items ?? []).map((item) => (
                  <SelectFieldOption key={item.id} value={item.id}>
                    {item.name}
                  </SelectFieldOption>
                ))}
              </SelectField>
              <p className='text-label text-muted-foreground'>
                成员版本和账号映射随集合修订冻结，不会追随新的默认账号。
              </p>
            </div>
          ) : null}
          {type === 'map_ingest' ? (
            <div className='grid gap-1'>
              <Label htmlFor='schedule-map-account'>目标账号</Label>
              <SelectField
                id='schedule-map-account'
                disabled={!canWrite || !targetId}
                value={accountId}
                onValueChange={setAccountId}
              >
                <SelectFieldOption value=''>由平台选择可用账号</SelectFieldOption>
                {(accountsQuery.data?.items ?? []).map((item) => (
                  <SelectFieldOption
                    key={item.id}
                    value={item.id}
                    disabled={!accountAllowsMap(item.usage)}
                  >
                    {item.displayName}
                    {!accountAllowsMap(item.usage) ? '（未允许地图采集）' : ''}
                  </SelectFieldOption>
                ))}
              </SelectField>
              <p className='text-label text-muted-foreground'>
                留空时由平台选择允许地图采集的账号。计划将访问目标系统已启用的采集入口。
              </p>
            </div>
          ) : null}
          {type === 'scenario_run' ? (
            <div className='grid gap-2'>
              <Label>运行输入</Label>
              {historicalInput ? (
                <p className='text-label text-muted-foreground'>
                  该计划固定的是历史发布版本。保留该版本的输入，可展开其他输入检查；新版字段不会覆盖当前计划。
                </p>
              ) : null}
              {!scenarioId ? (
                <p className='text-label text-muted-foreground'>
                  先选场景，再填它需要的输入。
                </p>
              ) : scenarioDetailQuery.isPending ? (
                <p className='text-label text-muted-foreground'>
                  正在读取已发布定义…
                </p>
              ) : !scenarioDetailQuery.data?.published ? (
                <p className='text-label text-destructive'>
                  这个场景还没有发布过版本，定时执行没有可固定的版本。
                </p>
              ) : inputDecls.length === 0 &&
                Object.keys(extraInput).length === 0 ? (
                <p className='text-label text-muted-foreground'>
                  该场景不需要运行输入。
                </p>
              ) : (
                <RunInputFields
                  idPrefix='schedule-input'
                  decls={inputDecls}
                  values={inputValues}
                  disabled={!canWrite}
                  onChange={(key, value) =>
                    setInputEdits((current) => ({
                      ...current,
                      [inputKey]: {
                        ...current[inputKey],
                        values: { ...current[inputKey]?.values, [key]: value },
                      },
                    }))
                  }
                />
              )}
              {Object.keys(extraInput).length > 0 ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      className='w-full justify-start px-0'
                    >
                      其他输入（JSON）· {Object.keys(extraInput).length} 个键
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className='pt-2'>
                    <Textarea
                      id='schedule-extra-input'
                      value={extraText ?? JSON.stringify(extraInput, null, 2)}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setInputEdits((current) => ({
                          ...current,
                          [inputKey]: {
                            values: current[inputKey]?.values ?? {},
                            extraText: event.target.value,
                          },
                        }))
                      }
                      aria-label='其他输入'
                      className='font-mono'
                      rows={4}
                    />
                    <p className='text-label text-muted-foreground'>
                      这些键不在已发布定义的输入里，保留原值一起保存，不会被字段覆盖。
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
              <p
                id='schedule-input-help'
                className={
                  inputError
                    ? 'text-label text-destructive'
                    : 'text-label text-muted-foreground'
                }
              >
                {inputError || '输入会随调度修订保存，后续执行使用该修订。'}
              </p>
            </div>
          ) : null}
          {type === 'knowledge_analysis' ? (
            <div className='grid gap-2'>
              <div className='grid gap-1'>
                <Label htmlFor='schedule-mode'>分析模式</Label>
                <SelectField
                  id='schedule-mode'

                  disabled={!canWrite}
                  value={analysisMode}
                  onValueChange={(value) =>
                    setAnalysisMode(value as AnalysisMode)
                  }
                >
                  {Object.entries(MODE_LABELS).map(([value, label]) => (
                    <SelectFieldOption key={value} value={value}>
                      {label}
                    </SelectFieldOption>
                  ))}
                </SelectField>
              </div>
              <p className='text-label text-muted-foreground'>
                不会访问目标浏览器。默认用确定性统计；打开 AI
                也只沉淀候选知识，不会发布已确认术语或地图。
              </p>
              <label className='flex items-center gap-2 text-body'>
                <input
                  type='checkbox'
                  checked={useAi}
                  disabled={!canWrite}
                  onChange={(event) => setUseAi(event.target.checked)}
                />
                使用知识分析模型做语义提炼（需在平台配置中单独启用）
              </label>
              <div className='grid gap-2 md:grid-cols-2'>
                <div className='grid gap-1'>
                  <Label htmlFor='analysis-items'>每批最多处理条数</Label>
                  <Input
                    id='analysis-items'
                    type='number'
                    min={1}
                    max={500}
                    disabled={!canWrite}
                    value={maxItems}
                    onChange={(event) =>
                      setMaxItems(Number(event.target.value))
                    }
                  />
                </div>
                {useAi ? (
                  <div className='grid gap-1'>
                    <Label htmlFor='analysis-tokens'>
                      每批 Token 预算（含重试）
                    </Label>
                    <Input
                      id='analysis-tokens'
                      type='number'
                      min={1}
                      max={200000}
                      disabled={!canWrite}
                      value={maxTokens}
                      onChange={(event) =>
                        setMaxTokens(Number(event.target.value))
                      }
                    />
                  </div>
                ) : null}
              </div>
              {analysisMode === 'run_incremental' ? (
                <>
                  <p className='text-label text-muted-foreground'>
                    未选来源表示目标下所有运行；同时选择场景和场景集时取交集。
                  </p>
                  <div className='grid gap-2 md:grid-cols-2'>
                    <div className='grid gap-1'>
                      <Label htmlFor='analysis-scenarios'>来源场景</Label>
                      <MultiSelectField
                        id='analysis-scenarios'
                        disabled={!canWrite || scenariosQuery.isPending}
                        value={source.scenarioIds ?? []}
                        placeholder='全部场景'
                        onValueChange={(scenarioIds) =>
                          setSource((current) => ({ ...current, scenarioIds }))
                        }
                        options={(scenariosQuery.data?.items ?? []).map(
                          (item) => ({ value: item.id, label: item.name })
                        )}
                      />
                    </div>
                    <div className='grid gap-1'>
                      <Label htmlFor='analysis-suites'>来源场景集</Label>
                      <MultiSelectField
                        id='analysis-suites'
                        disabled={!canWrite || suitesQuery.isPending}
                        value={source.suiteIds ?? []}
                        placeholder='全部场景集'
                        onValueChange={(suiteIds) =>
                          setSource((current) => ({ ...current, suiteIds }))
                        }
                        options={(suitesQuery.data?.items ?? []).map(
                          (item) => ({ value: item.id, label: item.name })
                        )}
                      />
                    </div>
                  </div>
                  <label className='flex items-center gap-2 text-body'>
                    <input
                      type='checkbox'
                      checked={source.includeFailures}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setSource((current) => ({
                          ...current,
                          includeFailures: event.target.checked,
                        }))
                      }
                    />
                    包含失败和取消的运行
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
          <div className='grid gap-2 md:grid-cols-2'>
            <div className='grid gap-1'>
              <Label htmlFor='schedule-rule'>时间规则</Label>
              <SelectField
                id='schedule-rule'

                disabled={!canWrite}
                value={ruleKind}
                onValueChange={(value) =>
                  setRuleKind(value as 'calendar' | 'interval')
                }
              >
                <SelectFieldOption value='calendar'>指定时间排期（单次执行）</SelectFieldOption>
                <SelectFieldOption value='interval'>持续固定间隔</SelectFieldOption>
              </SelectField>
            </div>
            {ruleKind === 'interval' ? (
              <div className='grid gap-1'>
                <Label htmlFor='schedule-interval'>间隔（分钟，最少 5）</Label>
                <Input
                  id='schedule-interval'
                  type='number'
                  min={5}
                  value={intervalMin}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setIntervalMin(Number(event.target.value))
                  }
                />
              </div>
            ) : (
              <div className='grid gap-1'>
                <Label htmlFor='schedule-timezone'>时区</Label>
                <Input
                  id='schedule-timezone'
                  value={timezone}
                  disabled={!canWrite}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </div>
            )}
          </div>
          {ruleKind === 'calendar' ? (
            <>
              <div className='grid gap-1.5'>
                <Label>执行日期</Label>
                <div className='flex flex-wrap gap-2'>
                  {WEEKDAYS.map((day) => (
                    <label
                      key={day.value}
                      className='flex items-center gap-1 text-body'
                    >
                      <input
                        type='checkbox'
                        checked={weekdays.includes(day.value)}
                        disabled={!canWrite}
                        onChange={() =>
                          setWeekdays((current) =>
                            current.includes(day.value)
                              ? current.filter((item) => item !== day.value)
                              : [...current, day.value]
                          )
                        }
                      />
                      {day.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className='grid gap-3 rounded-md border border-border-card bg-muted/20 p-3'>
                <div className='grid gap-2 md:grid-cols-2'>
                  <div className='grid gap-1'>
                    <Label htmlFor='schedule-start'>触发时间</Label>
                    <Input
                      id='schedule-start'
                      value={windowStart}
                      disabled={!canWrite}
                      onChange={(event) => setWindowStart(event.target.value)}
                    />
                    <p className='text-label text-muted-foreground'>
                      到达该时刻准时发起执行（每日 1 次单次触发）。
                    </p>
                  </div>
                  <div className='grid gap-1'>
                    <Label htmlFor='schedule-end'>最晚受理截止（窗口保护）</Label>
                    <Input
                      id='schedule-end'
                      value={windowEnd}
                      disabled={!canWrite}
                      onChange={(event) => setWindowEnd(event.target.value)}
                    />
                    <p className='text-label text-muted-foreground'>
                      若节点排队或离线，超此时刻未开始则跳过，防止白天高峰误跑。
                    </p>
                  </div>
                </div>
              </div>
              {extraWindows.map((window, index) => (
                <div
                  key={window.ruleId}
                  className='grid gap-2 rounded-md border border-border-card bg-muted/10 p-3'
                >
                  <div className='flex items-center justify-between'>
                    <span className='text-label font-medium'>
                      附加执行时间点 {index + 2}
                    </span>
                    <Button
                      variant='ghost'
                      size='sm'
                      disabled={!canWrite}
                      onClick={() =>
                        setExtraWindows((items) =>
                          items.filter((_, i) => i !== index)
                        )
                      }
                    >
                      移除
                    </Button>
                  </div>
                  <div className='grid gap-2 md:grid-cols-2'>
                    <div className='grid gap-1'>
                      <Label htmlFor={`window-start-${index}`}>触发时间</Label>
                      <Input
                        id={`window-start-${index}`}
                        type='time'
                        value={window.windowStart}
                        disabled={!canWrite}
                        onChange={(event) =>
                          setExtraWindows((items) =>
                            items.map((item, i) =>
                              i === index
                                ? { ...item, windowStart: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                    </div>
                    <div className='grid gap-1'>
                      <Label htmlFor={`window-end-${index}`}>最晚受理截止</Label>
                      <Input
                        id={`window-end-${index}`}
                        type='time'
                        value={window.windowEnd}
                        disabled={!canWrite}
                        onChange={(event) =>
                          setExtraWindows((items) =>
                            items.map((item, i) =>
                              i === index
                                ? { ...item, windowEnd: event.target.value }
                                : item
                            )
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={!canWrite || extraWindows.length >= 7}
                  onClick={() =>
                    setExtraWindows((items) => [
                      ...items,
                      {
                        ruleId: `window-${Date.now()}`,
                        windowStart: '09:00',
                        windowEnd: '10:00',
                      },
                    ])
                  }
                >
                  添加执行时间点
                </Button>
              </div>
            </>
          ) : null}
          <div className='rounded-md border border-border-card bg-muted/30 p-3 text-label text-muted-foreground'>
            <p className='font-medium text-text-primary mb-1'>排期规则说明</p>
            <p>{scheduleSummary}</p>
          </div>
          {taskAvailable === false ? (
            <p className='text-label text-status-warning-foreground'>
              平台尚未开放{CONSUMER_LABELS[type]}的定时触发。计划可以保存或启用，但不会按排期执行。请在平台配置中开放此类任务。
            </p>
          ) : null}
          {previewMutation.data ? (
            <div className='grid gap-1.5 rounded-md border border-border-card bg-muted/20 p-3'>
              <p className='text-label font-medium text-text-primary'>
                未来执行时间预演（本地时区）
              </p>
              <ul className='grid gap-1.5 text-label text-muted-foreground'>
                {previewMutation.data.windows.slice(0, 5).map((window) => (
                  <li
                    key={window.localSlotKey}
                    className='flex items-center gap-2'
                  >
                    <span className='font-mono font-medium text-text-primary'>
                      {window.localStartDate}
                    </span>
                    {window.kind === 'ok' ? (
                      <span>
                        {formatLocalTime(window.windowStartUtc, timezone)}{' '}
                        准时发起（最晚受理截止{' '}
                        {formatLocalTime(window.windowEndUtc, timezone)}）
                      </span>
                    ) : (
                      <span className='text-destructive'>
                        跳过 · {window.reason}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <DialogFooter className='gap-2 sm:justify-between'>
          <Button
            type='button'
            variant='outline'
            onClick={() => previewMutation.mutate()}
            disabled={
              !targetId || (type === 'scenario_run' && Boolean(inputError))
            }
          >
            预览执行时间
          </Button>
          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              variant='outline'
              disabled={
                !canWrite ||
                saveMutation.isPending ||
                enableMutation.isPending ||
                (type === 'scenario_run' && Boolean(inputError))
              }
              onClick={() => saveMutation.mutate()}
            >
              仅保存
            </Button>
            <Button
              type='button'
              disabled={
                !canWrite ||
                enableMutation.isPending ||
                saveMutation.isPending ||
                (type === 'scenario_run' && Boolean(inputError))
              }
              onClick={() => enableMutation.mutate()}
            >
              保存并启用
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
