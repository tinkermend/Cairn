import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import type { TargetDto } from '@cairn/shared'
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Globe2,
  Plus,
  Search,
  ShieldAlert,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { deleteTarget, fetchTargets } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
  TARGET_STATUS_LABELS,
} from './labels'
import { TargetFormDialog } from './target-form-dialog'

export function TargetsPage() {
  const query = useQuery({ queryKey: ['targets'], queryFn: fetchTargets })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [removing, setRemoving] = useState<TargetDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const items = query.data?.items ?? []
  const keyword = search.trim().toLocaleLowerCase()
  const filtered = items.filter(
    (item) =>
      (status === 'all' || item.status === status) &&
      [item.name, item.code, item.entryUrl].some((value) =>
        value.toLocaleLowerCase().includes(keyword)
      )
  )
  const selected =
    filtered.find((item) => item.id === selectedId) ?? filtered[0]

  return (
    <>
      <AppHeader
        fixed
        leading={
          <span className='me-auto text-small text-muted-foreground'>
            资源管理 <span className='mx-2'>/</span> 目标系统
          </span>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='目标系统'
          description='连接真实业务系统，为场景准备入口、认证方式与目标账号。'
          actions={
            <Can permission='target:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建目标系统
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState
            title='无法加载目标系统'
            onRetry={() => void query.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有目标系统'
            description='登记第一个业务系统，然后添加用于执行场景的目标账号。'
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '已登记系统',
                  value: items.length,
                  description: '统一管理系统入口',
                  icon: <Globe2 className='size-4' />,
                },
                {
                  label: '已启用',
                  value: items.filter((item) => item.status === 'active')
                    .length,
                  description: '已启用的系统配置',
                  icon: (
                    <CheckCircle2 className='size-4 text-status-success-foreground' />
                  ),
                },
                {
                  label: '目标账号',
                  value: items.reduce(
                    (sum, item) => sum + item.accountCount,
                    0
                  ),
                  description: '登录外部系统的身份',
                  icon: <Users className='size-4' />,
                },
                {
                  label: '存在验证码',
                  value: items.filter((item) => item.captchaMode !== 'none')
                    .length,
                  description: '执行前需关注认证方式',
                  icon: (
                    <ShieldAlert className='size-4 text-status-warning-foreground' />
                  ),
                },
              ]}
            />
            <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]'>
              <section
                aria-label='目标系统列表'
                className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                  <div
                    className='flex flex-wrap gap-1'
                    aria-label='系统状态筛选'
                  >
                    {(
                      [
                        ['all', '全部系统'],
                        ['active', '已启用'],
                        ['disabled', '已停用'],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        variant={status === value ? 'secondary' : 'ghost'}
                        size='sm'
                        aria-pressed={status === value}
                        onClick={() => setStatus(value)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className='relative w-full sm:w-64'>
                    <Search
                      aria-hidden='true'
                      className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                    />
                    <Input
                      aria-label='搜索目标系统'
                      placeholder='搜索名称、编码或入口'
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className='pl-9'
                    />
                  </div>
                </div>
                {filtered.length === 0 ? (
                  <EmptyState
                    title='没有匹配的目标系统'
                    description='试试其他关键词，或清除筛选条件。'
                    action={
                      <Button
                        variant='outline'
                        onClick={() => {
                          setSearch('')
                          setStatus('all')
                        }}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>系统 / 入口</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>认证</TableHead>
                        <TableHead>账号</TableHead>
                        <TableHead>
                          <span className='sr-only'>概览</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((item) => (
                        <TableRow
                          key={item.id}
                          className='cursor-pointer'
                          onClick={() => setSelectedId(item.id)}
                          data-state={
                            selected?.id === item.id ? 'selected' : undefined
                          }
                        >
                          <TableCell className='py-4'>
                            <div className='flex items-center gap-3'>
                              <span
                                aria-hidden='true'
                                className='flex size-10 shrink-0 items-center justify-center rounded-md border border-border-default bg-card text-primary'
                              >
                                <Globe2 className='size-5' />
                              </span>
                              <div className='min-w-0'>
                                <button
                                  type='button'
                                  aria-pressed={selected?.id === item.id}
                                  aria-controls='target-overview'
                                  className='block max-w-64 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                  title={item.name}
                                >
                                  {item.name}
                                </button>
                                <p
                                  className='mt-1 max-w-64 truncate text-label text-muted-foreground'
                                  title={item.entryUrl}
                                >
                                  {item.entryUrl}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              tone={
                                item.status === 'active' ? 'success' : 'neutral'
                              }
                            >
                              {TARGET_STATUS_LABELS[item.status]}
                            </StatusBadge>
                          </TableCell>
                          <TableCell>
                            {AUTH_METHOD_LABELS[item.authMethod]}
                          </TableCell>
                          <TableCell className='tabular-nums'>
                            {item.accountCount}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant='ghost'
                              size='icon'
                              aria-label={`查看${item.name}概览`}
                              aria-pressed={selected?.id === item.id}
                              aria-controls='target-overview'
                              onClick={() => setSelectedId(item.id)}
                            >
                              <ChevronRight />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p
                  role='status'
                  className='border-t border-border-divider px-4 py-3 text-label text-muted-foreground'
                >
                  显示 {filtered.length} / {items.length} 个系统
                </p>
              </section>
              {selected ? (
                <aside
                  id='target-overview'
                  aria-label='系统概览'
                  className='min-w-0 rounded-lg border border-border-card bg-card shadow-card'
                >
                  <div className='space-y-4 border-b border-border-divider p-5'>
                    <p className='text-label text-muted-foreground'>当前系统</p>
                    <div className='flex items-start gap-3'>
                      <span
                        aria-hidden='true'
                        className='flex size-11 shrink-0 items-center justify-center rounded-lg bg-selection-background text-primary'
                      >
                        <Globe2 className='size-5' />
                      </span>
                      <div className='min-w-0'>
                        <h2 className='text-section font-semibold break-words'>
                          {selected.name}
                        </h2>
                        <p className='mt-1 font-mono text-label break-all text-muted-foreground'>
                          {selected.code}
                        </p>
                      </div>
                    </div>
                    <StatusBadge
                      tone={
                        selected.status === 'active' ? 'success' : 'neutral'
                      }
                    >
                      {TARGET_STATUS_LABELS[selected.status]}
                    </StatusBadge>
                  </div>
                  <dl className='space-y-4 p-5 text-small'>
                    <div>
                      <dt className='text-label text-muted-foreground'>
                        系统入口
                      </dt>
                      <dd className='mt-1 break-all'>{selected.entryUrl}</dd>
                    </div>
                    <div className='flex justify-between gap-3'>
                      <dt className='text-muted-foreground'>认证方式</dt>
                      <dd>{AUTH_METHOD_LABELS[selected.authMethod]}</dd>
                    </div>
                    <div className='flex justify-between gap-3'>
                      <dt className='text-muted-foreground'>验证码</dt>
                      <dd>
                        <StatusBadge
                          tone={
                            selected.captchaMode === 'none'
                              ? 'neutral'
                              : 'warning'
                          }
                        >
                          {CAPTCHA_MODE_LABELS[selected.captchaMode]}
                        </StatusBadge>
                      </dd>
                    </div>
                    <div className='flex justify-between gap-3'>
                      <dt className='text-muted-foreground'>目标账号</dt>
                      <dd className='font-medium'>
                        {selected.accountCount} 个
                      </dd>
                    </div>
                    <div>
                      <dt className='text-label text-muted-foreground'>
                        最近更新
                      </dt>
                      <dd className='mt-1'>
                        {new Date(selected.updatedAt).toLocaleString('zh-CN', {
                          hour12: false,
                        })}
                      </dd>
                    </div>
                  </dl>
                  <div className='flex flex-wrap items-center justify-between gap-2 border-t border-border-divider p-4'>
                    <Button variant='outline' asChild>
                      <Link
                        to='/targets/$targetId'
                        params={{ targetId: selected.id }}
                      >
                        管理系统与账号
                        <ArrowUpRight />
                      </Link>
                    </Button>
                    <Can permission='target:delete'>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='text-destructive'
                        onClick={() => setRemoving(selected)}
                      >
                        删除
                      </Button>
                    </Can>
                  </div>
                </aside>
              ) : null}
            </div>
          </>
        )}
      </Main>
      <TargetFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(target) => {
          void navigate({
            to: '/targets/$targetId',
            params: { targetId: target.id },
          })
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
              toast.error(
                error instanceof ApiRequestError ? error.message : '删除失败'
              )
            })
            .finally(() => setSaving(false))
        }}
      />
    </>
  )
}
