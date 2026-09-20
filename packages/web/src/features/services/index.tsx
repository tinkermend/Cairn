import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ServiceCallerDto, ServiceCredentialDto } from '@cairn/shared'
import { Archive, ClipboardCopy, Pencil, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { subscribeRunEvents } from '@/lib/runs-api'
import {
  archiveService,
  cancelServiceOutstandingRun,
  fetchService,
  fetchServiceRequestLog,
  fetchServiceRequestLogs,
  fetchServiceOutstandingRuns,
  fetchServices,
  revokeCredential,
  setServiceCredentialSuspended,
  setServiceStatus,
} from '@/lib/services-api'
import { fetchTargets, fetchTargetAccounts } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
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
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'
import {
  CallerDialog,
  CredentialCatalogSheet,
  CredentialDialog,
  CredentialMetadataDialog,
  IpWhitelistDialog,
  TokenDialog,
} from './forms'
import { ServicePlaygroundPanel } from './playground'
import { SCOPE_LABELS } from './scope-labels'
import { ServiceWebhookPanel } from './webhook'

const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN') : '尚未使用'
const duration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return minutes ? `${minutes} 分 ${remaining} 秒` : `${remaining} 秒`
}
const logTone = (statusCode: number) =>
  statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'success'

function RequestLogSheet({
  callerId,
  logId,
  onClose,
}: {
  callerId: string
  logId: string
  onClose: () => void
}) {
  const detail = useQuery({
    queryKey: ['service', callerId, 'request-log', logId],
    queryFn: () => fetchServiceRequestLog(callerId, logId),
  })
  const copyRequestId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success('Request ID 已复制')
    } catch {
      toast.error('无法复制 Request ID，请手动复制')
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent side='right' className='w-full overflow-y-auto sm:max-w-xl'>
        <SheetHeader className='border-b border-border p-6 pb-4'>
          <SheetTitle>调用排障详情</SheetTitle>
          <SheetDescription>
            仅保存平台生成的诊断结论和经裁剪的请求摘要。
          </SheetDescription>
        </SheetHeader>
        <div className='space-y-5 px-6 pb-6'>
          {detail.isPending ? (
            <PageSkeleton />
          ) : detail.isError || !detail.data ? (
            <QueryErrorState
              title='无法加载排障详情'
              onRetry={() => void detail.refetch()}
            />
          ) : (
            <>
              <section className='rounded-md border p-4'>
                <div className='flex flex-wrap items-center gap-2'>
                  <StatusBadge tone={logTone(detail.data.statusCode)}>
                    HTTP {detail.data.statusCode}
                  </StatusBadge>
                  <span className='text-small text-muted-foreground'>
                    {detail.data.errorMessage ?? '请求已成功完成'}
                  </span>
                </div>
                {detail.data.errorCode ? (
                  <p className='mt-3 text-small'>
                    错误码：<code>{detail.data.errorCode}</code>
                  </p>
                ) : null}
                {detail.data.diagnostic?.retryAfter ? (
                  <p className='mt-2 text-small text-muted-foreground'>
                    建议在 {detail.data.diagnostic.retryAfter} 秒后重试。
                  </p>
                ) : null}
              </section>
              <dl className='grid gap-x-4 gap-y-3 text-small sm:grid-cols-[8rem_1fr]'>
                <dt className='text-muted-foreground'>发生时间</dt>
                <dd>{date(detail.data.createdAt)}</dd>
                <dt className='text-muted-foreground'>请求路径</dt>
                <dd>
                  <code>
                    {detail.data.method} {detail.data.path}
                  </code>
                </dd>
                <dt className='text-muted-foreground'>Request ID</dt>
                <dd className='flex min-w-0 items-center gap-2'>
                  <code className='min-w-0 break-all'>
                    {detail.data.requestId}
                  </code>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    onClick={() => void copyRequestId(detail.data.requestId)}
                  >
                    复制
                  </Button>
                </dd>
                <dt className='text-muted-foreground'>耗时 / 来源</dt>
                <dd>
                  {detail.data.latencyMs} ms ·{' '}
                  {detail.data.clientIp ?? '未获得地址'}
                </dd>
                <dt className='text-muted-foreground'>凭据</dt>
                <dd>
                  {detail.data.credentialName ?? detail.data.credentialId}
                </dd>
              </dl>
              <section className='space-y-2'>
                <h3 className='text-small font-medium'>请求摘要</h3>
                {detail.data.requestSummary ? (
                  <pre className='overflow-x-auto rounded-md bg-muted p-3 text-small'>
                    {JSON.stringify(detail.data.requestSummary, null, 2)}
                  </pre>
                ) : (
                  <p className='text-small text-muted-foreground'>
                    此请求没有可安全记录的结构化摘要。
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ServiceStatus({ caller }: { caller: ServiceCallerDto }) {
  if (caller.archivedAt) return <StatusBadge tone='neutral'>已归档</StatusBadge>
  return caller.status === 'active' ? (
    <StatusBadge tone='success'>已启用</StatusBadge>
  ) : (
    <StatusBadge tone='neutral'>已停用</StatusBadge>
  )
}

function GrantSummary({
  grant,
}: {
  grant: ServiceCredentialDto['grants'][number]
}) {
  const targets = useQuery({
    queryKey: ['targets'],
    queryFn: () => fetchTargets(),
  })
  const accounts = useQuery({
    queryKey: ['targets', grant.targetId, 'accounts'],
    queryFn: () => fetchTargetAccounts(grant.targetId),
  })
  return (
    <li className='text-small'>
      <span className='font-medium'>
        {targets.data?.items.find((target) => target.id === grant.targetId)
          ?.name ?? grant.targetId}
      </span>
      <span className='ml-2 text-muted-foreground'>
        {grant.accountIds
          .map(
            (id) =>
              accounts.data?.items.find((account) => account.id === id)
                ?.displayName ?? id
          )
          .join('、') || '无账号授权'}
        {grant.allowAnonymous ? ' · 允许无账号任务' : ''}
      </span>
    </li>
  )
}

function CredentialCard({
  credential,
  writable,
  archived,
  onEditMetadata,
  onEditPolicy,
  onRotate,
  onRevoke,
  onSetSuspended,
  onViewCatalog,
  onCopyReference,
}: {
  credential: ServiceCredentialDto
  writable: boolean
  archived: boolean
  onEditMetadata: (credential: ServiceCredentialDto) => void
  onEditPolicy: (credential: ServiceCredentialDto) => void
  onRotate: (credential: ServiceCredentialDto) => void
  onRevoke: (credential: ServiceCredentialDto) => void
  onSetSuspended: (credential: ServiceCredentialDto, suspended: boolean) => void
  onViewCatalog: (credential: ServiceCredentialDto) => void
  onCopyReference: (credential: ServiceCredentialDto) => void
}) {
  return (
    <article className='space-y-3 rounded-md border p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <h3 className='text-small font-semibold'>{credential.name}</h3>
            {credential.status === 'active' ? (
              <StatusBadge tone='success'>有效</StatusBadge>
            ) : (
              <StatusBadge tone='neutral'>
                {credential.status === 'suspended'
                  ? '已冻结'
                  : credential.status === 'expired'
                    ? '已过期'
                    : '已吊销'}
              </StatusBadge>
            )}
          </div>
          {credential.notes ? (
            <p className='mt-1 text-small whitespace-pre-wrap text-muted-foreground'>
              {credential.notes}
            </p>
          ) : null}
        </div>
        {writable ? (
          <div className='flex flex-wrap gap-1'>
            {!archived ? (
              <>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => onEditMetadata(credential)}
                >
                  展示信息
                </Button>
                {credential.status === 'active' ? (
                  <>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => onEditPolicy(credential)}
                    >
                      编辑授权
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => onRotate(credential)}
                    >
                      轮换
                    </Button>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => onSetSuspended(credential, true)}
                    >
                      冻结
                    </Button>
                  </>
                ) : credential.status === 'suspended' ? (
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => onSetSuspended(credential, false)}
                  >
                    恢复
                  </Button>
                ) : null}
              </>
            ) : null}
            {credential.status === 'active' ||
            credential.status === 'suspended' ? (
              <Button
                variant='ghost'
                size='sm'
                className='text-destructive'
                onClick={() => onRevoke(credential)}
              >
                吊销
              </Button>
            ) : null}
          </div>
        ) : null}
        <Button
          variant='ghost'
          size='sm'
          onClick={() => onViewCatalog(credential)}
        >
          可用场景
        </Button>
      </div>
      <p className='text-small'>
        {credential.scopes.map((scope) => SCOPE_LABELS[scope]).join(' · ')}
      </p>
      <ul className='space-y-1'>
        {credential.grants.map((grant) => (
          <GrantSummary key={grant.targetId} grant={grant} />
        ))}
      </ul>
      {!credential.grants.length ? (
        <p className='text-small text-status-warning-foreground'>
          未授权任何目标系统
        </p>
      ) : null}
      <div className='flex flex-wrap gap-x-6 gap-y-1 text-small text-muted-foreground'>
        <span className='flex items-center gap-1'>
          Key ID：<code>{credential.id}</code>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1'
            onClick={() => onCopyReference(credential)}
          >
            <ClipboardCopy aria-hidden />
            <span className='sr-only'>复制 Key ID</span>
          </Button>
        </span>
        <span>到期：{date(credential.expiresAt)}</span>
        {credential.suspendedAt ? (
          <span>冻结于：{date(credential.suspendedAt)}</span>
        ) : null}
        <span>最近调用：{date(credential.lastUsedAt)}</span>
        <span>授权版本：{credential.revision}</span>
        <span>展示版本：{credential.metadataRevision}</span>
      </div>
    </article>
  )
}

function useVisibleRunEventInvalidation(
  runIds: readonly string[],
  enabled: boolean,
  invalidate: () => void,
  onStreamState: (unavailable: boolean) => void
) {
  const key = runIds.join(',')
  useEffect(() => {
    if (!enabled || !key) return
    const controller = new AbortController()
    const cursors = new Map(key.split(',').map((id) => [id, 0]))
    for (const id of key.split(',')) {
      void subscribeRunEvents(id, {
        cursor: cursors.get(id) ?? 0,
        signal: controller.signal,
        handlers: {
          onEvent: (event) => {
            cursors.set(id, event.sequence)
            onStreamState(false)
            invalidate()
          },
          onControl: (control) => {
            onStreamState(false)
            if (control.kind === 'reset' || control.kind === 'complete')
              invalidate()
          },
        },
      }).catch(() => {
        if (!controller.signal.aborted) onStreamState(true)
      })
    }
    return () => controller.abort()
  }, [enabled, invalidate, key, onStreamState])
}

export function ServicesPage() {
  const client = useQueryClient()
  const callerPage = useCursorPage(20, 'services-page')
  const runPage = useCursorPage(20, 'service-outstanding-runs')
  const logPage = useCursorPage(20, 'service-request-logs')
  const canWrite = useCan('service:write')
  const canExecuteRuns = useCan('run:execute')
  const canReadRuns = useCan('run:read')
  const [selected, setSelected] = useState<string>()
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'disabled'
  >('all')
  const [sortBy, setSortBy] = useState<
    'createdAt' | 'updatedAt' | 'outstandingRuns'
  >('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [callerForm, setCallerForm] = useState<ServiceCallerDto | 'new' | null>(
    null
  )
  const [keyForm, setKeyForm] = useState<{
    credential?: ServiceCredentialDto
    rotate?: boolean
  } | null>(null)
  const [metadataForm, setMetadataForm] = useState<ServiceCredentialDto | null>(
    null
  )
  const [token, setToken] = useState<string>()
  const [revoking, setRevoking] = useState<ServiceCredentialDto | null>(null)
  const [credentialStatusIntent, setCredentialStatusIntent] = useState<{
    credential: ServiceCredentialDto
    suspended: boolean
  } | null>(null)
  const [ipWhitelistForm, setIpWhitelistForm] = useState(false)
  const [catalogCredential, setCatalogCredential] =
    useState<ServiceCredentialDto | null>(null)
  const [selectedLogId, setSelectedLogId] = useState<string>()
  const [logFilters, setLogFilters] = useState({
    statusCategory: 'all' as 'all' | '2xx' | '4xx' | '5xx',
    requestId: '',
    startAt: '',
    endAt: '',
  })
  const [appliedLogFilters, setAppliedLogFilters] = useState(logFilters)
  const [statusIntent, setStatusIntent] = useState<{
    caller: Pick<ServiceCallerDto, 'id' | 'name' | 'status'>
    target: 'active' | 'disabled'
  } | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [cancellingRun, setCancellingRun] = useState<{
    id: string
    scenarioName: string
  } | null>(null)
  const [action, setAction] = useState<
    'status' | 'archive' | 'revoke' | 'suspend' | 'cancel' | null
  >(null)
  const [showInactiveKeys, setShowInactiveKeys] = useState(false)
  const [streamUnavailable, setStreamUnavailable] = useState(false)
  const resetCallerPage = callerPage.reset
  const resetRunPage = runPage.reset
  const resetLogPage = logPage.reset

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearch(searchDraft.trim())
      resetCallerPage()
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [resetCallerPage, searchDraft])

  const selectCaller = useCallback(
    (id: string) => {
      if (id === selected) return
      resetRunPage()
      resetLogPage()
      setStreamUnavailable(false)
      setSelectedLogId(undefined)
      setCatalogCredential(null)
      setIpWhitelistForm(false)
      setSelected(id)
    },
    [resetLogPage, resetRunPage, selected]
  )

  const list = useQuery({
    queryKey: [
      'services',
      {
        cursor: callerPage.cursor,
        limit: callerPage.pageSize,
        search: search || undefined,
        status: statusFilter,
        sortBy,
        sortOrder,
        includeArchived,
      },
    ],
    queryFn: () =>
      fetchServices({
        cursor: callerPage.cursor,
        limit: callerPage.pageSize,
        search: search || undefined,
        status: statusFilter,
        sortBy,
        sortOrder,
        includeArchived,
      }),
  })
  const detail = useQuery({
    queryKey: ['service', selected],
    queryFn: () => fetchService(selected!),
    enabled: !!selected,
  })
  const outstanding = useQuery({
    queryKey: [
      'service',
      selected,
      'outstanding-runs',
      runPage.cursor,
      runPage.pageSize,
    ],
    queryFn: () =>
      fetchServiceOutstandingRuns(selected!, {
        cursor: runPage.cursor,
        limit: runPage.pageSize,
      }),
    enabled: !!selected && canReadRuns,
  })
  const requestLogs = useQuery({
    queryKey: [
      'service',
      selected,
      'request-logs',
      logPage.cursor,
      logPage.pageSize,
      appliedLogFilters,
    ],
    queryFn: () =>
      fetchServiceRequestLogs(selected!, {
        cursor: logPage.cursor,
        limit: logPage.pageSize,
        statusCategory: appliedLogFilters.statusCategory,
        requestId: appliedLogFilters.requestId || undefined,
        startAt: appliedLogFilters.startAt
          ? new Date(appliedLogFilters.startAt).toISOString()
          : undefined,
        endAt: appliedLogFilters.endAt
          ? new Date(appliedLogFilters.endAt).toISOString()
          : undefined,
      }),
    enabled: !!selected,
  })
  const refresh = useCallback(
    (id?: string) => {
      if (id) selectCaller(id)
      void client.invalidateQueries({ queryKey: ['services'] })
      void client.invalidateQueries({ queryKey: ['service'] })
    },
    [client, selectCaller]
  )
  const refreshOutstanding = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['services'] })
    void client.invalidateQueries({ queryKey: ['service'] })
    void client.invalidateQueries({
      queryKey: ['service', selected, 'request-logs'],
    })
    void client.invalidateQueries({
      queryKey: ['service', selected, 'outstanding-runs'],
    })
  }, [client, selected])
  const copyCredentialReference = useCallback(
    async (credential: ServiceCredentialDto) => {
      const reference = `cairn_sk_${credential.id}`
      try {
        await navigator.clipboard.writeText(reference)
        toast.success('Key 引用已复制')
      } catch {
        toast.error('无法复制 Key 引用，请手动复制')
      }
    },
    []
  )
  const updateStreamState = useCallback((unavailable: boolean) => {
    setStreamUnavailable(unavailable)
  }, [])
  const visibleRunIds = useMemo(
    () => outstanding.data?.items.map((run) => run.id) ?? [],
    [outstanding.data?.items]
  )
  useVisibleRunEventInvalidation(
    visibleRunIds,
    canReadRuns && !!selected,
    refreshOutstanding,
    updateStreamState
  )

  const caller = detail.data?.caller
  const activeCredentials =
    detail.data?.credentials.filter((key) => key.status === 'active') ?? []
  const playgroundCredentials = activeCredentials.filter((credential) =>
    credential.scopes.includes('run:execute')
  )
  const inactiveCredentials =
    detail.data?.credentials.filter((key) => key.status !== 'active') ?? []

  function applyLogFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      logFilters.startAt &&
      logFilters.endAt &&
      new Date(logFilters.startAt) > new Date(logFilters.endAt)
    ) {
      toast.error('结束时间必须不早于开始时间')
      return
    }
    setAppliedLogFilters({
      ...logFilters,
      requestId: logFilters.requestId.trim(),
    })
    logPage.reset()
  }

  async function changeStatus() {
    if (!statusIntent) return
    setAction('status')
    try {
      await setServiceStatus(statusIntent.caller.id, statusIntent.target)
      setStatusIntent(null)
      refresh()
      toast.success(
        statusIntent.target === 'active'
          ? '服务调用方已启用'
          : '服务调用方已停用'
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新服务状态失败')
    } finally {
      setAction(null)
    }
  }
  async function archive() {
    if (!caller) return
    setAction('archive')
    try {
      await archiveService(caller.id)
      setArchiving(false)
      setIncludeArchived(true)
      callerPage.reset()
      refresh(caller.id)
      toast.success('服务调用方已归档')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '归档失败')
    } finally {
      setAction(null)
    }
  }
  async function revoke() {
    if (!selected || !revoking) return
    setAction('revoke')
    try {
      await revokeCredential(selected, revoking.id)
      setRevoking(null)
      refresh()
      toast.success('凭据已吊销')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '吊销失败')
    } finally {
      setAction(null)
    }
  }
  async function changeCredentialStatus() {
    if (!selected || !credentialStatusIntent) return
    setAction('suspend')
    try {
      await setServiceCredentialSuspended(
        selected,
        credentialStatusIntent.credential.id,
        credentialStatusIntent.suspended
      )
      const { suspended } = credentialStatusIntent
      setCredentialStatusIntent(null)
      refresh()
      toast.success(
        suspended ? '凭据已冻结，新的服务请求会被拒绝' : '凭据已恢复使用'
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新凭据状态失败')
    } finally {
      setAction(null)
    }
  }
  async function cancelRun() {
    if (!selected || !cancellingRun) return
    setAction('cancel')
    try {
      const result = await cancelServiceOutstandingRun(
        selected,
        cancellingRun.id
      )
      setCancellingRun(null)
      refreshOutstanding()
      toast.success(
        result.occupiesServiceCapacity
          ? '已提交取消请求；运行仍占用额度，直到终态或核查完成。'
          : '运行已取消并释放额度。'
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消运行失败')
    } finally {
      setAction(null)
    }
  }

  const requestLogSection = (
    <section className='space-y-4' aria-label='调用排障日志'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3 className='text-section font-semibold'>调用排障日志</h3>
          <p className='mt-1 text-small text-muted-foreground'>
            仅显示 Secret 校验已通过的开放接口调用。日志保留 7
            天，并在响应完成后异步写入。
          </p>
        </div>
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={() => void requestLogs.refetch()}
          disabled={requestLogs.isFetching}
        >
          <RefreshCw />
          刷新
        </Button>
      </div>
      <form
        className='grid gap-3 rounded-md border p-3 md:grid-cols-2 xl:grid-cols-5'
        onSubmit={applyLogFilters}
      >
        <label className='space-y-1 text-small'>
          <span>状态</span>
          <select
            aria-label='日志状态筛选'
            className='h-10 w-full rounded-md border bg-background px-3'
            value={logFilters.statusCategory}
            onChange={(event) =>
              setLogFilters((current) => ({
                ...current,
                statusCategory: event.target
                  .value as typeof current.statusCategory,
              }))
            }
          >
            <option value='all'>全部状态</option>
            <option value='2xx'>成功 2xx</option>
            <option value='4xx'>客户端错误 4xx</option>
            <option value='5xx'>服务端错误 5xx</option>
          </select>
        </label>
        <label className='space-y-1 text-small'>
          <span>Request ID</span>
          <Input
            aria-label='按 Request ID 筛选'
            value={logFilters.requestId}
            maxLength={128}
            onChange={(event) =>
              setLogFilters((current) => ({
                ...current,
                requestId: event.target.value,
              }))
            }
            placeholder='精确定位一次调用'
          />
        </label>
        <label className='space-y-1 text-small'>
          <span>开始时间</span>
          <Input
            aria-label='日志开始时间'
            type='datetime-local'
            value={logFilters.startAt}
            onChange={(event) =>
              setLogFilters((current) => ({
                ...current,
                startAt: event.target.value,
              }))
            }
          />
        </label>
        <label className='space-y-1 text-small'>
          <span>结束时间</span>
          <Input
            aria-label='日志结束时间'
            type='datetime-local'
            value={logFilters.endAt}
            onChange={(event) =>
              setLogFilters((current) => ({
                ...current,
                endAt: event.target.value,
              }))
            }
          />
        </label>
        <div className='flex items-end gap-2'>
          <Button type='submit'>应用筛选</Button>
          <Button
            type='button'
            variant='outline'
            onClick={() => {
              const empty = {
                statusCategory: 'all' as const,
                requestId: '',
                startAt: '',
                endAt: '',
              }
              setLogFilters(empty)
              setAppliedLogFilters(empty)
              logPage.reset()
            }}
          >
            清除
          </Button>
        </div>
      </form>
      {requestLogs.isPending ? (
        <PageSkeleton />
      ) : requestLogs.isError ? (
        <QueryErrorState
          title='无法加载调用排障日志'
          onRetry={() => void requestLogs.refetch()}
        />
      ) : !requestLogs.data?.items.length ? (
        <EmptyState
          title='还没有可查看的调用日志'
          description='已验证凭据的开放接口调用完成后会异步出现在这里。'
        />
      ) : (
        <>
          <div className='overflow-x-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间 / Request ID</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>状态 / 耗时</TableHead>
                  <TableHead className='hidden lg:table-cell'>
                    来源 / 凭据
                  </TableHead>
                  <TableHead>排障结论</TableHead>
                  <TableHead className='text-right'>详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requestLogs.data.items.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      {date(log.createdAt)}
                      <p className='mt-1 max-w-48 truncate text-small text-muted-foreground'>
                        <code>{log.requestId}</code>
                      </p>
                    </TableCell>
                    <TableCell>
                      <code>
                        {log.method} {log.path}
                      </code>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={logTone(log.statusCode)}>
                        {log.statusCode}
                      </StatusBadge>
                      <p className='mt-1 text-small text-muted-foreground'>
                        {log.latencyMs} ms
                      </p>
                    </TableCell>
                    <TableCell className='hidden lg:table-cell'>
                      {log.clientIp ?? '未获得地址'}
                      <p className='mt-1 text-small text-muted-foreground'>
                        {log.credentialName ?? log.credentialId}
                      </p>
                    </TableCell>
                    <TableCell className='max-w-64'>
                      <p className='truncate text-small'>
                        {log.errorMessage ?? '请求已成功完成'}
                      </p>
                      {log.errorCode ? (
                        <code className='mt-1 block text-small text-muted-foreground'>
                          {log.errorCode}
                        </code>
                      ) : null}
                    </TableCell>
                    <TableCell className='text-right'>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        onClick={() => setSelectedLogId(log.id)}
                      >
                        详情
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <CursorPagination
            pageIndex={logPage.pageIndex}
            pageSize={logPage.pageSize}
            hasPreviousPage={logPage.pageIndex > 0}
            hasNextPage={!!requestLogs.data.nextCursor}
            updating={requestLogs.isFetching}
            onPageSizeChange={logPage.setPageSize}
            onPreviousPage={logPage.goPrev}
            onNextPage={() =>
              requestLogs.data.nextCursor &&
              logPage.goNext(requestLogs.data.nextCursor)
            }
          />
        </>
      )}
    </section>
  )

  const networkSection = (
    <section className='space-y-4' aria-label='网络安全策略'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3 className='text-section font-semibold'>网络安全策略</h3>
          <p className='mt-1 text-small text-muted-foreground'>
            白名单按调用方生效，覆盖其所有凭据。配置后，无法确定来源地址的请求也会被拒绝。
          </p>
        </div>
        {canWrite && !caller?.archivedAt ? (
          <Button
            type='button'
            variant='outline'
            onClick={() => setIpWhitelistForm(true)}
          >
            <Pencil />
            编辑白名单
          </Button>
        ) : null}
      </div>
      {!caller?.ipWhitelist.length ? (
        <p className='rounded-md border p-3 text-small text-muted-foreground'>
          未限制来源 IP。添加白名单后，只有命中 IPv4、IPv6 或 CIDR
          条目的调用才可继续鉴权。
        </p>
      ) : (
        <ul className='grid gap-2 sm:grid-cols-2'>
          {caller.ipWhitelist.map((entry) => (
            <li
              key={entry}
              className='rounded-md border bg-muted/40 px-3 py-2 text-small'
            >
              <code>{entry}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  const outstandingSection = (
    <section className='space-y-4 border-t pt-6' aria-label='未结束运行'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3 className='text-section font-semibold'>未结束运行</h3>
          <p className='mt-1 text-small text-muted-foreground'>
            列表只显示仍占用调用方额度的运行。进入完整运行详情可查看证据和执行上下文。
          </p>
        </div>
        {canReadRuns ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={refreshOutstanding}
            disabled={outstanding.isFetching}
          >
            <RefreshCw />
            刷新
          </Button>
        ) : null}
      </div>
      {!canReadRuns ? (
        <p className='rounded-md border border-status-warning-background bg-status-warning-background p-3 text-small text-status-warning-foreground'>
          当前调用方有 {caller?.outstandingRuns ?? 0}{' '}
          个未结束运行；你没有查看运行明细的权限。
        </p>
      ) : outstanding.isPending ? (
        <PageSkeleton />
      ) : outstanding.isError ? (
        <QueryErrorState
          title='无法加载未结束运行'
          onRetry={() => void outstanding.refetch()}
        />
      ) : !outstanding.data ? (
        <PageSkeleton />
      ) : (
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-small text-muted-foreground'>
            <span>
              占用额度 {outstanding.data.outstandingRuns} 个，可见{' '}
              {outstanding.data.visibleOutstandingRuns} 个
            </span>
            <span>观测于 {date(outstanding.data.observedAt)}</span>
          </div>
          {streamUnavailable ? (
            <p className='rounded-md border border-status-warning-background bg-status-warning-background p-3 text-small text-status-warning-foreground'>
              实时进度连接暂不可用；可使用“刷新”读取已持久化的运行事实。
            </p>
          ) : null}
          {!outstanding.data.items.length ? (
            <EmptyState
              title={
                outstanding.data.outstandingRuns
                  ? '没有可查看的未结束运行'
                  : '没有未结束运行'
              }
              description={
                outstanding.data.outstandingRuns
                  ? '仍有运行占用该调用方额度，但你没有其所在目标的查看权限。'
                  : '当前调用方的执行额度没有被运行占用。'
              }
            />
          ) : (
            <>
              <div className='overflow-x-auto rounded-md border'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>场景 / 版本</TableHead>
                      <TableHead>目标 / 账号</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className='hidden lg:table-cell'>
                        当前步骤
                      </TableHead>
                      <TableHead>开始时间</TableHead>
                      <TableHead className='text-right'>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outstanding.data.items.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell>
                          <Link
                            className='font-medium text-primary underline-offset-4 hover:underline'
                            to='/runs/$runId'
                            params={{ runId: run.id }}
                          >
                            {run.scenarioName}
                          </Link>
                          <p className='mt-1 text-small text-muted-foreground'>
                            版本 {run.scenarioVersionNo} · 幂等键{' '}
                            <code>{run.idempotencyKey}</code>
                          </p>
                        </TableCell>
                        <TableCell>
                          {run.targetName}
                          <p className='mt-1 text-small text-muted-foreground'>
                            {run.targetAccountName ?? '无账号任务'} · 凭据{' '}
                            {run.credentialName}
                          </p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={runStatusTone(run.status)}>
                            {RUN_STATUS_LABELS[run.status]}
                          </StatusBadge>
                          {run.cancelRequested ? (
                            <p className='mt-1 text-small text-status-warning-foreground'>
                              已请求取消
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className='hidden lg:table-cell'>
                          {run.currentStepIndex !== null
                            ? `${run.currentStepIndex + 1}. ${run.currentStepName ?? '未命名步骤'}`
                            : '尚未进入步骤'}
                        </TableCell>
                        <TableCell>
                          {date(run.startedAt ?? run.createdAt)}
                          <p className='mt-1 text-small text-muted-foreground'>
                            已运行 {duration(run.durationSeconds)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className='flex justify-end gap-1'>
                            {run.canReview ? (
                              <Button size='sm' variant='ghost' asChild>
                                <Link
                                  to='/runs/$runId'
                                  params={{ runId: run.id }}
                                >
                                  前往核查
                                </Link>
                              </Button>
                            ) : null}
                            <Button size='sm' variant='ghost' asChild>
                              <Link
                                to='/runs/$runId'
                                params={{ runId: run.id }}
                              >
                                查看详情
                              </Link>
                            </Button>
                            {run.canCancel ? (
                              <Button
                                size='sm'
                                variant='ghost'
                                className='text-destructive'
                                disabled={
                                  run.cancelRequested || action !== null
                                }
                                onClick={() =>
                                  setCancellingRun({
                                    id: run.id,
                                    scenarioName: run.scenarioName,
                                  })
                                }
                              >
                                请求取消
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <CursorPagination
                pageIndex={runPage.pageIndex}
                pageSize={runPage.pageSize}
                hasPreviousPage={runPage.pageIndex > 0}
                hasNextPage={!!outstanding.data.nextCursor}
                updating={outstanding.isFetching}
                onPageSizeChange={runPage.setPageSize}
                onPreviousPage={runPage.goPrev}
                onNextPage={() =>
                  outstanding.data.nextCursor &&
                  runPage.goNext(outstanding.data.nextCursor)
                }
              />
            </>
          )}
        </div>
      )}
    </section>
  )

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='API 接入'
          description='让外部应用在指定目标范围内执行场景。服务凭据不具有控制台管理权限。'
          actions={
            canWrite ? (
              <Button onClick={() => setCallerForm('new')}>
                <Plus />
                新建调用方
              </Button>
            ) : undefined
          }
        />
        <section className='flex flex-col gap-3 rounded-lg border border-border-card bg-card p-3 lg:flex-row lg:items-end'>
          <label className='min-w-0 flex-1 space-y-1 text-small'>
            <span>搜索调用方</span>
            <Input
              aria-label='搜索调用方'
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder='应用名称或负责人'
            />
          </label>
          <label className='space-y-1 text-small'>
            <span>状态</span>
            <select
              aria-label='状态筛选'
              value={statusFilter}
              className='h-10 rounded-md border bg-background px-3'
              onChange={(event) => {
                setStatusFilter(
                  event.target.value as 'all' | 'active' | 'disabled'
                )
                callerPage.reset()
              }}
            >
              <option value='all'>全部状态</option>
              <option value='active'>已启用</option>
              <option value='disabled'>已停用</option>
            </select>
          </label>
          <label className='space-y-1 text-small'>
            <span>排序字段</span>
            <select
              aria-label='排序字段'
              value={sortBy}
              className='h-10 rounded-md border bg-background px-3'
              onChange={(event) => {
                setSortBy(
                  event.target.value as
                    'createdAt' | 'updatedAt' | 'outstandingRuns'
                )
                callerPage.reset()
              }}
            >
              <option value='createdAt'>创建时间</option>
              <option value='updatedAt'>更新时间</option>
              <option value='outstandingRuns'>未结束运行数</option>
            </select>
          </label>
          <label className='space-y-1 text-small'>
            <span>排序方向</span>
            <select
              aria-label='排序方向'
              value={sortOrder}
              className='h-10 rounded-md border bg-background px-3'
              onChange={(event) => {
                setSortOrder(event.target.value as 'asc' | 'desc')
                callerPage.reset()
              }}
            >
              <option value='desc'>降序</option>
              <option value='asc'>升序</option>
            </select>
          </label>
          <label className='flex min-h-10 items-center gap-2 text-small'>
            <Switch
              checked={includeArchived}
              onCheckedChange={(checked) => {
                setIncludeArchived(checked)
                callerPage.reset()
              }}
              aria-label='显示已归档调用方'
            />
            显示已归档
          </label>
          <Button
            type='button'
            variant='outline'
            onClick={() => {
              callerPage.reset()
              void client.invalidateQueries({ queryKey: ['services'] })
            }}
            disabled={list.isFetching}
          >
            <RefreshCw />
            刷新
          </Button>
        </section>
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
            <div className='overflow-x-auto'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>应用 / 负责人</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className='hidden md:table-cell'>
                      未结束运行
                    </TableHead>
                    <TableHead className='hidden lg:table-cell'>
                      请求上限
                    </TableHead>
                    <TableHead className='hidden sm:table-cell'>凭据</TableHead>
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
                          className='text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none'
                          onClick={() => selectCaller(item.id)}
                        >
                          {item.name}
                        </button>
                        <p className='mt-1 text-small text-muted-foreground'>
                          {item.owner}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className='flex items-center gap-2'>
                          <ServiceStatus caller={item} />
                          {canWrite && !item.archivedAt ? (
                            <Switch
                              checked={item.status === 'active'}
                              aria-label={`切换 ${item.name} 的服务状态`}
                              onCheckedChange={(checked) =>
                                setStatusIntent({
                                  caller: {
                                    id: item.id,
                                    name: item.name,
                                    status: item.status,
                                  },
                                  target: checked ? 'active' : 'disabled',
                                })
                              }
                            />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className='hidden md:table-cell'>
                        {item.outstandingRuns} / {item.maxOutstandingRuns}
                      </TableCell>
                      <TableCell className='hidden lg:table-cell'>
                        {item.requestsPerMinute} 次/分钟
                      </TableCell>
                      <TableCell className='hidden sm:table-cell'>
                        {item.credentialCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <CursorPagination
              className='border-t p-3'
              pageIndex={callerPage.pageIndex}
              pageSize={callerPage.pageSize}
              hasPreviousPage={callerPage.pageIndex > 0}
              hasNextPage={!!list.data.nextCursor}
              updating={list.isFetching}
              onPageSizeChange={callerPage.setPageSize}
              onPreviousPage={callerPage.goPrev}
              onNextPage={() =>
                list.data.nextCursor && callerPage.goNext(list.data.nextCursor)
              }
            />
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
          ) : caller ? (
            <section
              className='space-y-6 rounded-lg border border-border-card bg-card p-4 sm:p-6'
              aria-label='调用方详情'
            >
              <div className='flex flex-wrap items-start justify-between gap-4'>
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <h2 className='text-heading-sm'>{caller.name}</h2>
                    <ServiceStatus caller={caller} />
                  </div>
                  <p className='mt-1 text-small text-muted-foreground'>
                    负责人：{caller.owner} · 总时限 {caller.runTimeoutSeconds}{' '}
                    秒 · 未结束运行 {caller.outstandingRuns} /{' '}
                    {caller.maxOutstandingRuns}
                  </p>
                </div>
                {canWrite && !caller.archivedAt ? (
                  <div className='flex flex-wrap items-center gap-2'>
                    <label className='flex min-h-10 items-center gap-2 text-small'>
                      <Switch
                        checked={caller.status === 'active'}
                        aria-label='服务状态'
                        onCheckedChange={(checked) =>
                          setStatusIntent({
                            caller: {
                              id: caller.id,
                              name: caller.name,
                              status: caller.status,
                            },
                            target: checked ? 'active' : 'disabled',
                          })
                        }
                      />
                      {caller.status === 'active' ? '已启用' : '已停用'}
                    </label>
                    <Button
                      variant='outline'
                      onClick={() => setCallerForm(caller)}
                    >
                      <Pencil />
                      编辑调用方
                    </Button>
                    <Button onClick={() => setKeyForm({})}>
                      <Plus />
                      签发凭据
                    </Button>
                    <Button
                      variant='outline'
                      className='text-destructive'
                      onClick={() => setArchiving(true)}
                      disabled={caller.outstandingRuns > 0}
                      title={
                        caller.outstandingRuns > 0
                          ? '仍有未结束运行，处理完成后才能归档'
                          : undefined
                      }
                    >
                      <Archive />
                      归档
                    </Button>
                  </div>
                ) : null}
              </div>
              {caller.archivedAt ? (
                <p className='rounded-md border border-status-warning-background bg-status-warning-background p-3 text-small text-status-warning-foreground'>
                  该调用方已于 {date(caller.archivedAt)}{' '}
                  归档，历史运行和凭据仅供审计查看，不能再签发或修改。
                </p>
              ) : (
                <p className='text-small text-muted-foreground'>
                  停用会立即阻止新 API
                  调用；排队、执行、恢复、等待登录、挂起和待核查的运行仍占用额度，必须达到终态或完成核查才会释放。
                </p>
              )}
              {!caller.archivedAt &&
              caller.outstandingRuns >= caller.maxOutstandingRuns ? (
                <p className='rounded-md border border-status-warning-background bg-status-warning-background p-3 text-small text-status-warning-foreground'>
                  当前未结束运行已达到可用额度；新的服务运行请求会被拒绝，直到运行达到终态或完成核查。
                </p>
              ) : null}
              <Tabs defaultValue='overview' className='gap-5'>
                <TabsList className='max-w-full overflow-x-auto'>
                  <TabsTrigger value='overview'>概览与凭据</TabsTrigger>
                  <TabsTrigger value='logs'>调用排障日志</TabsTrigger>
                  <TabsTrigger value='network'>网络安全策略</TabsTrigger>
                  <TabsTrigger value='webhook'>Webhook 配置</TabsTrigger>
                  <TabsTrigger value='playground'>API 调试台</TabsTrigger>
                </TabsList>
                <TabsContent value='overview' className='space-y-6'>
                  {outstandingSection}
                  <section className='space-y-4' aria-label='服务凭据'>
                    <div>
                      <h3 className='text-section font-semibold'>服务凭据</h3>
                      <p className='mt-1 text-small text-muted-foreground'>
                        多把 Key
                        共享调用额度和运行归属。展示信息与授权范围分别维护。
                      </p>
                    </div>
                    {!activeCredentials.length ? (
                      <EmptyState
                        title='尚无有效凭据'
                        description={
                          caller.archivedAt
                            ? '归档调用方不能再签发 Key。'
                            : '选择可调用能力与目标账号后签发 Key。'
                        }
                      />
                    ) : (
                      <div className='space-y-4'>
                        {activeCredentials.map((credential) => (
                          <CredentialCard
                            key={credential.id}
                            credential={credential}
                            writable={canWrite}
                            archived={!!caller.archivedAt}
                            onEditMetadata={setMetadataForm}
                            onEditPolicy={(value) =>
                              setKeyForm({ credential: value })
                            }
                            onRotate={(value) =>
                              setKeyForm({ credential: value, rotate: true })
                            }
                            onRevoke={setRevoking}
                            onSetSuspended={(credential, suspended) =>
                              setCredentialStatusIntent({
                                credential,
                                suspended,
                              })
                            }
                            onViewCatalog={setCatalogCredential}
                            onCopyReference={(value) =>
                              void copyCredentialReference(value)
                            }
                          />
                        ))}
                      </div>
                    )}
                    {inactiveCredentials.length ? (
                      <details
                        className='rounded-md border p-4'
                        open={showInactiveKeys}
                        onToggle={(event) =>
                          setShowInactiveKeys(event.currentTarget.open)
                        }
                      >
                        <summary className='cursor-pointer font-medium'>
                          已冻结、过期或已吊销的凭据（
                          {inactiveCredentials.length}）
                        </summary>
                        <div className='mt-4 space-y-4'>
                          {inactiveCredentials.map((credential) => (
                            <CredentialCard
                              key={credential.id}
                              credential={credential}
                              writable={canWrite}
                              archived={!!caller.archivedAt}
                              onEditMetadata={setMetadataForm}
                              onEditPolicy={(value) =>
                                setKeyForm({ credential: value })
                              }
                              onRotate={(value) =>
                                setKeyForm({ credential: value, rotate: true })
                              }
                              onRevoke={setRevoking}
                              onSetSuspended={(credential, suspended) =>
                                setCredentialStatusIntent({
                                  credential,
                                  suspended,
                                })
                              }
                              onViewCatalog={setCatalogCredential}
                              onCopyReference={(value) =>
                                void copyCredentialReference(value)
                              }
                            />
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </section>
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
                        网络重试沿用同一幂等键，返回同一个 Run。遇到 429 时按
                        Retry-After 退避。
                      </p>
                      <p>
                        仅已人工发布的业务输出和截图可供外部读取；Trace
                        与内部执行配置不对外提供。
                      </p>
                    </div>
                  </details>
                </TabsContent>
                <TabsContent value='logs' className='pt-1'>
                  {requestLogSection}
                </TabsContent>
                <TabsContent value='network' className='pt-1'>
                  {networkSection}
                </TabsContent>
                <TabsContent value='webhook' className='pt-1'>
                  <ServiceWebhookPanel
                    callerId={caller.id}
                    writable={canWrite}
                    archived={!!caller.archivedAt}
                  />
                </TabsContent>
                <TabsContent value='playground' className='pt-1'>
                  <ServicePlaygroundPanel
                    callerId={caller.id}
                    credentials={playgroundCredentials}
                    canRun={
                      canWrite &&
                      canExecuteRuns &&
                      canReadRuns &&
                      !caller.archivedAt
                    }
                  />
                </TabsContent>
              </Tabs>
            </section>
          ) : null)}
      </Main>
      {callerForm ? (
        <CallerDialog
          caller={callerForm === 'new' ? undefined : callerForm}
          onClose={() => setCallerForm(null)}
          onSaved={refresh}
        />
      ) : null}
      {keyForm && selected ? (
        <CredentialDialog
          callerId={selected}
          {...keyForm}
          onClose={() => setKeyForm(null)}
          onSaved={(value) => {
            refresh()
            if (value) setToken(value)
          }}
        />
      ) : null}
      {metadataForm && selected ? (
        <CredentialMetadataDialog
          callerId={selected}
          credential={metadataForm}
          onClose={() => setMetadataForm(null)}
          onSaved={refresh}
        />
      ) : null}
      {ipWhitelistForm && caller ? (
        <IpWhitelistDialog
          caller={caller}
          onClose={() => setIpWhitelistForm(false)}
          onSaved={refresh}
        />
      ) : null}
      {catalogCredential && selected ? (
        <CredentialCatalogSheet
          callerId={selected}
          credential={catalogCredential}
          onClose={() => setCatalogCredential(null)}
        />
      ) : null}
      {selectedLogId && selected ? (
        <RequestLogSheet
          callerId={selected}
          logId={selectedLogId}
          onClose={() => setSelectedLogId(undefined)}
        />
      ) : null}
      {token ? (
        <TokenDialog token={token} onClose={() => setToken(undefined)} />
      ) : null}
      <ConfirmDialog
        open={!!statusIntent}
        onOpenChange={(open) => {
          if (!open && action !== 'status') setStatusIntent(null)
        }}
        title={
          statusIntent?.target === 'active'
            ? `启用「${statusIntent.caller.name}」`
            : `停用「${statusIntent?.caller.name ?? ''}」`
        }
        desc={
          statusIntent?.target === 'active'
            ? '启用后，尚未过期且未吊销的 Key 可以继续接入。'
            : '停用会立即拒绝新的 API 接入；已接纳的运行继续执行并占用额度。'
        }
        confirmText={statusIntent?.target === 'active' ? '启用' : '停用'}
        handleConfirm={() => void changeStatus()}
        isLoading={action === 'status'}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={(open) => {
          if (!open && action !== 'archive') setArchiving(false)
        }}
        title='归档服务调用方'
        desc='归档会停止该调用方后续服务访问并保留历史；本期不提供恢复。必须先处理全部未结束运行。'
        confirmText='归档调用方'
        destructive
        handleConfirm={() => void archive()}
        isLoading={action === 'archive'}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open && action !== 'revoke') setRevoking(null)
        }}
        title='吊销服务凭据'
        desc={`吊销「${revoking?.name ?? ''}」后，该 Key 将无法再调用 API，且不能恢复。已接纳的运行继续执行。`}
        confirmText='吊销'
        destructive
        handleConfirm={() => void revoke()}
        isLoading={action === 'revoke'}
      />
      <ConfirmDialog
        open={!!credentialStatusIntent}
        onOpenChange={(open) => {
          if (!open && action !== 'suspend') setCredentialStatusIntent(null)
        }}
        title={
          credentialStatusIntent?.suspended
            ? `冻结「${credentialStatusIntent.credential.name}」`
            : `恢复「${credentialStatusIntent?.credential.name ?? ''}」`
        }
        desc={
          credentialStatusIntent?.suspended
            ? '冻结会立即拒绝这把 Key 的新服务请求；已接纳的运行继续执行。'
            : '恢复后，这把未过期且未吊销的 Key 可以立即重新接入。'
        }
        confirmText={
          credentialStatusIntent?.suspended ? '冻结凭据' : '恢复凭据'
        }
        handleConfirm={() => void changeCredentialStatus()}
        isLoading={action === 'suspend'}
      />
      <ConfirmDialog
        open={!!cancellingRun}
        onOpenChange={(open) => {
          if (!open && action !== 'cancel') setCancellingRun(null)
        }}
        title='请求取消运行'
        desc={`将向「${cancellingRun?.scenarioName ?? ''}」提交取消请求。若运行正持有租约，或副作用结果无法确认，它可能进入待核查并继续占用额度。`}
        confirmText='请求取消'
        destructive
        handleConfirm={() => void cancelRun()}
        isLoading={action === 'cancel'}
      />
    </>
  )
}
