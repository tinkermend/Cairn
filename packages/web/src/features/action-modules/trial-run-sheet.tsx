import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Terminal,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { fetchRun } from '@/lib/runs-api'

export interface TrialRunSheetProps {
  runId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  currentInputs?: Record<string, string>
  onSaveAsFixture?: (
    name: string,
    inputs: Record<string, string>,
    lastRun?: {
      runId: string
      outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
      durationMs?: number
      executedAt: string
    }
  ) => void
}

export function TrialRunSheet({
  runId,
  open,
  onOpenChange,
  currentInputs,
  onSaveAsFixture,
}: TrialRunSheetProps) {
  const [fixtureName, setFixtureName] = useState('')
  const [savingFixture, setSavingFixture] = useState(false)

  const runQuery = useQuery({
    queryKey: ['trial-run-observation', runId],
    queryFn: () => (runId ? fetchRun(runId) : null),
    enabled: open && Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (
        status === 'SUCCEEDED' ||
        status === 'FAILED' ||
        status === 'CANCELLED' ||
        status === 'NEEDS_REVIEW'
      ) {
        return false
      }
      return 1500
    },
  })

  const run = runQuery.data
  const isTerminal =
    run?.status === 'SUCCEEDED' ||
    run?.status === 'FAILED' ||
    run?.status === 'CANCELLED' ||
    run?.status === 'NEEDS_REVIEW'

  const durationText = run?.finishedAt && run?.startedAt
    ? `${Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 100) / 10)}s`
    : run?.startedAt
      ? '执行中…'
      : '等待中'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='flex flex-col gap-0 p-0 sm:max-w-lg'
        aria-describedby='trial-sheet-description'
      >
        <SheetHeader className='border-b border-border p-4 pb-3'>
          <div className='flex items-center justify-between gap-2 pe-6'>
            <SheetTitle className='flex items-center gap-2 text-section font-semibold'>
              <Terminal className='size-4 text-primary' />
              <span>试跑原地观测</span>
            </SheetTitle>
            {run && (
              <Badge
                variant='outline'
                className={
                  run.status === 'SUCCEEDED'
                    ? 'border-status-success-accent bg-status-success-background text-status-success-foreground font-medium'
                    : run.status === 'FAILED'
                      ? 'border-destructive/30 bg-destructive/10 text-destructive font-medium'
                      : 'font-medium'
                }
              >
                {run.status === 'SUCCEEDED' ? (
                  <span className='flex items-center gap-1'>
                    <CheckCircle2 className='size-3 text-status-success-foreground' />
                    已通过
                  </span>
                ) : run.status === 'FAILED' ? (
                  <span className='flex items-center gap-1'>
                    <XCircle className='size-3 text-destructive' />
                    失败
                  </span>
                ) : (
                  <span className='flex items-center gap-1'>
                    <Loader2 className='size-3 animate-spin text-primary' />
                    {run.status}
                  </span>
                )}
              </Badge>
            )}
          </div>
          <SheetDescription id='trial-sheet-description' className='text-label text-muted-foreground'>
            {runId ? `执行实例: ${runId}` : '暂无执行实例'}
            {run?.startedAt && ` · 耗时 ${durationText}`}
          </SheetDescription>
        </SheetHeader>

        <div className='flex-1 space-y-4 overflow-y-auto p-4'>
          {runQuery.isLoading && (
            <div className='flex items-center justify-center py-12 text-small text-muted-foreground'>
              <Loader2 className='mr-2 size-4 animate-spin' />
              正在同步试跑事实…
            </div>
          )}

          {runQuery.isError && (
            <div
              role='alert'
              className='rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-small text-destructive'
            >
              获取运行状态失败: {runQuery.error.message}
            </div>
          )}

          {run && (
            <>
              {/* 步骤执行进度 */}
              <div className='space-y-2 rounded-xl border border-card bg-card p-3 shadow-card'>
                <div className='flex items-center justify-between text-label font-medium text-muted-foreground'>
                  <span>步骤执行流水 ({run.stepRuns?.length ?? 0})</span>
                  <span>{run.status}</span>
                </div>
                {run.stepRuns && run.stepRuns.length > 0 ? (
                  <div className='space-y-1.5'>
                    {run.stepRuns.map((stepRun, i) => (
                      <div
                        key={stepRun.id}
                        className='flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-small'
                      >
                        <div className='flex items-center gap-2 truncate'>
                          <span className='font-mono text-label text-muted-foreground'>
                            {i + 1}
                          </span>
                          <span className='truncate font-medium'>
                            {stepRun.name || `步骤 ${i + 1}`}
                          </span>
                        </div>
                        <div className='flex shrink-0 items-center gap-2'>
                          {stepRun.status === 'SUCCEEDED' && (
                            <span className='flex items-center gap-1 font-mono text-label text-status-success-foreground'>
                              <CheckCircle2 className='size-3 text-status-success-foreground' />
                              成功
                            </span>
                          )}
                          {stepRun.status === 'FAILED' && (
                            <span className='flex items-center gap-1 font-mono text-label text-destructive'>
                              <XCircle className='size-3 text-destructive' />
                              失败
                            </span>
                          )}
                          {stepRun.status === 'RUNNING' && (
                            <span className='flex items-center gap-1 font-mono text-label text-primary'>
                              <Loader2 className='size-3 animate-spin text-primary' />
                              执行中
                            </span>
                          )}
                          {stepRun.status === 'PENDING' && (
                            <span className='flex items-center gap-1 font-mono text-label text-muted-foreground'>
                              <Clock className='size-3' />
                              等待
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className='py-2 text-center text-label text-muted-foreground'>
                    初始化步骤调度队列中…
                  </p>
                )}
              </div>

              {/* 产出输出数据 (Context Outputs) */}
              <div className='space-y-2 rounded-xl border border-card bg-card p-3 shadow-card'>
                <h4 className='text-label font-medium text-muted-foreground'>
                  执行上下文产出 (Outputs)
                </h4>
                {run.context && Object.keys(run.context).length > 0 ? (
                  <pre className='max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-label text-foreground'>
                    {JSON.stringify(run.context, null, 2)}
                  </pre>
                ) : (
                  <p className='text-label text-muted-foreground'>
                    {isTerminal ? '本次执行未产出输出字段。' : '执行进行中，产出数据将在完成后展现…'}
                  </p>
                )}
              </div>

              {/* 失败原因提示 */}
              {(run as any).error && (
                <div
                  role='alert'
                  className='space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-small text-destructive'
                >
                  <div className='flex items-center gap-1.5 font-medium'>
                    <AlertTriangle className='size-4 shrink-0' />
                    <span>执行异常终止</span>
                  </div>
                  <p className='font-mono text-label break-all'>
                    {typeof (run as any).error === 'object' && (run as any).error !== null
                      ? JSON.stringify((run as any).error)
                      : String((run as any).error)}
                  </p>
                </div>
              )}

              {/* 另存为测试用例 */}
              {onSaveAsFixture && currentInputs && Object.keys(currentInputs).length > 0 && isTerminal && (
                <div className='space-y-2.5 rounded-xl border border-primary/20 bg-primary/5 p-3'>
                  <div className='flex items-center justify-between'>
                    <span className='text-label font-medium text-primary'>
                      将当前入参沉淀为测试用例
                    </span>
                    {!savingFixture && (
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='h-6 gap-1 text-label'
                        onClick={() => setSavingFixture(true)}
                      >
                        <BookmarkPlus className='size-3' />
                        另存为用例
                      </Button>
                    )}
                  </div>
                  {savingFixture && (
                    <div className='flex items-center gap-2 pt-1'>
                      <input
                        type='text'
                        aria-label='用例名称'
                        placeholder='例如: 正向订单查询用例'
                        value={fixtureName}
                        onChange={(e) => setFixtureName(e.target.value)}
                        className='h-7 flex-1 rounded border border-border bg-card px-2 text-label'
                      />
                      <Button
                        type='button'
                        size='sm'
                        className='h-7 text-label'
                        disabled={!fixtureName.trim()}
                        onClick={() => {
                          const lastRunInfo =
                            run &&
                            (run.status === 'SUCCEEDED' ||
                              run.status === 'FAILED' ||
                              run.status === 'CANCELLED')
                              ? {
                                  runId: run.id,
                                  outcome: run.status as
                                    | 'SUCCEEDED'
                                    | 'FAILED'
                                    | 'CANCELLED',
                                  durationMs:
                                    run.finishedAt && run.startedAt
                                      ? new Date(run.finishedAt).getTime() -
                                        new Date(run.startedAt).getTime()
                                      : undefined,
                                  executedAt:
                                    run.startedAt || new Date().toISOString(),
                                }
                              : undefined
                          onSaveAsFixture(
                            fixtureName.trim(),
                            currentInputs,
                            lastRunInfo
                          )
                          setSavingFixture(false)
                          setFixtureName('')
                        }}
                      >
                        确认保存
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='h-7 text-label'
                        onClick={() => setSavingFixture(false)}
                      >
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 抽屉底部操作条 */}
        <div className='flex items-center justify-between border-t border-border p-3'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='text-label'
            onClick={() => onOpenChange(false)}
          >
            收起面板
          </Button>
          {runId && (
            <a
              href={`/runs/${runId}`}
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex items-center gap-1 text-label font-medium text-primary hover:underline'
            >
              <span>新标签页查看完整回放</span>
              <ExternalLink className='size-3' />
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
