import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AlertCircle, CheckCircle2, FileText, History, Layers, Loader2, PlaySquare, ShieldAlert, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import type {
  CleanupStatusResponse,
  DeletePreviewResponse,
  DeleteResourceBody,
  DeleteResourceResult,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Link } from '@tanstack/react-router'
import { Can } from '@/components/rbac/can'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export type ResourceDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceId: string
  resourceName: string
  resourceType: 'target' | 'scenario' | 'run' | 'recording'
  previewFn?: () => Promise<DeletePreviewResponse>
  deleteFn: (body?: DeleteResourceBody) => Promise<CleanupStatusResponse | DeleteResourceResult | void>
  onSuccess: (result?: CleanupStatusResponse | DeleteResourceResult | void) => void
}

export function ResourceDeleteDialog({
  open,
  onOpenChange,
  resourceId,
  resourceName,
  resourceType,
  previewFn,
  deleteFn,
  onSuccess,
}: ResourceDeleteDialogProps) {
  const [submitting, setSubmitting] = useState(false)

  const previewQuery = useQuery({
    queryKey: ['delete-preview', resourceType, resourceId],
    queryFn: previewFn ?? (() => Promise.resolve({ previewToken: 'none', counts: {}, blockers: [] })),
    enabled: open && Boolean(previewFn),
    staleTime: 0,
  })

  const preview = previewQuery.data
  const blockers = preview?.blockers ?? []
  const hasBlockers = blockers.length > 0
  const counts = preview?.counts ?? {}

  const titles: Record<string, string> = {
    target: '删除目标系统',
    scenario: '删除场景',
    run: '删除运行记录',
    recording: '删除录制草稿',
  }

  const handleConfirm = async () => {
    if (hasBlockers) return
    setSubmitting(true)
    try {
      const body: DeleteResourceBody | undefined = counts
        ? {
            expectedCounts: {
              targetAccounts: counts.targetAccounts,
              scenarios: counts.scenarios,
              recordings: counts.recordings,
              runs: counts.runs,
            },
          }
        : undefined

      const result = await deleteFn(body)
      if (result && typeof result === 'object' && 'totalObjects' in result && result.totalObjects > 0) {
        toast.success('业务资源已删除，附件异步清理中')
      } else {
        toast.success('已删除')
      }
      onOpenChange(false)
      onSuccess(result)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        toast.error(err.message)
      } else {
        toast.error('删除操作失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className='max-w-lg'>
        <AlertDialogHeader className='text-start'>
          <AlertDialogTitle className='flex items-center gap-2 text-destructive'>
            <Trash2 className='size-5' />
            {titles[resourceType] ?? '确认删除'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className='space-y-4 pt-2 text-body text-text-primary'>
              {previewQuery.isPending && previewFn ? (
                <div className='flex items-center justify-center gap-2 py-6 text-muted-foreground'>
                  <Loader2 className='size-5 animate-spin' />
                  <span>正在检查资源依赖与级联范围…</span>
                </div>
              ) : previewQuery.isError ? (
                <div className='rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive'>
                  <div className='flex items-center gap-2 font-medium'>
                    <AlertCircle className='size-4' />
                    无法检查删除影响范围
                  </div>
                  <p className='mt-1 text-label'>
                    {previewQuery.error instanceof Error
                      ? previewQuery.error.message
                      : '请稍后重试'}
                  </p>
                </div>
              ) : (
                <>
                  <p>
                    确定删除「<strong className='font-semibold'>{resourceName}</strong>」吗？此操作不可逆。
                  </p>

                  {hasBlockers ? (
                    <div className='rounded-md border border-destructive/30 bg-destructive/10 p-3.5 text-destructive'>
                      <div className='flex items-center gap-2 font-medium text-body'>
                        <ShieldAlert className='size-4 shrink-0' />
                        存在冲突或进行中的任务，无法删除：
                      </div>
                      <ul className='mt-2 list-inside list-disc space-y-1 text-label'>
                        {blockers.map((b, i) => (
                          <li key={b.id || i}>
                            {b.code === 'RUN_NOT_TERMINAL' && RUN_ID.test(b.id) ? (
                              <Can permission='run:read' fallback={b.message}>
                                <Link
                                  to='/runs/$runId'
                                  params={{ runId: b.id }}
                                  className='text-primary underline-offset-2 hover:underline'
                                >
                                  {b.message}
                                </Link>
                              </Can>
                            ) : (
                              b.message
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {!hasBlockers && resourceType === 'target' && (
                    <div className='rounded-md border border-border-default bg-muted/40 p-3.5 space-y-2.5'>
                      <p className='text-label font-medium text-text-secondary'>
                        该目标系统下的所有关联资源将一并级联软删除：
                      </p>
                      <div className='grid grid-cols-2 gap-2 text-label'>
                        <div className='flex items-center gap-2'>
                          <Users className='size-3.5 text-muted-foreground' />
                          <span>目标账号：{counts.targetAccounts ?? 0} 个</span>
                        </div>
                        <div className='flex items-center gap-2'>
                          <Layers className='size-3.5 text-muted-foreground' />
                          <span>业务场景：{counts.scenarios ?? 0} 个</span>
                        </div>
                        <div className='flex items-center gap-2'>
                          <FileText className='size-3.5 text-muted-foreground' />
                          <span>录制草稿：{counts.recordings ?? 0} 个</span>
                        </div>
                        <div className='flex items-center gap-2'>
                          <PlaySquare className='size-3.5 text-muted-foreground' />
                          <span>历史运行：{counts.runs ?? 0} 个</span>
                        </div>
                        <div className='col-span-2 flex items-center gap-2 text-muted-foreground pt-1 border-t border-border-divider'>
                          <History className='size-3.5' />
                          <span>
                            存储附件：{counts.storedObjects ?? 0} 个对象（约{' '}
                            {formatBytes(counts.totalBytes)}）待物理清理
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {!hasBlockers && resourceType === 'scenario' && (
                    <div className='rounded-md border border-border-default bg-muted/40 p-3 text-label text-text-secondary space-y-1.5'>
                      <p className='flex items-center gap-1.5 font-medium text-text-primary'>
                        <CheckCircle2 className='size-4 text-status-success-foreground' />
                        合规保护提示
                      </p>
                      <p>
                        删除场景后将无法发起新运行。根据平台宪法，历史运行记录、执行步骤与证据数据将完整保留。
                      </p>
                    </div>
                  )}

                  {!hasBlockers && resourceType === 'run' && (
                    <div className='rounded-md border border-border-default bg-muted/40 p-3 text-label text-text-secondary space-y-1.5'>
                      <p>
                        该运行记录及其执行证据将被软删除。包含的{' '}
                        <strong>{counts.storedObjects ?? 0}</strong> 个存储对象（约{' '}
                        {formatBytes(counts.totalBytes)}）将进入物理清理队列。
                      </p>
                    </div>
                  )}

                  {!hasBlockers && resourceType === 'recording' && (
                    <div className='rounded-md border border-border-default bg-muted/40 p-3 text-label text-text-secondary space-y-1.5'>
                      <p>录制草稿删除后，已导入至场景的步骤不会受到影响。</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
          <Button
            variant='destructive'
            disabled={hasBlockers || submitting || previewQuery.isPending}
            loading={submitting}
            onClick={handleConfirm}
          >
            {hasBlockers ? '无法删除' : '确认删除'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
