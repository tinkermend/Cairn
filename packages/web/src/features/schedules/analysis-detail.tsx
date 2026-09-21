import { lazy, Suspense, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { analysisJobDtoSchema } from '@cairn/shared'
import { toast } from 'sonner'
import { fetchAnalysisJob, cancelAnalysisJob } from '@/lib/schedules-api'
import { subscribeObservation } from '@/lib/observation-stream'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MODE_LABELS, CANDIDATE_STATUS } from './labels'
import { useCan } from '@/hooks/use-permissions'

const STATUS: Record<string, string> = { QUEUED: '等待执行', RUNNING: '分析中', RETRY_WAIT: '等待重试', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消' }
const CandidateReviewDialog = lazy(() => import('./candidate-review').then(module => ({ default: module.CandidateReviewDialog })))

export function AnalysisDetailDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const client = useQueryClient()
  const [realtime, setRealtime] = useState(true)
  const [candidateId, setCandidateId] = useState<string | null>(null)
  const canReadMap = useCan('map:read')
  const query = useQuery({ queryKey: ['analysis-job', jobId], queryFn: () => fetchAnalysisJob(jobId) })
  const cancel = useMutation({ mutationFn: () => cancelAnalysisJob(jobId), onSuccess: job => client.setQueryData(['analysis-job', jobId], job), onError: (error: Error) => toast.error(error.message) })
  useEffect(() => {
    if (!query.isSuccess) return
    const controller = new AbortController()
    void subscribeObservation({ path: `/api/analysis-jobs/${jobId}/observe`, event: 'job', schema: analysisJobDtoSchema, signal: controller.signal,
      onObservation: job => client.setQueryData(['analysis-job', jobId], job),
      onRealtime: setRealtime,
      isFinished: job => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status),
    }).catch((error: Error) => { if (!controller.signal.aborted) toast.error(error.message) })
    return () => controller.abort()
  }, [jobId, client, query.isSuccess])
  const job = query.data
  const candidate = job?.candidates?.find(item => item.candidateId === candidateId)
  return <><Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
    <DialogHeader><DialogTitle>分析结果</DialogTitle><DialogDescription>查看分析范围、结果及来源。候选知识需要人工检查，尚未发布。</DialogDescription></DialogHeader>
    {query.isPending ? <p role='status'>正在加载分析结果…</p> : null}
    {query.isError ? <div role='alert'><p>读取失败：{query.error.message}</p><Button variant='outline' onClick={() => void query.refetch()}>重试</Button></div> : null}
    {job ? <div className='grid gap-4 text-body'>
      <p>{MODE_LABELS[job.mode]} · {STATUS[job.status]} · 尝试 {job.attemptCount} 次</p>
      {!realtime ? <p role='status' className='text-muted-foreground'>实时通知未启用，当前约每 30 秒同步一次结果。</p> : null}
      {job.result?.error ? <p role='alert' className='break-words text-destructive'>{String(job.result.error)}</p> : null}
      {job.mode === 'run_incremental' ? <p>检查点 {job.afterSeq} → {job.checkpointSeq} · 本批处理 {Number(job.result?.processed ?? 0)} 条来源{job.result?.uniqueRunCount !== undefined ? `，覆盖 ${Number(job.result.uniqueRunCount)} 次运行` : ''}{job.result?.hasMore ? ' · 尚有数据待下一批处理' : ''}</p> : <p>地图页面 {Number(job.result?.pageCount ?? 0)} · 对象 {Number(job.result?.objectCount ?? 0)} · 冲突 {Number(job.result?.conflictCount ?? 0)}{job.result?.sampled ? ' · 候选基于部分页面样本' : ''}</p>}
      {job.result?.code === 'NO_NEW_DATA' ? <p>当前范围没有新增数据。</p> : null}
      <p className='text-label text-muted-foreground'>{job.modelUsage?.invoked ? `模型 ${job.modelUsage.model} · 输入 ${job.modelUsage.inputTokens ?? '未知'} / 输出 ${job.modelUsage.outputTokens ?? '未知'} Token · ${job.modelUsage.durationMs ?? 0} ms` : '确定性分析，未调用模型'}</p>
      {job.coverageGaps.length ? <p className='break-words text-label text-muted-foreground'>覆盖限制：{job.coverageGaps.join(' · ')}</p> : null}
      {job.attempts?.length ? <details className='rounded-md border p-3'><summary className='cursor-pointer font-medium'>执行尝试与模型用量</summary><ul className='mt-3 grid gap-2 text-label'>{job.attempts.map(attempt => <li key={attempt.attemptId} className='break-words'>第 {attempt.attemptNo} 次 · {STATUS[attempt.status] ?? attempt.status}{attempt.error ? ` · ${attempt.error}` : ''}{attempt.modelUsage?.invoked ? ` · ${attempt.modelUsage.model} · 输入 ${attempt.modelUsage.inputTokens ?? '未知'} / 输出 ${attempt.modelUsage.outputTokens ?? '未知'} Token` : ''}</li>)}</ul></details> : null}
      <h3 className='text-section font-semibold'>候选知识</h3>
      {job.candidates?.length ? <ul className='grid gap-3'>{job.candidates.map(candidate => <li key={candidate.candidateId} className='grid gap-2 rounded-md border p-3'>
        <p className='font-medium'>{candidate.title}</p><p className='whitespace-pre-wrap break-words'>{candidate.summary}</p>
        <div className='flex flex-wrap gap-3'>{candidate.sources.map((source, index) => typeof source.runId === 'string' ? <a className='text-link underline' key={index} href={`/runs/${source.runId}`}>查看来源运行</a> : <a className='text-link underline' key={index} href={`/targets/${job.targetId}/map`}>查看来源地图</a>)}</div>
        <div className='flex flex-wrap items-center justify-between gap-2'><span className='text-label text-muted-foreground'>{CANDIDATE_STATUS[candidate.status]}{candidate.proposalStatus === 'stale' ? ' · 场景草稿已更新' : ''}</span>{canReadMap ? <Button variant='outline' size='sm' onClick={() => setCandidateId(candidate.candidateId)}>{candidate.status === 'pending' ? '审阅与采纳' : '查看处理结果'}</Button> : null}</div>
      </li>)}</ul> : <p className='text-muted-foreground'>暂无候选知识。</p>}
      {['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status) ? <Button variant='outline' disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消分析</Button> : null}
    </div> : null}
  </DialogContent></Dialog>{candidate && job ? <Suspense fallback={<p role='status'>正在打开审阅…</p>}><CandidateReviewDialog key={candidate.candidateId} candidate={candidate} targetId={job.targetId} onClose={() => setCandidateId(null)} /></Suspense> : null}</>
}
