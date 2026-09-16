import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useQuery } from '@tanstack/react-query'
import type { FrozenMapConsumption, MapSelectionDecision, RunDetailDto } from '@cairn/shared'
import { fetchRunMapDecisions } from '@/lib/runs-api'
import { useCan } from '@/hooks/use-permissions'

const MODE_LABELS: Record<string, string> = {
  off: '关闭',
  shadow: '仅比较',
  read_only_fallback: '只读步骤候选',
}

const DECISION_LABELS: Record<MapSelectionDecision['decision'], string> = {
  baseline: '沿用原定位',
  shadow_only: '比较后未替换',
  selected: '已选定只读候选',
  skipped: '已跳过',
  blocked: '写入失败已阻止',
}

const REASON_LABELS: Record<string, string> = {
  OFF: '未启用',
  STEP_NOT_ELIGIBLE: '步骤类型不在范围内',
  EFFECT_NOT_READ_ONLY: '不是只读步骤',
  BASELINE_FOUND: '原定位已找到对象',
  BASELINE_AMBIGUOUS: '原定位不唯一',
  BASELINE_SURFACE_LOST: '页面或 Frame 已丢失',
  BASELINE_OTHER: '原定位失败但不是未找到',
  TARGET_NOT_FOUND: '原定位未找到',
  NO_BINDING: '没有可操作绑定',
  PAGE_ONLY_REF: '只有页面引用',
  CONDITION_UNKNOWN: '条件未知',
  CONDITION_UNSATISFIED: '条件不匹配',
  NO_UNIQUE_CANDIDATE: '没有唯一候选',
  AMBIGUOUS_CANDIDATES: '多个对象同时命中',
  LOCATE_FAILED: '候选定位失败',
  BUDGET_EXHAUSTED: '剩余预算不足',
  MANIFEST_INTEGRITY: '冻结摘要不符',
  QUERY_UNAVAILABLE: '查询暂不可用',
  CANCELLED: '已取消',
  LEASE_LOST: '租约已失效',
  PERSISTENCE_FAILED: '选择事实写入失败',
  ELIGIBILITY_CLOSED: '资格未开放',
  FALLBACK_USED: '使用只读候选',
  SHADOW_WOULD_USE: '若开放会使用该候选',
}

type RunMapConsumptionProps = {
  frozen?: FrozenMapConsumption
}

export function RunMapConsumption({ frozen }: RunMapConsumptionProps) {
  if (!frozen) {
    return (
      <p className='mt-2 text-label text-muted-foreground'>历史运行未冻结地图消费，按关闭解释。</p>
    )
  }
  if (frozen.mode === 'off') {
    return <p className='mt-2 text-label text-muted-foreground'>本次运行未启用地图消费。</p>
  }
  return (
    <p className='mt-2 text-label text-muted-foreground'>
      地图消费 {MODE_LABELS[frozen.mode] ?? frozen.mode} · 版本 {frozen.releaseId.slice(0, 8)} · 摘要{' '}
      {frozen.manifestDigest.slice(0, 8)}
    </p>
  )
}

type RunMapDecisionsProps = {
  runId: string
  stepRunId?: string
  attemptId?: string
  eventSeq?: number
  steps?: RunDetailDto['stepRuns']
}

export function RunMapDecisions(props: RunMapDecisionsProps) {
  const [selectedStep, setSelectedStep] = useState(props.stepRunId ?? '')
  const [selectedAttempt, setSelectedAttempt] = useState(props.attemptId ?? '')
  const canReadRun = useCan('run:read')
  const canReadTarget = useCan('target:read')
  if (!canReadRun || !canReadTarget) return null
  const attempts = props.steps?.find(step => step.id === selectedStep)?.attempts ?? []
  return <div className='space-y-3'>
    {props.steps ? <div className='flex flex-wrap gap-3'>
      <label className='flex min-w-0 flex-1 flex-col gap-1 text-label'>地图选择的步骤
        <select className='h-10 rounded-md border border-input bg-background px-3' value={selectedStep} onChange={event => { setSelectedStep(event.target.value); setSelectedAttempt('') }}>
          <option value=''>全部步骤</option>
          {props.steps.map(step => <option key={step.id} value={step.id}>{step.name}</option>)}
        </select>
      </label>
      <label className='flex min-w-0 flex-1 flex-col gap-1 text-label'>地图选择的尝试
        <select className='h-10 rounded-md border border-input bg-background px-3' disabled={!selectedStep} value={selectedAttempt} onChange={event => setSelectedAttempt(event.target.value)}>
          <option value=''>全部尝试</option>
          {attempts.map(attempt => <option key={attempt.id} value={attempt.id}>第 {attempt.attemptNo} 次 · {attempt.status}</option>)}
        </select>
      </label>
    </div> : null}
    <DecisionPage key={`${props.runId}:${selectedStep}:${selectedAttempt}`} {...props} stepRunId={selectedStep || undefined} attemptId={selectedAttempt || undefined} />
  </div>
}

function DecisionPage({ runId, stepRunId, attemptId, eventSeq }: RunMapDecisionsProps) {
  const canReadRun = useCan('run:read')
  const canReadTarget = useCan('target:read')
  const canRead = canReadRun && canReadTarget
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const cursor = cursors[cursors.length - 1]
  const query = useQuery({
    queryKey: ['runs', runId, 'map-decisions', stepRunId, attemptId, cursor],
    queryFn: () => fetchRunMapDecisions(runId, { stepRunId, attemptId, cursor, limit: 50 }),
    enabled: canRead,
  })

  const { refetch } = query
  useEffect(() => { if (canRead && eventSeq !== undefined) void refetch() }, [canRead, eventSeq, refetch])

  if (!canRead) return null

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>地图选择</h2>
      <p className='text-label text-muted-foreground'>
        解释候选选择依据。读取是否完成以对应尝试的证据为准；选择记录不代表结果已改善。
      </p>
      {query.isPending ? (
        <p className='text-label text-muted-foreground'>选择记录加载中…</p>
      ) : query.isError ? (
        <div><p className='text-label text-muted-foreground'>暂时无法读取地图选择。本次运行证据仍以时间线为准。</p><Button variant='outline' onClick={() => void query.refetch()}>重试</Button></div>
      ) : query.data.items.length === 0 ? (
        <p className='text-label text-muted-foreground'>
          {stepRunId ? '该步骤没有地图选择记录。' : '本次运行没有地图选择记录。'}
        </p>
      ) : (
        <ul className='space-y-2'>
          {query.data.items.map((item) => (
            <li key={item.decisionId} className='space-y-2 rounded-md border p-3 text-body break-words'><p>
              {DECISION_LABELS[item.decision]}
              {` · ${REASON_LABELS[item.reasonCode] ?? item.reasonCode}`}
              {` · ${item.spentMs} ms`}
              {item.selectedDescriptorVersion != null
                ? ` · 描述版本 ${item.selectedDescriptorVersion}`
                : ''}</p>
              <p className='text-label text-muted-foreground'>步骤 {item.stepRunId.slice(0, 8)} · 尝试 {item.attemptId.slice(0, 8)} · 原结果 {item.baselineOutcome} · 额外 AI 调用 {item.extraAiCalls}</p>
              <details>
                <summary className='cursor-pointer text-label'>查看候选、条件与证据</summary>
                <div className='mt-2 space-y-2 text-label'>
                  {item.candidatesEvaluated.length ? item.candidatesEvaluated.map((candidate, index) => (
                    <p key={index}>候选 {index + 1} · 对象 {candidate.objectId ?? '未指定'} · {candidate.outcome} · 命中 {candidate.matches}{candidate.reasonCode ? ` · ${REASON_LABELS[candidate.reasonCode] ?? candidate.reasonCode}` : ''}</p>
                  )) : <p>没有查询候选。</p>}
                  <p>冻结版本：{item.releaseId ?? '未记录'} · 描述摘要：{item.selectedDescriptorDigest ?? '未采用候选'}</p>
                  <p>条件：{item.conditionSnapshot ? `账号 ${item.conditionSnapshot.accountBinding.presence}；未知 ${item.conditionSnapshot.unknownFields.join('、') || '无'}` : '未记录'}</p>
                  <p>关联证据：{item.evidenceRefs.length ? item.evidenceRefs.map(ref => JSON.stringify(ref)).join('；') : '请按上述尝试在步骤时间线查看执行证据。'}</p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {cursors.length > 1 || query.data?.nextCursor ? <nav aria-label='地图选择分页' className='flex items-center gap-2'>
        <Button variant='outline' disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors(items => items.slice(0, -1))}>上一页</Button>
        <span className='text-label'>第 {cursors.length} 页</span>
        <Button variant='outline' disabled={!query.data?.nextCursor || query.isFetching} onClick={() => setCursors(items => [...items, query.data?.nextCursor])}>下一页</Button>
      </nav> : null}
    </section>
  )
}
