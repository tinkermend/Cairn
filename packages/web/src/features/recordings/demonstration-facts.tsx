import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { suggestDemonstration } from '@cairn/authoring'
import type {
  DemonstrationDetail,
  DemonstrationObservation,
  DemonstrationSource,
} from '@cairn/shared'
import {
  fetchDemonstration,
  fetchDemonstrationImage,
} from '@/lib/demonstrations-api'
import { Button } from '@/components/ui/button'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { stepTypeLabel } from '@/features/authoring/labels'

const observationLabels = {
  captured: '已采集',
  approximate: '近似观察',
  missing: '缺失',
  omitted: '未上传',
}
const actionLabels: Record<string, string> = {
  navigate: '打开页面',
  openPage: '打开页面',
  navigation: '页面导航',
  click: '点击',
  aiTap: '点击',
  fill: '填写内容',
  input: '输入内容',
  aiInput: '输入内容',
  press: '按键',
  keydown: '按键',
  aiKeyboardPress: '按键',
  select: '选择选项',
  scroll: '滚动',
  aiScroll: '滚动',
  sleep: '等待',
  aiWaitFor: '等待页面条件',
  assertText: '检查文本',
  assertVisible: '检查可见性',
  assertValue: '检查输入值',
  assertChecked: '检查选中状态',
  aiAssert: '检查成功条件',
  aiQuery: '提取数据',
  ai: '按意图操作',
  aiAct: '按意图操作',
}
const operationLabels = {
  tap: '点击',
  input: '输入',
  keyboard: '按键',
  scroll: '滚动',
}
export const demonstrationProfileLabels = {
  'playwright-crx@0.15.0': 'Playwright CRX 结构化录制',
  'cairn-crx-capture@1': '识途浏览器录制',
  'midscene-recorder-json@1': 'Midscene 录制 JSON',
  'midscene-yaml-flow@1': 'Midscene Web YAML',
}

export function DemonstrationFacts({
  source,
  detail,
}: {
  source: DemonstrationSource
  detail?: DemonstrationDetail
}) {
  const [selected, setSelected] = useState(0)
  const suggestions = useMemo(() => suggestDemonstration(source), [source])
  const fact = source.facts[Math.min(selected, source.facts.length - 1)]
  const suggestion = suggestions.find((s) => s.sourceIds.includes(fact.id))
  return (
    <section className='space-y-4' aria-label='示教来源检查'>
      <div className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
        <span>{demonstrationProfileLabels[source.importProfile]}</span>
        <span>· {source.facts.length} 条来源事实</span>
        <span>
          · {suggestions.filter((s) => s.status === 'unresolved').length}{' '}
          项待处理
        </span>
        <span>
          ·{' '}
          {source.sourceKind === 'script'
            ? '脚本来源，非人工操作证明'
            : source.actorKind === 'human'
              ? '人工录制来源'
              : source.actorKind === 'ai'
                ? 'AI 操作来源'
                : '操作者未知'}
        </span>
      </div>
      <div className='grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'>
        <ol className='max-h-96 space-y-1 overflow-y-auto rounded-lg border border-border-card bg-card p-2'>
          {source.facts.map((item, index) => (
            <li key={item.id}>
              <Button
                className='h-auto w-full justify-start py-3 text-left whitespace-normal'
                variant={index === selected ? 'secondary' : 'ghost'}
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                <span className='mr-3 text-muted-foreground'>{index + 1}</span>
                <span className='min-w-0 break-words'>
                  {item.data.targetDescription ||
                    item.data.instruction ||
                    actionLabels[item.action] ||
                    item.action}
                </span>
              </Button>
            </li>
          ))}
        </ol>
        <div className='min-w-0 space-y-4 rounded-lg border border-border-card bg-card p-4'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-body font-semibold'>
              {actionLabels[fact.action] || fact.action}
            </h3>
            <StatusBadge
              tone={suggestion?.status === 'mapped' ? 'success' : 'warning'}
            >
              {suggestion?.status === 'mapped'
                ? suggestion.outcome
                  ? '成功条件待确认'
                  : '可转为步骤'
                : fact.kind === 'observation'
                  ? '页面观察'
                  : '需要处理'}
            </StatusBadge>
          </div>
          <p className='text-body break-words'>
            {fact.data.targetDescription ||
              fact.data.instruction ||
              fact.data.url ||
              suggestion?.step?.name}
          </p>
          {fact.data.value && (
            <p className='text-label break-words'>
              输入：
              {fact.data.value.state === 'literal'
                ? fact.data.value.text || '（空）'
                : fact.data.value.reason}
            </p>
          )}
          {suggestion?.step && (
            <p className='text-label text-muted-foreground'>
              拟执行：{stepTypeLabel(suggestion.step.type)}
              {'operation' in suggestion.step.input
                ? ` · ${operationLabels[suggestion.step.input.operation]}`
                : ''}
            </p>
          )}
          {suggestion?.outcome && (
            <p className='text-label'>
              成功条件：{suggestion.outcome.meaning}（需手动确认）
            </p>
          )}
          {suggestion?.diagnostics.map((message) => (
            <p
              key={message}
              className='text-label text-status-warning-foreground'
            >
              {message}
            </p>
          ))}
          <div className='grid gap-3 sm:grid-cols-2'>
            {(['before', 'after'] as const).map((phase) => (
              <Observation
                key={`${fact.id}-${phase}`}
                title={phase === 'before' ? '动作前' : '动作后'}
                observation={fact[phase]}
                detail={detail}
              />
            ))}
          </div>
          <details className='text-label'>
            <summary className='cursor-pointer py-2 text-muted-foreground'>
              查看来源与结构化字段
            </summary>
            <pre className='max-h-72 overflow-auto rounded bg-muted p-3 break-all whitespace-pre-wrap'>
              {JSON.stringify(fact, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </section>
  )
}

function Observation({
  title,
  observation,
  detail,
}: {
  title: string
  observation: DemonstrationObservation
  detail?: DemonstrationDetail
}) {
  const artifact = detail?.artifacts.find(
    (a) => a.clientAssetId === observation.screenshotAssetId
  )
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState(false)
  useEffect(() => {
    setUrl(undefined)
    setError(false)
    if (!detail || artifact?.status !== 'available') return
    let active = true
    let local: string | undefined
    void fetchDemonstrationImage(detail.recordingDraftId, artifact.id)
      .then(({ blob }) => {
        if (!active) return
        local = URL.createObjectURL(blob)
        setUrl(local)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
      if (local) URL.revokeObjectURL(local)
    }
  }, [detail?.recordingDraftId, artifact?.id, artifact?.status])
  return (
    <div className='space-y-1 rounded border border-border-divider p-3 text-label'>
      <p className='font-medium'>
        {title} · {observationLabels[observation.status]}
      </p>
      {observation.observedAt && (
        <p className='text-muted-foreground'>
          {new Date(observation.observedAt).toLocaleTimeString()}
          {observation.ageMs !== undefined
            ? ` · 距动作 ${observation.ageMs}ms`
            : ''}
        </p>
      )}
      {observation.reason && <p>{observation.reason}</p>}
      {observation.url && (
        <p className='break-all text-muted-foreground'>{observation.url}</p>
      )}
      {observation.readyState && (
        <p>
          页面状态：
          {
            { loading: '加载中', interactive: '可交互', complete: '加载完成' }[
              observation.readyState
            ]
          }
        </p>
      )}
      {url && (
        <a href={url} target='_blank' rel='noreferrer'>
          <img
            src={url}
            alt={`${title}已检查的来源截图`}
            className='mt-2 w-full rounded'
          />
        </a>
      )}
      {artifact && artifact.status !== 'available' && (
        <p>
          截图{artifact.status === 'pending' ? '尚未上传' : '已不可用'}
          ，结构化事实仍保留。
        </p>
      )}
      {error && <p role='alert'>截图暂时无法读取</p>}
    </div>
  )
}

export function SavedDemonstrationFacts({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['demonstration', id],
    queryFn: () => fetchDemonstration(id),
  })
  if (query.isPending) return <p role='status'>正在读取来源事实…</p>
  if (query.isError)
    return (
      <QueryErrorState
        title='无法读取示教来源'
        onRetry={() => void query.refetch()}
      />
    )
  return <DemonstrationFacts source={query.data.source} detail={query.data} />
}
