import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  fetchCredential,
  fetchCredentialHistory,
  fetchCredentialUsages,
} from '@/lib/credentials-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CursorPagination } from '@/components/data-table'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { CredentialActions } from './actions'
import { CredentialEditor, type CredentialAction } from './editor'
import {
  MAINTENANCE_LABELS,
  credentialSessionLabel,
  USAGE_RESOURCE_LABELS,
} from './labels'

export function CredentialDetailPage({
  credentialId,
}: {
  credentialId: string
}) {
  const navigate = useNavigate()
  const page = useCursorPage()
  const [action, setAction] = useState<CredentialAction | null>(null)
  const detail = useQuery({
    queryKey: ['credentials', credentialId],
    queryFn: () => fetchCredential(credentialId),
  })
  const history = useQuery({
    queryKey: [
      'credentials',
      credentialId,
      'history',
      page.cursor,
      page.pageSize,
    ],
    queryFn: () =>
      fetchCredentialHistory(credentialId, {
        limit: page.pageSize,
        cursor: page.cursor,
      }),
  })
  const usages = useQuery({
    queryKey: ['credentials', credentialId, 'usages'],
    queryFn: () => fetchCredentialUsages(credentialId),
  })
  const item = detail.data
  if (detail.isPending)
    return (
      <Main>
        <PageSkeleton />
      </Main>
    )
  if (!item || detail.isError)
    return (
      <Main>
        <QueryErrorState
          title='无法查看此账号凭据'
          onRetry={() => void detail.refetch()}
        />
      </Main>
    )
  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        parent={
          <Link to='/credentials' className='text-link'>
            返回目标账号凭据
          </Link>
        }
        title={item.name}
        description={`${item.subjectLabel} · ${item.safeIdentifier}`}
        actions={<CredentialActions item={item} onAction={setAction} />}
      />
      <section className='grid gap-6 rounded-lg border border-border-card bg-card p-5 shadow-card md:grid-cols-2'>
        <div className='space-y-3'>
          <h2 className='text-title-sm'>账号凭据</h2>
          <p>
            目标系统：
            <a className='text-link' href={item.domainHref}>
              {item.subjectLabel}
            </a>
          </p>
          <p>账号名称：{item.name}</p>
          <p>登录名：{item.safeIdentifier}</p>
          <p>密码：{item.hasPassword ? '已保存' : '未保存'}</p>
          <p>负责人：{item.ownerDisplayName ?? '未指定'}</p>
        </div>
        <div className='space-y-3'>
          <h2 className='text-title-sm'>有效期与登录状态</h2>
          <p>
            有效期：{MAINTENANCE_LABELS[item.maintenanceStatus]}
            {item.validityPolicy.amount
              ? `（${item.validityPolicy.amount} ${item.validityPolicy.mode === 'days' ? '天' : '个月'}）`
              : ''}
          </p>
          {item.validityStartedAt && (
            <p>
              起算时间：
              {new Date(item.validityStartedAt).toLocaleString('zh-CN')}
            </p>
          )}
          {item.maintenanceDueAt && (
            <p>
              到期时间：
              {new Date(item.maintenanceDueAt).toLocaleString('zh-CN')}
            </p>
          )}
          <p>{credentialSessionLabel(item.session)}</p>
          {item.session.lastAuthCheckedAt && (
            <p className='text-label text-muted-foreground'>
              最近检查：
              {new Date(item.session.lastAuthCheckedAt).toLocaleString('zh-CN')}
            </p>
          )}
          {item.sessionHref && (
            <a className='text-link' href={item.sessionHref}>
              查看浏览器会话
            </a>
          )}
          <p className='text-label text-muted-foreground'>
            到期提醒维护，不会自动停用账号。浏览器在线不等于登录仍有效。
          </p>
        </div>
      </section>
      <section className='space-y-3'>
        <h2 className='text-title-sm'>使用情况</h2>
        {usages.isError ? (
          <QueryErrorState
            title='无法加载使用情况'
            onRetry={() => void usages.refetch()}
          />
        ) : usages.isPending ? (
          <p>正在加载…</p>
        ) : usages.data.items.length ? (
          <ul className='space-y-2'>
            {usages.data.items.map((u, i) => (
              <li key={`${u.resource}-${i}`}>
                {USAGE_RESOURCE_LABELS[u.resource]} · {u.label ?? '关联对象'}
                {u.href && (
                  <a className='ml-2 text-link' href={u.href}>
                    查看
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-muted-foreground'>当前授权范围内没有使用记录。</p>
        )}
      </section>
      <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
        <h2 className='text-title-sm'>变更记录</h2>
        {history.isError ? (
          <QueryErrorState
            title='无法加载变更记录'
            onRetry={() => void history.refetch()}
          />
        ) : history.isPending ? (
          <p>正在加载…</p>
        ) : history.data.items.length ? (
          <ul className='space-y-3'>
            {history.data.items.map((e) => (
              <li key={e.id} className='text-label'>
                {new Date(e.createdAt).toLocaleString('zh-CN')} · {e.summary}
                {e.actorDisplayName ? ` · ${e.actorDisplayName}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-muted-foreground'>暂无变更记录。</p>
        )}
        <CursorPagination
          pageIndex={page.pageIndex}
          pageSize={page.pageSize}
          hasPreviousPage={page.pageIndex > 0}
          hasNextPage={!!history.data?.nextCursor}
          updating={history.isFetching}
          onPageSizeChange={page.setPageSize}
          onPreviousPage={page.goPrev}
          onNextPage={() => {
            if (history.data?.nextCursor) page.goNext(history.data.nextCursor)
          }}
        />
      </section>
      {action && (
        <CredentialEditor
          key={action}
          item={item}
          action={action}
          onClose={(removed) => {
            setAction(null)
            if (removed) void navigate({ to: '/credentials' })
          }}
        />
      )}
    </Main>
  )
}
