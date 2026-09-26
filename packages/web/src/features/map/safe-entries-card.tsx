import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MapSafeEntryDto } from '@cairn/shared'
import {
  ExternalLink,
  Plus,
  Shield,
  Trash2,
  Edit2,
  AlertCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { archiveMapSafeEntry, fetchMapSafeEntries } from '@/lib/map-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SafeEntryDialog } from './safe-entry-dialog'

export interface SafeEntriesCardProps {
  targetId: string
}

const BASIS_LABELS: Record<string, string> = {
  confirmed_path: '已确认安全路径',
  target_readonly: '只读目标系统',
  controlled_env: '受控测试环境',
}

export function SafeEntriesCard({ targetId }: SafeEntriesCardProps) {
  const canRead = useCan('map:read')
  const canMaintain = useCan('map:maintain')
  const queryClient = useQueryClient()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<MapSafeEntryDto | null>(null)
  const [archivingEntry, setArchivingEntry] = useState<MapSafeEntryDto | null>(null)

  const entriesQuery = useQuery({
    queryKey: ['map', targetId, 'safe-entries'],
    queryFn: () => fetchMapSafeEntries(targetId),
    enabled: canRead,
  })

  const archiveMutation = useMutation({
    mutationFn: (entry: MapSafeEntryDto) =>
      archiveMapSafeEntry(targetId, entry.entryId, {
        reason: '用户手动归档移除安全入口',
      }),
    onSuccess: () => {
      toast.success('已归档并移除该安全进入路径')
      setArchivingEntry(null)
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'safe-entries'] })
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.error('该路径正被活动的定时计划或正在运行的作业占用，无法归档')
      } else {
        toast.error(err instanceof ApiRequestError || err instanceof Error ? err.message : '归档失败')
      }
    },
  })

  if (!canRead) return null

  const entries = entriesQuery.data?.items ?? []

  return (
    <section className='space-y-3.5 rounded-xl border border-border-card bg-surface p-4 shadow-card'>
      {/* 头部标题与新增入口操作 */}
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-card pb-3'>
        <div className='space-y-1'>
          <div className='flex items-center gap-2'>
            <Shield className='size-5 text-link' />
            <h2 className='text-section font-semibold text-text-primary'>安全进入路径</h2>
          </div>
          <p className='text-caption text-text-muted'>
            管理受控测绘与探索的初始入口。所有定时复查、手工探查与受限探索任务均基于已确认的安全入口执行。
          </p>
        </div>

        {canMaintain ? (
          <Button
            size='sm'
            className='gap-1.5'
            onClick={() => {
              setEditingEntry(null)
              setDialogOpen(true)
            }}
          >
            <Plus className='size-4' />
            新增安全入口
          </Button>
        ) : null}
      </div>

      {/* 列表渲染 */}
      {entriesQuery.isLoading ? (
        <div className='py-8 text-center text-caption text-text-muted'>正在加载安全路径…</div>
      ) : entriesQuery.isError ? (
        <div className='rounded-lg border border-border-danger bg-status-danger-subtle p-3 text-caption text-status-danger-foreground'>
          加载安全进入路径失败：{entriesQuery.error?.message}
        </div>
      ) : entries.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-lg border border-dashed border-border-card bg-surface-subtle p-8 text-center'>
          <AlertCircle className='size-8 text-text-muted mb-2' />
          <h3 className='text-body font-medium text-text-primary'>暂未登记安全进入路径</h3>
          <p className='mt-1 max-w-md text-caption text-text-muted'>
            测绘作业需要至少一条确认安全的入口网址。点击上方“新增安全入口”开始配置。
          </p>
          {canMaintain ? (
            <Button
              size='sm'
              variant='outline'
              className='mt-4 gap-1.5'
              onClick={() => {
                setEditingEntry(null)
                setDialogOpen(true)
              }}
            >
              <Plus className='size-4' />
              配置首个安全入口
            </Button>
          ) : null}
        </div>
      ) : (
        <div className='rounded-lg border border-border-card overflow-hidden'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[32%]'>路径名称与 URL</TableHead>
                <TableHead className='w-[24%]'>适用作业</TableHead>
                <TableHead className='w-[24%]'>安全与到达判定</TableHead>
                <TableHead className='w-[20%] text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.entryId}>
                  {/* 名称与 URL */}
                  <TableCell>
                    <div className='space-y-1'>
                      <div className='font-semibold text-text-primary'>{entry.name}</div>
                      <div className='flex items-center gap-1 text-caption text-text-muted'>
                        <span className='truncate max-w-[280px] font-mono'>{entry.url}</span>
                        <a
                          href={entry.url}
                          target='_blank'
                          rel='noreferrer'
                          className='text-link hover:underline shrink-0'
                          title='在新窗口打开此链接'
                        >
                          <ExternalLink className='size-3.5' />
                        </a>
                      </div>
                    </div>
                  </TableCell>

                  {/* 适用作业 */}
                  <TableCell>
                    <div className='flex flex-wrap gap-1.5'>
                      {entry.jobKinds.includes('map_probe') || entry.jobKinds.includes('map_refresh') ? (
                        <StatusBadge tone='info'>
                          定时与复查
                        </StatusBadge>
                      ) : null}
                      {entry.jobKinds.includes('map_explore') ? (
                        <StatusBadge tone='warning'>
                          受限探索
                        </StatusBadge>
                      ) : null}
                    </div>
                  </TableCell>

                  {/* 安全依据与到达判定 */}
                  <TableCell>
                    <div className='space-y-0.5 text-caption'>
                      <div className='text-text-primary'>
                        {BASIS_LABELS[entry.safetyBasis?.kind ?? ''] ?? entry.safetyBasis?.kind}
                      </div>
                      <div className='text-text-muted text-[11px] truncate max-w-[200px]'>
                        到达判定：{entry.arrivalName || '页面就绪'}
                      </div>
                    </div>
                  </TableCell>

                  {/* 操作按钮 */}
                  <TableCell className='text-right'>
                    {canMaintain ? (
                      <div className='flex items-center justify-end gap-1'>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-8 px-2 text-caption text-text-muted hover:text-text-primary'
                          onClick={() => {
                            setEditingEntry(entry)
                            setDialogOpen(true)
                          }}
                        >
                          <Edit2 className='size-3.5 mr-1' />
                          编辑
                        </Button>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-8 px-2 text-caption text-status-danger-foreground hover:bg-status-danger-subtle'
                          onClick={() => setArchivingEntry(entry)}
                        >
                          <Trash2 className='size-3.5 mr-1' />
                          归档
                        </Button>
                      </div>
                    ) : (
                      <span className='text-caption text-text-muted'>只读</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 新增/编辑弹窗 */}
      <SafeEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        targetId={targetId}
        entry={editingEntry}
      />

      {/* 归档二次确认弹窗 */}
      <ConfirmDialog
        open={Boolean(archivingEntry)}
        onOpenChange={(open) => !open && setArchivingEntry(null)}
        title='确认归档安全进入路径？'
        desc={
          archivingEntry
            ? `归档后，路径“${archivingEntry.name}”将无法用于发起新的测绘或探索作业。历史测绘事实和已生成资产不受影响。`
            : ''
        }
        confirmText='确认归档'
        cancelBtnText='取消'
        destructive
        isLoading={archiveMutation.isPending}
        handleConfirm={() => {
          if (archivingEntry) {
            archiveMutation.mutate(archivingEntry)
          }
        }}
      />
    </section>
  )
}
