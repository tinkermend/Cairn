import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import type { TargetAccountDto } from '@cairn/shared'
import {
  ArrowLeft,
  Compass,
  ExternalLink as ExternalLinkIcon,
  Layers,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  deleteTarget,
  deleteTargetAccount,
  fetchTarget,
  fetchTargetAccounts,
  fetchTargetCleanup,
  previewDeleteTarget,
  retryTargetCleanup,
} from '@/lib/targets-api'
import { CleanupStatusIndicator } from '@/components/cleanup-status-indicator'
import { useCan } from '@/hooks/use-permissions'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { AccessPolicyCard } from './access-policy-card'
import { AuthProfileCard } from './auth-profile-card'
import { SessionPolicyCard } from './session-policy-card'
import { AccountFormDialog } from './account-form-dialog'
import { TargetFormDialog } from './target-form-dialog'
import { SystemInfoCard } from './system-info-card'
import { TargetOverviewMetrics } from './target-overview-metrics'
import { TargetScenariosTab } from './target-scenarios-tab'
import {
  AUTH_CAPABILITY_LABELS,
  CAPTCHA_MODE_LABELS,
  TARGET_STATUS_LABELS,
} from './labels'

const route = getRouteApi('/_authenticated/targets/$targetId/')

export function TargetDetailPage() {
  const { targetId } = route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const page = useCursorPage()
  const [activeTab, setActiveTab] = useState('accounts')
  const [accountSearch, setAccountSearch] = useState('')
  const [accountStatus, setAccountStatus] = useState<'all' | 'active' | 'disabled'>('all')

  const accountFilters = useMemo(
    () => ({
      search: accountSearch.trim() || undefined,
      status: accountStatus === 'all' ? undefined : accountStatus,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [accountSearch, accountStatus, page.pageSize, page.cursor],
  )

  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
  })

  const canDeleteTarget = useCan('target:delete')
  const cleanupQuery = useQuery({
    queryKey: ['targets', targetId, 'cleanup'],
    queryFn: () => fetchTargetCleanup(targetId),
    enabled: targetQuery.isError,
  })

  const deletedView = targetQuery.isError && !targetQuery.data && cleanupQuery.isSuccess
  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts', accountFilters],
    queryFn: () => fetchTargetAccounts(targetId, accountFilters),
    placeholderData: keepPreviousData,
  })

  const [editOpen, setEditOpen] = useState(false)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<TargetAccountDto | undefined>()
  const [removingTarget, setRemovingTarget] = useState(false)
  const [removingAccount, setRemovingAccount] = useState<TargetAccountDto | null>(null)
  const [saving, setSaving] = useState(false)

  const target = targetQuery.data
  const accounts = accountsQuery.data?.items ?? []
  const accountsFiltered = Boolean(accountSearch.trim() || accountStatus !== 'all')

  const handleAccountSearchChange = (value: string) => {
    setAccountSearch(value)
    page.reset()
  }

  const handleAccountStatusChange = (value: 'all' | 'active' | 'disabled') => {
    setAccountStatus(value)
    page.reset()
  }

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          parent={
            <Link
              to='/targets'
              className='inline-flex items-center gap-1.5 hover:text-link'
            >
              <ArrowLeft className='size-4' />
              返回目标系统
            </Link>
          }
          title={target?.name ?? '目标系统'}
          description={
            <span className='flex flex-wrap items-center gap-2 text-small text-muted-foreground'>
              <Link to='/targets' className='text-primary hover:underline'>
                目标系统
              </Link>
              {target ? (
                <>
                  <span>/</span>
                  <code className='font-mono text-label text-text-primary'>{target.code}</code>
                  <span>·</span>
                  <StatusBadge tone={target.status === 'active' ? 'success' : 'neutral'}>
                    {TARGET_STATUS_LABELS[target.status]}
                  </StatusBadge>
                  <span>·</span>
                  <StatusBadge tone='info'>
                    {AUTH_CAPABILITY_LABELS[target.currentAuthProfileRevision ? 'LOGIN_VERIFIED' : 'LEGACY']}
                  </StatusBadge>
                  <span>·</span>
                  <a
                    href={target.entryUrl}
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-1 text-link hover:underline'
                  >
                    <span>入口 URL</span>
                    <ExternalLinkIcon className='size-3 shrink-0' />
                  </a>
                </>
              ) : null}
            </span>
          }
          actions={
            target && !targetQuery.isError ? (
              <div className='flex flex-wrap items-center gap-2'>
                <Can permission='map:read'>
                  <Button variant='outline' asChild>
                    <Link to='/targets/$targetId/map' params={{ targetId }}>
                      <Compass />
                      知识
                    </Link>
                  </Button>
                </Can>
                <Can permission='target:write'>
                  <Button variant='outline' onClick={() => setEditOpen(true)}>
                    编辑系统
                  </Button>
                </Can>
                <Can allOf={['target:delete', 'run:delete']}>
                  <Button
                    variant='ghost'
                    className='text-destructive'
                    onClick={() => setRemovingTarget(true)}
                  >
                    删除
                  </Button>
                </Can>
              </div>
            ) : null
          }
        />

        {targetQuery.isPending ? (
          <PageSkeleton />
        ) : deletedView && cleanupQuery.data ? (
          <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-body'>目标系统已删除。业务记录不可访问，附件按清理状态处理。</p>
            <div className='mt-3'>
              <CleanupStatusIndicator
                status={cleanupQuery.data}
                onRetry={canDeleteTarget ? () => retryTargetCleanup(targetId) : undefined}
                onStatusUpdated={() => void cleanupQuery.refetch()}
              />
            </div>
          </section>
        ) : targetQuery.isError || !target ? (
          <QueryErrorState
            title='无法加载目标系统'
            onRetry={() => {
              void targetQuery.refetch()
            }}
          />
        ) : (
          <>
            {target.status === 'disabled' ? (
              <Alert variant='warning'>
                <AlertDescription>
                  该系统已停用，不能用于新建场景或发起运行。
                </AlertDescription>
              </Alert>
            ) : null}
            {target.captchaMode !== 'none' ? (
              <Alert variant='warning'>
                <AlertDescription>
                  该系统使用{CAPTCHA_MODE_LABELS[target.captchaMode]}
                  ，执行前请确认目标账号的登录状态。
                </AlertDescription>
              </Alert>
            ) : null}

            {/* 指标统计栏 */}
            <TargetOverviewMetrics
              target={target}
              onSelectTab={(tab) => setActiveTab(tab)}
            />

            {/* 工作台主体 Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className='w-full space-y-4'>
              <TabsList className='border-b border-border bg-transparent p-0'>
                <TabsTrigger value='accounts'>
                  <Users className='size-4' />
                  目标账号 ({target.accountCount})
                </TabsTrigger>
                <TabsTrigger value='scenarios'>
                  <Layers className='size-4' />
                  关联场景
                </TabsTrigger>
                <TabsTrigger value='auth-profile'>
                  <ShieldCheck className='size-4' />
                  登录核验规则
                </TabsTrigger>
                <TabsTrigger value='access-policy'>
                  <Shield className='size-4' />
                  目标授权
                </TabsTrigger>
              </TabsList>

              {/* Tab 1: 目标账号 */}
              <TabsContent value='accounts' className='space-y-4'>
                <section
                  aria-label='目标账号'
                  className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
                >
                  <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                    <div className='flex flex-wrap gap-1' aria-label='账号状态筛选'>
                      {(
                        [
                          ['all', '全部账号'],
                          ['active', '已启用'],
                          ['disabled', '已停用'],
                        ] as const
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          variant={accountStatus === value ? 'secondary' : 'ghost'}
                          size='sm'
                          aria-pressed={accountStatus === value}
                          onClick={() => handleAccountStatusChange(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <div className='flex flex-wrap items-center gap-3'>
                      <div className='relative w-full sm:w-64'>
                        <Search
                          aria-hidden='true'
                          className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                        />
                        <Input
                          aria-label='搜索目标账号'
                          placeholder='搜索登录名或显示名'
                          value={accountSearch}
                          onChange={(event) => handleAccountSearchChange(event.target.value)}
                          className='pl-9'
                        />
                      </div>
                      <Can permission='target:write'>
                        <Button onClick={() => setAddAccountOpen(true)}>
                          <Plus />
                          添加目标账号
                        </Button>
                      </Can>
                    </div>
                  </div>

                  {accountsQuery.isPending ? (
                    <PageSkeleton />
                  ) : accountsQuery.isError ? (
                    <QueryErrorState
                      title='无法加载目标账号'
                      onRetry={() => {
                        void accountsQuery.refetch()
                      }}
                    />
                  ) : accounts.length === 0 ? (
                    <EmptyState
                      title={accountsFiltered ? '没有匹配的目标账号' : '该系统还没有目标账号'}
                      description={
                        accountsFiltered
                          ? '试试其他关键词，或清除筛选条件。'
                          : '添加登录该外部系统所用的账号。密码只写不读。'
                      }
                      action={
                        accountsFiltered ? (
                          <Button
                            variant='outline'
                            onClick={() => {
                              setAccountSearch('')
                              setAccountStatus('all')
                              page.reset()
                            }}
                          >
                            清除筛选
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className='overflow-hidden'>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>显示名</TableHead>
                            <TableHead>登录名</TableHead>
                            <TableHead>凭据</TableHead>
                            <TableHead>核验等级</TableHead>
                            <TableHead>期望身份</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead className='w-36 text-right'>操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {accounts.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell className='py-4 font-medium text-text-primary'>
                                <span
                                  className='block max-w-64 truncate'
                                  title={item.displayName}
                                >
                                  {item.displayName}
                                </span>
                              </TableCell>
                              <TableCell>
                                <code
                                  className='block max-w-48 truncate font-mono text-label text-text-secondary'
                                  title={item.username}
                                >
                                  {item.username}
                                </code>
                              </TableCell>
                              <TableCell>
                                <StatusBadge
                                  tone={item.hasPassword ? 'success' : 'neutral'}
                                >
                                  {item.hasPassword ? '已保存' : '未设置'}
                                </StatusBadge>
                              </TableCell>
                              <TableCell>
                                <StatusBadge
                                  tone={
                                    item.authCapability === 'IDENTITY_VERIFIED'
                                      ? 'info'
                                      : item.authCapability === 'LOGIN_VERIFIED'
                                        ? 'neutral'
                                        : 'neutral'
                                  }
                                >
                                  {AUTH_CAPABILITY_LABELS[item.authCapability ?? 'LEGACY']}
                                </StatusBadge>
                                {item.autoLoginPausedReason ? (
                                  <p className='mt-1 text-label text-muted-foreground'>
                                    自动登录暂停：{item.autoLoginPausedReason}
                                  </p>
                                ) : null}
                              </TableCell>
                              <TableCell className='text-label text-muted-foreground'>
                                {item.expectedIdentity ?? '未设置'}
                              </TableCell>
                              <TableCell>
                                <StatusBadge
                                  tone={
                                    item.status === 'active'
                                      ? 'success'
                                      : 'warning'
                                  }
                                >
                                  {TARGET_STATUS_LABELS[item.status]}
                                </StatusBadge>
                              </TableCell>
                              <TableCell className='text-right'>
                                <div className='flex items-center justify-end gap-1'>
                                  <Can permission='session:read'>
                                    <Button variant='ghost' size='sm' asChild>
                                      <Link
                                        to='/sessions/$targetId/$accountId'
                                        params={{
                                          targetId,
                                          accountId: item.id,
                                        }}
                                      >
                                        管理会话
                                      </Link>
                                    </Button>
                                  </Can>
                                  <Can permission='target:write'>
                                    <Button
                                      variant='ghost'
                                      size='sm'
                                      onClick={() => setEditingAccount(item)}
                                    >
                                      编辑
                                    </Button>
                                  </Can>
                                  <Can permission='target:delete'>
                                    <Button
                                      variant='ghost'
                                      size='sm'
                                      className='text-destructive'
                                      onClick={() => setRemovingAccount(item)}
                                    >
                                      删除
                                    </Button>
                                  </Can>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
                        <p role='status' className='text-label text-muted-foreground'>
                          本页 {accounts.length} 条
                        </p>
                        <CursorPagination
                          pageIndex={page.pageIndex}
                          pageSize={page.pageSize}
                          hasPreviousPage={page.pageIndex > 0}
                          hasNextPage={Boolean(accountsQuery.data?.nextCursor)}
                          updating={accountsQuery.isFetching && accountsQuery.isPlaceholderData}
                          onPageSizeChange={page.setPageSize}
                          onPreviousPage={page.goPrev}
                          onNextPage={() => {
                            if (accountsQuery.data?.nextCursor) page.goNext(accountsQuery.data.nextCursor)
                          }}
                        />
                      </div>
                    </div>
                  )}
                </section>
              </TabsContent>

              {/* Tab 2: 关联场景 */}
              <TabsContent value='scenarios'>
                <TargetScenariosTab targetId={targetId} targetName={target.name} />
              </TabsContent>

              {/* Tab 3: 登录核验规则与系统资料 */}
              <TabsContent value='auth-profile'>
                <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]'>
                  <div className='space-y-5'>
                    <AuthProfileCard target={target} />
                    <SessionPolicyCard target={target} />
                  </div>
                  <SystemInfoCard
                    target={target}
                    onEdit={() => setEditOpen(true)}
                    onDelete={() => setRemovingTarget(true)}
                  />
                </div>
              </TabsContent>

              {/* Tab 4: 目标安全授权 */}
              <TabsContent value='access-policy'>
                <AccessPolicyCard targetId={targetId} />
              </TabsContent>
            </Tabs>

            {/* 对话框与表单弹窗 */}
            <TargetFormDialog
              open={editOpen}
              onOpenChange={setEditOpen}
              current={target}
            />
            <AccountFormDialog
              open={addAccountOpen || !!editingAccount}
              onOpenChange={(next) => {
                if (!next) {
                  setAddAccountOpen(false)
                  setEditingAccount(undefined)
                }
              }}
              targetId={targetId}
              current={editingAccount}
            />
          </>
        )}
      </Main>

      <ResourceDeleteDialog
        open={removingTarget}
        onOpenChange={setRemovingTarget}
        resourceId={targetId}
        resourceName={target ? `${target.name}（${target.code}）` : ''}
        resourceType='target'
        previewFn={() => previewDeleteTarget(targetId)}
        deleteFn={(body) => deleteTarget(targetId, body)}
        onSuccess={async (result) => {
          await queryClient.invalidateQueries({ queryKey: ['targets'] })
          await queryClient.invalidateQueries({ queryKey: ['target', targetId] })
          if (result && typeof result === 'object' && 'totalObjects' in result && result.totalObjects > 0) {
            await queryClient.invalidateQueries({ queryKey: ['targets', targetId, 'cleanup'] })
            return
          }
          await navigate({ to: '/targets' })
        }}
      />

      <ConfirmDialog
        open={!!removingAccount}
        onOpenChange={(next) => {
          if (!next) setRemovingAccount(null)
        }}
        title='删除目标账号'
        desc={
          removingAccount
            ? `确定删除「${removingAccount.displayName}」（${removingAccount.username}）及其已保存凭据吗？`
            : ''
        }
        confirmText='删除'
        destructive
        isLoading={saving}
        handleConfirm={() => {
          if (!removingAccount) return
          setSaving(true)
          void deleteTargetAccount(targetId, removingAccount.id)
            .then(async () => {
              toast.success('已删除')
              setRemovingAccount(null)
              if (accounts.length <= 1 && page.pageIndex > 0) page.goPrev()
              await queryClient.invalidateQueries({
                queryKey: ['target', targetId],
              })
              await queryClient.invalidateQueries({
                queryKey: ['target', targetId, 'accounts'],
              })
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
