import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchAccountSession,
  newSessionIdempotencyKey,
  requestAccountSessionOperation,
} from '@/lib/sessions-api'
import { disposeWorkerSession } from '@/lib/workers-api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { INSTANCE_STATUS_LABELS, INSTANCE_STATUS_TONE } from './labels'

export interface AccountInstancesSubtableProps {
  targetId: string
  accountId: string
  onOpenWorkbench?: (accountId: string) => void
  onChanged?: () => void
}

export function AccountInstancesSubtable({
  targetId,
  accountId,
  onOpenWorkbench,
  onChanged,
}: AccountInstancesSubtableProps) {
  const queryClient = useQueryClient()
  const [closing, setClosing] = useState<{
    id: string
    slot: number
    generation: number
  } | null>(null)
  const [disposingId, setDisposingId] = useState<string | null>(null)

  const detailQuery = useQuery({
    queryKey: ['account-session', targetId, accountId],
    queryFn: () => fetchAccountSession(targetId, accountId),
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['account-session', targetId, accountId] })
    await queryClient.invalidateQueries({ queryKey: ['sessions-overview'] })
    await queryClient.invalidateQueries({ queryKey: ['sessions-systems'] })
    onChanged?.()
  }

  const closeMutation = useMutation({
    mutationFn: (inst: { id: string; generation: number }) =>
      requestAccountSessionOperation(targetId, accountId, {
        kind: 'CLOSE',
        expectedSessionId: inst.id,
        expectedGeneration: inst.generation,
        idempotencyKey: newSessionIdempotencyKey('CLOSE'),
      }),
    onSuccess: async () => {
      toast.success('已提交关闭实例')
      setClosing(null)
      await invalidate()
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '关闭失败')
    },
  })

  const disposeMutation = useMutation({
    mutationFn: (sessionId: string) =>
      disposeWorkerSession(sessionId, { note: '实例列表处置失联实例' }),
    onSuccess: async () => {
      toast.success('已提交处置')
      setDisposingId(null)
      await invalidate()
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '处置失败')
    },
  })

  if (detailQuery.isPending) {
    return (
      <div className="flex items-center justify-center p-6 text-small text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载实例中…
      </div>
    )
  }

  if (detailQuery.isError) {
    return (
      <div className="p-4 text-small text-destructive">
        无法加载实例列表，请稍后重试。
      </div>
    )
  }

  const instances = detailQuery.data?.instances ?? []
  if (instances.length === 0) {
    return (
      <div className="p-4 text-small text-muted-foreground">
        当前无活跃实例。
      </div>
    )
  }

  return (
    <div className="border-t border-border-divider bg-muted/30 px-6 py-3">
      <div className="mb-2 text-label font-medium text-muted-foreground">
        并发会话实例 ({instances.length} 个)
      </div>
      <div className="overflow-hidden rounded-md border border-border-card bg-card shadow-xs">
        <Table>
          <TableHeader>
            <TableRow className="h-8 border-b text-label">
              <TableHead className="h-8">槽位</TableHead>
              <TableHead className="h-8">实例状态</TableHead>
              <TableHead className="h-8">执行节点</TableHead>
              <TableHead className="h-8">登录状态</TableHead>
              <TableHead className="h-8">占用情况</TableHead>
              <TableHead className="h-8">保留至</TableHead>
              <TableHead className="h-8 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {instances.map((inst) => {
              const status = inst.status as keyof typeof INSTANCE_STATUS_LABELS
              const statusText = INSTANCE_STATUS_LABELS[status] ?? inst.status
              const tone = INSTANCE_STATUS_TONE[status] ?? 'neutral'
              // 与账号级 canCloseAccountSession 的口径对齐：只有非终止态、且不在被
              // EXECUTION 租约占用时才允许关闭；执行中留给 Run 自己回收，失联走「处置」。
              const closable = inst.status === 'OPEN' && inst.occupancy?.purpose !== 'EXECUTION'

              return (
                <TableRow key={inst.id} className="h-10 text-small">
                  <TableCell className="font-mono text-label">
                    槽位 #{inst.accountSlot ?? 1}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={tone}>{statusText}</StatusBadge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`size-2 rounded-full ${
                          inst.ownerWorkerOnline
                            ? 'bg-status-success-foreground'
                            : 'bg-muted-foreground/40'
                        }`}
                        title={inst.ownerWorkerOnline ? 'Worker 在线' : 'Worker 离线'}
                      />
                      {inst.ownerWorkerId ? (
                        <Link
                          to="/workers/$workerId"
                          params={{ workerId: inst.ownerWorkerId }}
                          className="hover:text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {inst.ownerWorkerLabel || inst.ownerWorkerId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <span className="text-label text-muted-foreground">
                        · 代次 #{inst.generation}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {inst.authState === 'AUTHENTICATED'
                      ? '已登录'
                      : inst.authState === 'EXPIRED'
                        ? '需要登录'
                        : '待检查'}
                  </TableCell>
                  <TableCell>
                    {inst.occupancy?.occupyingRunId ? (
                      <Link
                        to="/runs/$runId"
                        params={{ runId: inst.occupancy.occupyingRunId }}
                        className="underline hover:text-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        运行 {inst.occupancy.occupyingRunId.slice(0, 8)}
                      </Link>
                    ) : inst.occupancy?.purpose === 'MAINTENANCE' ? (
                      <span className="text-muted-foreground">维护中</span>
                    ) : inst.occupancy?.purpose === 'AUTH_WAIT' ? (
                      <span className="text-muted-foreground">等待认证</span>
                    ) : (
                      <span className="text-muted-foreground">空闲</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {inst.retainUntil
                      ? new Date(inst.retainUntil).toLocaleTimeString()
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-label"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenWorkbench?.(accountId)
                        }}
                      >
                        接管
                      </Button>
                      <Can permission="session:manage">
                        {closable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-label text-muted-foreground hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation()
                              setClosing({
                                id: inst.id,
                                slot: inst.accountSlot ?? 1,
                                generation: inst.generation,
                              })
                            }}
                          >
                            关闭
                          </Button>
                        ) : null}
                      </Can>
                      <Can permission="session:dispose">
                        {inst.status === 'LOST' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-label text-destructive"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDisposingId(inst.id)
                            }}
                          >
                            处置
                          </Button>
                        ) : null}
                      </Can>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={Boolean(closing)}
        onOpenChange={(open) => !open && setClosing(null)}
        title="确认关闭此会话实例？"
        desc={
          closing
            ? `将关闭槽位 #${closing.slot}（代次 #${closing.generation}）的会话实例。`
            : ''
        }
        confirmText="关闭实例"
        destructive
        isLoading={closeMutation.isPending}
        handleConfirm={() => {
          if (closing) closeMutation.mutate(closing)
        }}
      />

      <ConfirmDialog
        open={Boolean(disposingId)}
        onOpenChange={(open) => !open && setDisposingId(null)}
        title="确认处置此失联实例？"
        desc="处置将强制清理残留记录并释放资源。"
        confirmText="处置"
        destructive
        isLoading={disposeMutation.isPending}
        handleConfirm={() => {
          if (disposingId) disposeMutation.mutate(disposingId)
        }}
      />
    </div>
  )
}
