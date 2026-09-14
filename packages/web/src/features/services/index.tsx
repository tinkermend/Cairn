import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ServiceCallerDto, ServiceCredentialDto } from '@cairn/shared'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  fetchService,
  fetchServices,
  revokeCredential,
} from '@/lib/services-api'
import { fetchTargets, fetchTargetAccounts } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
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
import {
  CallerDialog,
  CredentialDialog,
  SCOPE_LABELS,
  TokenDialog,
} from './forms'

const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '尚未使用'
function GrantSummary({
  grant,
}: {
  grant: ServiceCredentialDto['grants'][number]
}) {
  const targets = useQuery({ queryKey: ['targets'], queryFn: fetchTargets })
  const accounts = useQuery({
    queryKey: ['targets', grant.targetId, 'accounts'],
    queryFn: () => fetchTargetAccounts(grant.targetId),
  })
  return (
    <li className='text-small'>
      <span className='font-medium'>
        {targets.data?.items.find((t) => t.id === grant.targetId)?.name ??
          grant.targetId}
      </span>
      <span className='ml-2 text-muted-foreground'>
        {grant.accountIds
          .map(
            (id) =>
              accounts.data?.items.find((a) => a.id === id)?.displayName ?? id
          )
          .join('、') || '无账号授权'}
        {grant.allowAnonymous ? ' · 允许无账号任务' : ''}
      </span>
    </li>
  )
}
export function ServicesPage() {
  const client = useQueryClient()
  const [cursor, setCursor] = useState<string>(),
    [selected, setSelected] = useState<string>()
  const [callerForm, setCallerForm] = useState<ServiceCallerDto | 'new' | null>(
    null
  )
  const [keyForm, setKeyForm] = useState<{
    credential?: ServiceCredentialDto
    rotate?: boolean
  } | null>(null)
  const [token, setToken] = useState<string>(),
    [revoking, setRevoking] = useState<ServiceCredentialDto | null>(null),
    [busy, setBusy] = useState(false)
  const list = useQuery({
    queryKey: ['services', cursor],
    queryFn: () => fetchServices(cursor),
  })
  const detail = useQuery({
    queryKey: ['service', selected],
    queryFn: () => fetchService(selected!),
    enabled: !!selected,
  })
  const refresh = (id?: string) => {
    if (id) setSelected(id)
    void client.invalidateQueries({ queryKey: ['services'] })
    void client.invalidateQueries({ queryKey: ['service'] })
  }
  const caller = detail.data?.caller
  async function revoke() {
    if (!selected || !revoking) return
    setBusy(true)
    try {
      await revokeCredential(selected, revoking.id)
      setRevoking(null)
      refresh()
      toast.success('凭据已吊销')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '吊销失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='开放服务'
          description='让外部应用在指定目标范围内执行场景。服务凭据不具有控制台管理权限。'
          actions={
            <Can permission='service:write'>
              <Button
                variant={selected ? 'outline' : 'default'}
                onClick={() => setCallerForm('new')}
              >
                <Plus />
                新建调用方
              </Button>
            </Can>
          }
        />
        {list.isPending ? (
          <PageSkeleton />
        ) : list.isError ? (
          <QueryErrorState
            title='无法加载服务调用方'
            onRetry={() => void list.refetch()}
          />
        ) : !list.data.items.length ? (
          <EmptyState
            title='还没有服务调用方'
            description='创建调用方，配置请求额度，再为外部应用签发 API Key。'
          />
        ) : (
          <section
            className='min-w-0 rounded-lg border border-border-card bg-card'
            aria-label='服务调用方列表'
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>应用 / 负责人</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>未结束运行</TableHead>
                  <TableHead>请求上限</TableHead>
                  <TableHead>凭据</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={selected === item.id ? 'selected' : undefined}
                  >
                    <TableCell>
                      <button
                        className='text-left font-medium text-primary underline-offset-4 hover:underline'
                        onClick={() => setSelected(item.id)}
                      >
                        {item.name}
                      </button>
                      <p className='mt-1 text-small text-muted-foreground'>
                        {item.owner}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          item.status === 'active'
                            ? 'text-status-success-foreground'
                            : 'text-muted-foreground'
                        }
                      >
                        {item.status === 'active' ? '已启用' : '已停用'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {item.outstandingRuns} / {item.maxOutstandingRuns}
                    </TableCell>
                    <TableCell>{item.requestsPerMinute} 次/分钟</TableCell>
                    <TableCell>{item.credentialCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className='flex justify-end gap-2 border-t p-3'>
              <Button
                size='sm'
                variant='outline'
                disabled={!cursor}
                onClick={() => setCursor(undefined)}
              >
                回到首页
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={!list.data.nextCursor}
                onClick={() => setCursor(list.data.nextCursor)}
              >
                下一页
              </Button>
            </div>
          </section>
        )}
        {selected &&
          (detail.isPending ? (
            <PageSkeleton />
          ) : detail.isError ? (
            <QueryErrorState
              title='无法加载调用方详情'
              onRetry={() => void detail.refetch()}
            />
          ) : (
            caller && (
              <section
                className='space-y-5 rounded-lg border border-border-card bg-card p-4 sm:p-6'
                aria-label='调用方详情'
              >
                <div className='flex flex-wrap items-start justify-between gap-3'>
                  <div>
                    <h2 className='text-heading-sm'>{caller.name}</h2>
                    <p className='mt-1 text-small text-muted-foreground'>
                      负责人：{caller.owner} · 总时限 {caller.runTimeoutSeconds}{' '}
                      秒 · {caller.status === 'active' ? '已启用' : '已停用'}
                    </p>
                  </div>
                  <Can permission='service:write'>
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        variant='outline'
                        onClick={() => setCallerForm(caller)}
                      >
                        编辑调用方
                      </Button>
                      <Button onClick={() => setKeyForm({})}>
                        <Plus />
                        签发凭据
                      </Button>
                    </div>
                  </Can>
                </div>
                <p className='text-small text-muted-foreground'>
                  多把 Key
                  共享额度和运行归属。吊销或缩小授权后，新请求立即按新范围检查；已接纳任务继续执行。
                </p>
                {!detail.data.credentials.length ? (
                  <EmptyState
                    title='尚未签发凭据'
                    description='先选择可调用能力与目标账号，再签发 Key。'
                  />
                ) : (
                  <div className='space-y-4'>
                    {detail.data.credentials.map((key) => (
                      <article
                        key={key.id}
                        className='space-y-3 rounded-md border p-4'
                      >
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <h3 className='text-small font-semibold'>
                            {key.name}{' '}
                            <span
                              className={
                                key.status === 'active'
                                  ? 'ml-2 font-normal text-status-success-foreground'
                                  : 'ml-2 font-normal text-muted-foreground'
                              }
                            >
                              {key.status === 'active'
                                ? '有效'
                                : key.status === 'expired'
                                  ? '已过期'
                                  : '已吊销'}
                            </span>
                          </h3>
                          <Can permission='service:write'>
                            <div className='flex flex-wrap gap-1'>
                              {key.status === 'active' && (
                                <>
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={() =>
                                      setKeyForm({ credential: key })
                                    }
                                  >
                                    编辑授权
                                  </Button>
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={() =>
                                      setKeyForm({
                                        credential: key,
                                        rotate: true,
                                      })
                                    }
                                  >
                                    轮换
                                  </Button>
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    className='text-destructive'
                                    onClick={() => setRevoking(key)}
                                  >
                                    吊销
                                  </Button>
                                </>
                              )}
                            </div>
                          </Can>
                        </div>
                        <p className='text-small'>
                          {key.scopes.map((s) => SCOPE_LABELS[s]).join(' · ')}
                        </p>
                        <ul className='space-y-1'>
                          {key.grants.map((grant) => (
                            <GrantSummary key={grant.targetId} grant={grant} />
                          ))}
                        </ul>
                        {!key.grants.length && (
                          <p className='text-small text-status-warning-foreground'>
                            未授权任何目标系统
                          </p>
                        )}
                        <div className='flex flex-wrap gap-x-6 gap-y-1 text-small text-muted-foreground'>
                          <span>到期：{date(key.expiresAt)}</span>
                          <span>最近调用：{date(key.lastUsedAt)}</span>
                          <span>授权版本：{key.revision}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <details className='border-t pt-4 text-small'>
                  <summary className='cursor-pointer font-medium'>
                    API 接入说明
                  </summary>
                  <div className='mt-3 space-y-2 text-muted-foreground'>
                    <p>
                      通过 Authorization: Bearer 携带
                      Key。先获取可执行的已发布场景版本，再创建 Run。
                    </p>
                    <code className='block break-all'>
                      GET /api/open/v1/targets
                    </code>
                    <code className='block break-all'>
                      GET /api/open/v1/targets/:targetId/scenarios
                    </code>
                    <code className='block break-all'>
                      POST /api/open/v1/runs
                    </code>
                    <p>
                      创建需传
                      scenarioId、scenarioVersionId、targetAccountId、input 和
                      idempotencyKey。网络重试沿用同一幂等键，返回同一个
                      Run。按需查询进度，遇到 429 按 Retry-After 退避。
                    </p>
                    <p>
                      仅已人工发布的业务输出和截图可供外部读取；Trace
                      与内部执行配置不对外提供。
                    </p>
                  </div>
                </details>
              </section>
            )
          ))}
      </Main>
      {callerForm && (
        <CallerDialog
          caller={callerForm === 'new' ? undefined : callerForm}
          onClose={() => setCallerForm(null)}
          onSaved={refresh}
        />
      )}
      {keyForm && selected && (
        <CredentialDialog
          callerId={selected}
          {...keyForm}
          onClose={() => setKeyForm(null)}
          onSaved={(value) => {
            refresh()
            if (value) setToken(value)
          }}
        />
      )}
      {token && (
        <TokenDialog token={token} onClose={() => setToken(undefined)} />
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open && !busy) setRevoking(null)
        }}
        title='吊销服务凭据'
        desc={`吊销「${revoking?.name ?? ''}」后，该 Key 将无法再调用 API，且不能恢复。已接纳的运行继续执行。`}
        confirmText={busy ? '吊销中…' : '吊销'}
        destructive
        disabled={busy}
        handleConfirm={() => void revoke()}
      />
    </>
  )
}
