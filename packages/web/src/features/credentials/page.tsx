import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { CredentialListItem, CredentialShortcut } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { fetchCredentials } from '@/lib/credentials-api'
import { can } from '@/lib/rbac'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { CredentialActions } from './actions'
import { BatchDialog } from './batch-dialog'
import { CredentialEditor, type CredentialAction } from './editor'
import { MAINTENANCE_LABELS, credentialSessionLabel } from './labels'
import { CredentialRegistration } from './registration'
import { CredentialTargetFilter } from './target-filter'

export function CredentialsPage() {
  const page = useCursorPage()
  const user = useAuthStore((s) => s.auth.user)
  const [search, setSearch] = useState('')
  const [targetId, setTargetId] = useState<string | undefined>()
  const [shortcut, setShortcut] = useState<CredentialShortcut | 'all'>('all')
  const [selected, setSelected] = useState<Record<string, CredentialListItem>>(
    {}
  )
  const [batch, setBatch] = useState<'selection' | 'excel' | null>(null)
  const [register, setRegister] = useState(false)
  const [editing, setEditing] = useState<{
    item: CredentialListItem
    action: CredentialAction
  } | null>(null)
  const queryInput = {
    cursor: page.cursor,
    limit: page.pageSize,
    search: search.trim() || undefined,
    targetId,
    shortcut: shortcut === 'all' ? undefined : shortcut,
  }
  const query = useQuery({
    queryKey: ['credentials', queryInput],
    queryFn: () => fetchCredentials(queryInput),
    placeholderData: keepPreviousData,
  })
  const items = query.data?.items ?? []
  const stats = query.data?.stats
  const writable = items.filter((i) => i.capabilities.canReplace)
  const checked = writable.length > 0 && writable.every((i) => selected[i.id])
  const choose = (item: CredentialListItem, on: boolean) =>
    setSelected((old) => {
      const next = { ...old }
      if (on) next[item.id] = item
      else delete next[item.id]
      return next
    })
  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-5'>
      <PageHeader
        title='凭据管理'
        description='集中维护目标系统的账号密码、有效期和登录状态，与目标系统页面使用同一份账号数据。'
        actions={
          <div className='flex flex-wrap gap-2'>
            {can(user, 'credential:write') && (
              <Button variant='outline' onClick={() => setRegister(true)}>
                添加凭据
              </Button>
            )}
            {can(user, 'credential:import') &&
              can(user, 'credential:write') && (
                <Button onClick={() => setBatch('excel')}>
                  Excel 批量更新
                </Button>
              )}
          </div>
        }
      />
      {query.isError ? (
        <QueryErrorState
          title='无法加载账号凭据'
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <div className='flex flex-wrap gap-2' aria-label='凭据概览'>
            {(
              [
                { id: 'all', label: '账号总数', count: stats?.visible },
                {
                  id: 'approaching',
                  label: '即将到期',
                  count: stats?.approaching,
                },
                { id: 'due', label: '已到期', count: stats?.due },
                { id: 'unknown', label: '未设置有效期', count: stats?.unknown },
                {
                  id: 'auth_abnormal',
                  label: '登录异常',
                  count: stats?.authAbnormal,
                },
              ] as const
            ).map((s) => (
              <Button
                key={s.id}
                variant={shortcut === s.id ? 'secondary' : 'outline'}
                aria-pressed={shortcut === s.id}
                onClick={() => {
                  setShortcut(s.id)
                  page.reset()
                }}
              >
                {s.label}
                <span className='ml-2 font-semibold tabular-nums'>
                  {s.count ?? '—'}
                </span>
              </Button>
            ))}
          </div>
          <section
            aria-label='凭据列表'
            className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
          >
            <div className='flex flex-wrap items-center gap-3 border-b border-border-divider p-4'>
              <Input
                aria-label='搜索账号凭据'
                placeholder='搜索目标系统、账号名称或登录名'
                className='w-full sm:max-w-sm'
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  page.reset()
                }}
              />
              <CredentialTargetFilter
                onChange={(id) => {
                  setTargetId(id)
                  page.reset()
                }}
              />
              <Select
                value={shortcut}
                onValueChange={(v) => {
                  setShortcut(v as CredentialShortcut | 'all')
                  page.reset()
                }}
              >
                <SelectTrigger className='w-44' aria-label='筛选凭据状态'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>全部状态</SelectItem>
                  <SelectItem value='due'>已到期</SelectItem>
                  <SelectItem value='approaching'>即将到期</SelectItem>
                  <SelectItem value='not_due'>未到期</SelectItem>
                  <SelectItem value='permanent'>永久</SelectItem>
                  <SelectItem value='unknown'>未设置有效期</SelectItem>
                  <SelectItem value='auth_abnormal'>登录异常</SelectItem>
                  <SelectItem value='unclaimed'>未指定负责人</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant='ghost'
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                刷新状态
              </Button>
            </div>
            {Object.keys(selected).length > 0 && (
              <div className='flex flex-wrap items-center gap-3 border-b border-border-divider bg-muted/40 px-4 py-3'>
                <span className='text-label'>
                  已选 {Object.keys(selected).length} 个账号（含其他页）
                </span>
                <Button size='sm' onClick={() => setBatch('selection')}>
                  批量维护所选账号
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => setSelected({})}
                >
                  清空选择
                </Button>
              </div>
            )}
            {query.isPending ? (
              <PageSkeleton />
            ) : items.length === 0 ? (
              <EmptyState
                title='没有符合条件的账号凭据'
                description='可调整筛选条件，或为已有目标账号添加凭据。这里只展示你有权查看的目标系统账号。'
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-12'>
                      <Checkbox
                        aria-label='选择当前页可维护账号'
                        checked={checked}
                        disabled={!writable.length}
                        onCheckedChange={(v) =>
                          setSelected((old) => {
                            const next = { ...old }
                            for (const i of writable) {
                              if (v === true) next[i.id] = i
                              else delete next[i.id]
                            }
                            return next
                          })
                        }
                      />
                    </TableHead>
                    <TableHead>目标系统</TableHead>
                    <TableHead>账号 / 登录名</TableHead>
                    <TableHead>密码</TableHead>
                    <TableHead>有效期</TableHead>
                    <TableHead>浏览器登录状态</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Checkbox
                          aria-label={`选择${item.name}`}
                          checked={!!selected[item.id]}
                          disabled={!item.capabilities.canReplace}
                          onCheckedChange={(v) => choose(item, v === true)}
                        />
                      </TableCell>
                      <TableCell className='min-w-36'>
                        <Link
                          to='/targets/$targetId'
                          params={{ targetId: item.targetId! }}
                          className='font-medium text-link'
                        >
                          {item.target?.name ?? item.subjectLabel}
                        </Link>
                        <p className='text-label text-muted-foreground'>
                          {item.target?.code}
                        </p>
                      </TableCell>
                      <TableCell className='min-w-36'>
                        <Link
                          to='/credentials/$credentialId'
                          params={{ credentialId: item.id }}
                          className='font-medium text-link'
                        >
                          {item.name}
                        </Link>
                        <p className='text-label text-muted-foreground'>
                          {item.safeIdentifier}
                        </p>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          tone={item.hasPassword ? 'neutral' : 'warning'}
                        >
                          {item.hasPassword ? '已保存' : '未保存'}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className='min-w-40'>
                        <StatusBadge
                          tone={
                            item.maintenanceStatus === 'due'
                              ? 'error'
                              : item.maintenanceStatus === 'approaching'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {MAINTENANCE_LABELS[item.maintenanceStatus]}
                        </StatusBadge>
                        {item.maintenanceDueAt && (
                          <p className='mt-1 text-label text-muted-foreground'>
                            {new Date(item.maintenanceDueAt).toLocaleDateString(
                              'zh-CN'
                            )}{' '}
                            到期
                          </p>
                        )}
                      </TableCell>
                      <TableCell className='min-w-48'>
                        <p className='text-label'>
                          {credentialSessionLabel(item.session)}
                        </p>
                        {item.session.lastAuthCheckedAt && (
                          <p className='mt-1 text-label text-muted-foreground'>
                            检查于{' '}
                            {new Date(
                              item.session.lastAuthCheckedAt
                            ).toLocaleString('zh-CN')}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className='min-w-56'>
                        <CredentialActions
                          item={item}
                          onAction={(action) => setEditing({ item, action })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className='border-t border-border-divider p-3'>
              <CursorPagination
                pageIndex={page.pageIndex}
                pageSize={page.pageSize}
                hasPreviousPage={page.pageIndex > 0}
                hasNextPage={!!query.data?.nextCursor}
                updating={query.isFetching}
                onPageSizeChange={page.setPageSize}
                onPreviousPage={page.goPrev}
                onNextPage={() => {
                  if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
                }}
              />
            </div>
          </section>
          <p className='text-label text-muted-foreground'>
            有效期用于提醒维护。浏览器在线与登录有效分别展示，尚未检查不代表登录失效。
          </p>
        </>
      )}
      {editing && (
        <CredentialEditor
          key={`${editing.item.id}-${editing.action}`}
          {...editing}
          onClose={(removed) => {
            if (removed) choose(editing.item, false)
            setEditing(null)
          }}
        />
      )}
      {batch && (
        <BatchDialog
          open
          onOpenChange={(v) => {
            if (!v) setBatch(null)
          }}
          items={Object.values(selected)}
          source={batch}
        />
      )}
      {register && (
        <CredentialRegistration onClose={() => setRegister(false)} />
      )}
    </Main>
  )
}
