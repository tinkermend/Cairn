import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import type { TargetDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { deleteTarget, fetchTargets } from '@/lib/targets-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AUTH_METHOD_LABELS, CAPTCHA_MODE_LABELS, TARGET_STATUS_LABELS } from './labels'
import { TargetFormDialog } from './target-form-dialog'

export function TargetsPage() {
  const query = useQuery({ queryKey: ['targets'], queryFn: fetchTargets })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<TargetDto | null>(null)
  const [saving, setSaving] = useState(false)
  const items = query.data?.items ?? []

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='目标系统'
          description='登记要仿真的外部业务系统、入口与认证画像。目标账号在系统详情中维护。'
          actions={
            <Can permission='target:write'>
              <Button onClick={() => setCreateOpen(true)}>
                新建目标系统 <Plus size={18} />
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState
            title='无法加载目标系统'
            onRetry={() => {
              void query.refetch()
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有目标系统'
            description='先登记一套要仿真的外部系统，再为它添加目标账号。'
            action={
              <Can permission='target:write'>
                <Button onClick={() => setCreateOpen(true)}>
                  新建目标系统 <Plus size={18} />
                </Button>
              </Can>
            }
          />
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>编码</TableHead>
                  <TableHead>入口</TableHead>
                  <TableHead>认证</TableHead>
                  <TableHead>验证码</TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className='w-20' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        to='/targets/$targetId'
                        params={{ targetId: item.id }}
                        className='font-medium text-primary hover:underline'
                      >
                        {item.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <code className='text-label'>{item.code}</code>
                    </TableCell>
                    <TableCell className='max-w-56 truncate text-label' title={item.entryUrl}>
                      {item.entryUrl}
                    </TableCell>
                    <TableCell>{AUTH_METHOD_LABELS[item.authMethod]}</TableCell>
                    <TableCell>
                      <StatusBadge tone={item.captchaMode === 'none' ? 'neutral' : 'warning'}>
                        {CAPTCHA_MODE_LABELS[item.captchaMode]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{item.accountCount}</TableCell>
                    <TableCell>
                      <StatusBadge tone={item.status === 'active' ? 'success' : 'neutral'}>
                        {TARGET_STATUS_LABELS[item.status]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className='whitespace-nowrap text-label'>
                      {new Date(item.updatedAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Can permission='target:delete'>
                        <Button
                          variant='ghost'
                          size='sm'
                          className='text-destructive'
                          onClick={() => setRemoving(item)}
                        >
                          删除
                        </Button>
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Main>
      <TargetFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(target) => {
          void navigate({ to: '/targets/$targetId', params: { targetId: target.id } })
        }}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        title='删除目标系统'
        desc={
          removing
            ? `确定删除「${removing.name}」（${removing.code}）吗？其下仍有目标账号时无法删除。`
            : ''
        }
        confirmText='删除'
        destructive
        isLoading={saving}
        handleConfirm={() => {
          if (!removing) return
          setSaving(true)
          void deleteTarget(removing.id)
            .then(async () => {
              toast.success('已删除')
              setRemoving(null)
              await queryClient.invalidateQueries({ queryKey: ['targets'] })
            })
            .catch((error) => {
              toast.error(error instanceof ApiRequestError ? error.message : '删除失败')
            })
            .finally(() => setSaving(false))
        }}
      />
    </>
  )
}
