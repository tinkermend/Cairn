import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router'
import type { TargetAccountDto } from '@cairn/shared'
import { ArrowLeft, Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  deleteTarget,
  deleteTargetAccount,
  fetchTarget,
  fetchTargetAccounts,
} from '@/lib/targets-api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { AccountFormDialog } from './account-form-dialog'
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
  LOGIN_FIELD_ROLE_LABELS,
  TARGET_STATUS_LABELS,
  formatLoginFieldState,
} from './labels'
import { TargetFormDialog } from './target-form-dialog'

const route = getRouteApi('/_authenticated/targets/$targetId/')

export function TargetDetailPage() {
  const { targetId } = route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
  })
  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts'],
    queryFn: () => fetchTargetAccounts(targetId),
  })
  const [editOpen, setEditOpen] = useState(false)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<
    TargetAccountDto | undefined
  >()
  const [removingTarget, setRemovingTarget] = useState(false)
  const [removingAccount, setRemovingAccount] =
    useState<TargetAccountDto | null>(null)
  const [saving, setSaving] = useState(false)

  const target = targetQuery.data
  const accounts = accountsQuery.data?.items ?? []

  return (
    <>
      <AppHeader
        fixed
        leading={
          <Link
            to='/targets'
            className='me-auto flex items-center gap-2 text-small text-muted-foreground hover:text-link'
          >
            <ArrowLeft className='size-4' />
            返回目标系统
          </Link>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title={target?.name ?? '目标系统'}
          description={
            <span>
              <Link to='/targets' className='text-primary hover:underline'>
                目标系统
              </Link>
              {target ? ` / ${target.code}` : ''}
            </span>
          }
          actions={
            target && !targetQuery.isError ? (
              <Can permission='target:write'>
                <Button onClick={() => setAddAccountOpen(true)}>
                  <Plus />
                  添加目标账号
                </Button>
              </Can>
            ) : null
          }
        />
        {targetQuery.isPending ? (
          <PageSkeleton />
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
            <div className='grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]'>
              <Card className='order-2 min-w-0'>
                <CardHeader className='flex flex-row items-start justify-between gap-3'>
                  <CardTitle>系统资料</CardTitle>
                  <div className='flex gap-2'>
                    <Can permission='target:write'>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setEditOpen(true)}
                      >
                        编辑
                      </Button>
                    </Can>
                    <Can permission='target:delete'>
                      <Button
                        variant='ghost'
                        size='sm'
                        className='text-destructive'
                        onClick={() => setRemovingTarget(true)}
                      >
                        删除
                      </Button>
                    </Can>
                  </div>
                </CardHeader>
                <CardContent className='grid gap-4 text-body sm:grid-cols-2 xl:grid-cols-1'>
                  <Field label='编码' value={target.code} mono />
                  <Field
                    label='状态'
                    value={
                      <StatusBadge
                        tone={
                          target.status === 'active' ? 'success' : 'neutral'
                        }
                      >
                        {TARGET_STATUS_LABELS[target.status]}
                      </StatusBadge>
                    }
                  />
                  <Field
                    label='入口 URL'
                    value={<ExternalLink href={target.entryUrl} />}
                  />
                  <Field
                    label='登录 URL'
                    value={
                      target.loginUrl ? (
                        <ExternalLink href={target.loginUrl} />
                      ) : (
                        '与入口相同'
                      )
                    }
                  />
                  <Field
                    label='认证方式'
                    value={AUTH_METHOD_LABELS[target.authMethod]}
                  />
                  <Field
                    label='验证码'
                    value={CAPTCHA_MODE_LABELS[target.captchaMode]}
                  />
                  <Field
                    label='目标账号数'
                    value={String(target.accountCount)}
                  />
                  <Field
                    label='更新时间'
                    value={new Date(target.updatedAt).toLocaleString('zh-CN', {
                      hour12: false,
                    })}
                  />
                  <details className='space-y-3 border-t border-border-divider pt-3 sm:col-span-2 xl:col-span-1'>
                    <summary className='cursor-pointer text-small font-medium focus-visible:outline-2 focus-visible:outline-ring'>
                      登录框定位
                    </summary>
                    <div className='grid gap-3'>
                      <Field
                        label={LOGIN_FIELD_ROLE_LABELS.username}
                        value={formatLoginFieldState(
                          target.authMethod,
                          target.loginFields?.username
                        )}
                      />
                      <Field
                        label={LOGIN_FIELD_ROLE_LABELS.password}
                        value={formatLoginFieldState(
                          target.authMethod,
                          target.loginFields?.password
                        )}
                      />
                      <Field
                        label={LOGIN_FIELD_ROLE_LABELS.submit}
                        value={formatLoginFieldState(
                          target.authMethod,
                          target.loginFields?.submit
                        )}
                      />
                    </div>
                  </details>
                </CardContent>
              </Card>
              <section
                aria-label='目标账号'
                className='order-1 min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='space-y-1 border-b border-border-divider px-5 py-4'>
                  <h2 className='flex items-center gap-2 text-section font-semibold'>
                    <Users className='size-4 text-primary' />
                    目标账号
                    <span className='ml-auto text-small font-normal text-muted-foreground'>
                      {accountsQuery.isSuccess
                        ? `${accounts.length} 个账号`
                        : ''}
                    </span>
                  </h2>
                  <p className='text-small text-muted-foreground'>
                    用于登录「{target.name}
                    」。凭据只写不读，与控制台成员分别管理。
                  </p>
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
                    title='该系统还没有目标账号'
                    description='添加登录该外部系统所用的账号。密码只写不读。'
                  />
                ) : (
                  <div className='overflow-hidden'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>显示名</TableHead>
                          <TableHead>登录名</TableHead>
                          <TableHead>凭据</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead className='w-28' />
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
                                className='block max-w-48 truncate text-label'
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
                                  item.status === 'active'
                                    ? 'success'
                                    : 'warning'
                                }
                              >
                                {TARGET_STATUS_LABELS[item.status]}
                              </StatusBadge>
                            </TableCell>
                            <TableCell>
                              <div className='flex justify-end gap-1'>
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
                  </div>
                )}
              </section>
            </div>
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
      <ConfirmDialog
        open={removingTarget}
        onOpenChange={setRemovingTarget}
        title='删除目标系统'
        desc={
          target
            ? `确定删除「${target.name}」吗？其下仍有目标账号时无法删除。`
            : ''
        }
        confirmText='删除'
        destructive
        isLoading={saving}
        handleConfirm={() => {
          setSaving(true)
          void deleteTarget(targetId)
            .then(async () => {
              toast.success('已删除')
              await queryClient.invalidateQueries({ queryKey: ['targets'] })
              await navigate({ to: '/targets' })
            })
            .catch((error) => {
              toast.error(
                error instanceof ApiRequestError ? error.message : '删除失败'
              )
            })
            .finally(() => setSaving(false))
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

function ExternalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noopener noreferrer'
      className='break-all text-primary hover:underline'
    >
      {href}
    </a>
  )
}

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <div>
      <div className='text-label text-muted-foreground'>{label}</div>
      <div
        className={
          mono
            ? 'mt-1 font-mono text-label break-all'
            : 'mt-1 text-body break-words'
        }
      >
        {value}
      </div>
    </div>
  )
}
