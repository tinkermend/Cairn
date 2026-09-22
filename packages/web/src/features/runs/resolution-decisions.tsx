import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ResolutionDecision, RunDetailDto } from '@cairn/shared'
import { RESOLUTION_PREFERENCE_LABELS } from '@cairn/shared'
import { fetchRunResolutionDecisions } from '@/lib/runs-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { SelectField, SelectFieldOption } from '@/components/ui/select'

const DECISION_LABELS: Record<ResolutionDecision['decision'], string> = {
  deterministic: '规则命中',
  map: '地图命中',
  ai: '经 AI 定位',
  failed: '解析失败',
}

const REASON_LABELS: Record<string, string> = {
  FRAME_UNSUPPORTED: '不支持 Frame',
  CEILING_CLOSED: '未开放 AI 定位',
  BUDGET_EXHAUSTED: '预算或期限不足',
  CROSS_CHECK_FAILED: '交叉确认未通过',
  CROSS_CHECK_NOT_APPLICABLE: '写步骤缺少可确认候选',
  AI_NOT_FOUND: 'AI 未找到目标',
  AI_AMBIGUOUS_POINT: 'AI 定位点不唯一',
  AI_HUNG: 'AI 调用未落定',
  AI_DISABLED: '本次运行未冻结 AI',
  AI_CONFIG_INVALID: 'AI 配置无效',
  WAIT_KIND_UNAVAILABLE: '语义等待尚未交付',
  CANCELLED: '已取消',
  LEASE_LOST: '租约已失效',
  SURFACE_LOST: '页面已丢失',
  CAPABILITY_MISSING: '缺少浏览器能力',
  TARGET_NOT_FOUND: '未找到目标',
  TARGET_AMBIGUOUS: '目标不唯一',
  PERSISTENCE_FAILED: '决策写入失败',
}

type RunResolutionDecisionsProps = {
  runId: string
  eventSeq?: number
  steps?: RunDetailDto['stepRuns']
}

export function RunResolutionDecisions(props: RunResolutionDecisionsProps) {
  const [selectedStep, setSelectedStep] = useState('')
  const canReadRun = useCan('run:read')
  const canReadTarget = useCan('target:read')
  const canRead = canReadRun && canReadTarget
  if (!canRead) return null
  return (
    <div className='space-y-3'>
      {props.steps ? (
        <label className='flex min-w-0 flex-col gap-1 text-label'>
          解析决策的步骤
          <SelectField value={selectedStep} onValueChange={setSelectedStep}>
            <SelectFieldOption value=''>全部步骤</SelectFieldOption>
            {props.steps.map((step) => (
              <SelectFieldOption key={step.id} value={step.id}>
                {step.name}
              </SelectFieldOption>
            ))}
          </SelectField>
        </label>
      ) : null}
      <DecisionPage
        key={`${props.runId}:${selectedStep}`}
        runId={props.runId}
        eventSeq={props.eventSeq}
        stepRunId={selectedStep || undefined}
        steps={props.steps}
      />
    </div>
  )
}

function DecisionPage({
  runId,
  eventSeq,
  stepRunId,
  steps,
}: {
  runId: string
  eventSeq?: number
  stepRunId?: string
  steps?: RunDetailDto['stepRuns']
}) {
  const canReadRun = useCan('run:read')
  const canReadTarget = useCan('target:read')
  const canRead = canReadRun && canReadTarget
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const cursor = cursors[cursors.length - 1]
  const query = useQuery({
    queryKey: ['runs', runId, 'resolution-decisions', stepRunId, cursor],
    queryFn: () => fetchRunResolutionDecisions(runId, { stepRunId, cursor, limit: 50 }),
    enabled: canRead,
  })
  const { refetch } = query
  useEffect(() => {
    if (canRead && eventSeq !== undefined) void refetch()
  }, [canRead, eventSeq, refetch])

  if (!canRead) return null
  const stepName = (stepRunIdValue: string) =>
    steps?.find((step) => step.id === stepRunIdValue)?.name ?? `步骤 ${stepRunIdValue.slice(0, 8)}`

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>目标解析</h2>
      <p className='text-label text-muted-foreground'>
        解释这一次如何找到目标。规则命中、地图命中和经 AI 定位是事实，不代表业务成功。
      </p>
      {query.isPending ? (
        <p className='text-label text-muted-foreground'>正在读取解析决策…</p>
      ) : query.isError ? (
        <div>
          <p className='text-label text-muted-foreground'>暂时无法读取解析决策。本次运行证据仍以时间线为准。</p>
          <Button variant='outline' onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : query.data.items.length === 0 ? (
        <p className='text-label text-muted-foreground'>
          {stepRunId ? '该步骤没有解析阶梯决策。' : '本次运行没有解析阶梯决策。'}
        </p>
      ) : (
        <ul className='space-y-2'>
          {query.data.items.map((item) => (
            <li key={item.decisionId} className='space-y-1 rounded-md border p-3 text-body break-words'>
              <p>
                <span className='font-medium'>{DECISION_LABELS[item.decision]}</span>
                {item.reasonCode ? ` · ${REASON_LABELS[item.reasonCode] ?? item.reasonCode}` : ''}
              </p>
              <p className='text-label text-muted-foreground'>
                {stepName(item.stepRunId)} · {RESOLUTION_PREFERENCE_LABELS[item.effectivePolicy]} ·{' '}
                {item.rungs.map((rung) => rung.rung).join('→') || '无阶梯'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {cursors.length > 1 || query.data?.nextCursor ? (
        <nav aria-label='目标解析分页' className='flex items-center gap-2'>
          <Button
            variant='outline'
            disabled={cursors.length === 1 || query.isFetching}
            onClick={() => setCursors((items) => items.slice(0, -1))}
          >
            上一页
          </Button>
          <span className='text-label'>第 {cursors.length} 页</span>
          <Button
            variant='outline'
            disabled={!query.data?.nextCursor || query.isFetching}
            onClick={() => setCursors((items) => [...items, query.data?.nextCursor])}
          >
            下一页
          </Button>
        </nav>
      ) : null}
    </section>
  )
}
