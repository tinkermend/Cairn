import { TermEditor } from './term-editor'
import { useMemo, useRef, useState } from 'react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import type { MapAssetListItem, MapLifecycle } from '@cairn/shared'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchMapChanges,
  fetchMapObject,
  fetchMapObjects,
  fetchMapPages,
  fetchMapImpacts,
  fetchMapReferences,
  fetchMapSummary,
  fetchMapTerms,
  createMapTerm,
  previewMapGovernance,
  publishMapRelease,
  submitMapGovernance,
} from '@/lib/map-api'
import { fetchTarget } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { ConsumptionPolicyCard } from './consumption-policy'
import { AutoRefreshCard } from './auto-refresh'
import { ExplorationCard } from './exploration'
import { JobMaintenanceCard } from './job-maintenance'
import {
  MAP_DIMENSION_LABELS,
  MAP_GRADE_LABELS,
  MAP_LIFECYCLE_LABELS,
} from './labels'

const route = getRouteApi('/_authenticated/targets/$targetId/map/')

export function TargetMapPage() {
  const { targetId } = route.useParams()
  const queryClient = useQueryClient()
  const page = useCursorPage()
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'objects' | 'pages' | 'terms'>('objects')
  const [termName, setTermName] = useState('')
  const [termMeaning, setTermMeaning] = useState('')
  const [termAliases, setTermAliases] = useState('')
  const [selection, setSelected] = useState<MapAssetListItem | null>(null)
  const [reason, setReason] = useState('')
  const canReview = useCan('map:review')
  const canPublish = useCan('map:publish')
  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      limit: page.pageSize,
      cursor: page.cursor,
    }),
    [search, page.pageSize, page.cursor]
  )
  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
  })
  const summaryQuery = useQuery({
    queryKey: ['map', targetId, 'summary'],
    queryFn: () => fetchMapSummary(targetId),
  })
  const objectsQuery = useQuery({
    queryKey: ['map', targetId, kind, filters],
    queryFn: () =>
      kind === 'pages'
        ? fetchMapPages(targetId, filters)
        : fetchMapObjects(targetId, filters),
    enabled: kind !== 'terms',
    placeholderData: keepPreviousData,
  })
  const termsQuery = useQuery({
    queryKey: ['map', targetId, 'terms', filters],
    queryFn: () =>
      fetchMapTerms(targetId, {
        q: filters.search,
        limit: filters.limit,
        cursor: filters.cursor,
      }),
    enabled: kind === 'terms',
    placeholderData: keepPreviousData,
  })
  const termRequest = useRef<{ signature: string; key: string } | null>(null)
  const createTermMutation = useMutation({
    mutationFn: () => {
      const body = {
        canonicalName: termName.trim(),
        aliases: termAliases.split(/[,，]/).map(item => item.trim()).filter(Boolean),
        meaning: termMeaning.trim(),
        termStatus: 'candidate' as const,
      }
      const signature = JSON.stringify({ targetId, ...body })
      if (termRequest.current?.signature !== signature) termRequest.current = { signature, key: `term:${crypto.randomUUID()}` }
      return createMapTerm(targetId, { ...body, idempotencyKey: termRequest.current.key })
    },
    onSuccess: () => {
      termRequest.current = null
      toast.success('已保存术语')
      setTermName('')
      setTermMeaning('')
      setTermAliases('')
      void queryClient.invalidateQueries({
        queryKey: ['map', targetId, 'terms'],
      })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '保存术语失败'
      ),
  })
  const selected =
    objectsQuery.data?.items.find(
      (item) => item.assetRefKey === selection?.assetRefKey
    ) ?? selection
  const detailQuery = useQuery({
    queryKey: ['map', targetId, 'object', selected?.assetRef.objectId],
    queryFn: () => fetchMapObject(targetId, selected!.assetRef.objectId!),
    enabled: Boolean(selected?.assetRef.objectId),
  })
  const impactsQuery = useQuery({
    queryKey: ['map', targetId, 'impacts', selected?.assetRefKey],
    queryFn: () =>
      fetchMapImpacts(targetId, {
        assetRefKey: selected?.assetRefKey,
        limit: 20,
      }),
    enabled: Boolean(selected?.assetRefKey),
  })
  const referencesQuery = useQuery({
    queryKey: ['map', targetId, 'references'],
    queryFn: () => fetchMapReferences(targetId, { limit: 20 }),
  })
  const changesQuery = useQuery({
    queryKey: ['map', targetId, 'changes'],
    queryFn: () => fetchMapChanges(targetId, { limit: 20 }),
    enabled:
      (summaryQuery.data?.changeCount ?? 0) +
        (summaryQuery.data?.conflictCount ?? 0) >
      0,
  })
  const publishMutation = useMutation({
    mutationFn: () => {
      const viewRef = summaryQuery.data?.view.viewRef
      if (viewRef?.kind !== 'projection')
        throw new Error('没有可发布的知识投影')
      return publishMapRelease(targetId, {
        projectionId: viewRef.projectionId,
        expectedProjectionRevision: viewRef.revision,
        expectedPublicationRevision:
          summaryQuery.data?.view.publicationRevision ?? 0,
        idempotencyKey: `cmd:publish-${Date.now()}`,
        reason: reason.trim() || '发布当前知识版本',
      })
    },
    onSuccess: () => {
      toast.success('已发布此版本')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '发布失败'
      ),
  })
  const governanceMutation = useMutation({
    mutationFn: async (kind: 'confirm_semantics' | 'retire' | 'restore') => {
      const labels = {
        confirm_semantics: '确认语义',
        retire: '退役该对象',
        restore: '恢复投影原值',
      }
      const preview = await previewMapGovernance(targetId, {
        kind,
        evidenceRefs: [],
        reason: reason.trim() || labels[kind],
        expectedGovernanceRevision:
          summaryQuery.data?.view.governanceRevision ?? 0,
        assetRef: selected!.assetRef,
      })
      if (preview.rejectReasons.length) {
        throw new Error(preview.rejectReasons.join('；'))
      }
      return submitMapGovernance(targetId, {
        kind,
        evidenceRefs: [],
        reason: reason.trim() || labels[kind],
        expectedGovernanceRevision: preview.baseRevision,
        assetRef: selected!.assetRef,
        idempotencyKey: `cmd:${kind}-${Date.now()}`,
      })
    },
    onSuccess: (_data, kind) => {
      toast.success(
        kind === 'restore'
          ? '已恢复投影原值'
          : kind === 'retire'
            ? '已提交退役'
            : '已确认语义'
      )
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '治理提交失败')
      void summaryQuery.refetch()
    },
  })

  const items = objectsQuery.data?.items ?? []
  const summary = summaryQuery.data
  const publishDisabled =
    !canPublish ||
    !summary ||
    Boolean(summary.rebuildStatus) ||
    summary.projectionStatus === 'missing' ||
    !['active', 'ready'].includes(summary.projectionStatus) ||
    (summary.view.viewRef.kind === 'projection' &&
      summary.view.viewRef.cursor === 0) ||
    summary.view.viewRef.kind !== 'projection'
  const filteredEmpty =
    Boolean(search.trim()) && items.length === 0 && objectsQuery.isSuccess

  return (
    <>
      <AppHeader
        fixed
        leading={
          <Link
            to='/targets/$targetId'
            params={{ targetId }}
            className='me-auto flex items-center gap-2 text-small text-muted-foreground hover:text-link'
          >
            <ArrowLeft className='size-4' />
            返回目标系统
          </Link>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='目标知识'
          description={
            <span>
              <Link to='/targets' className='text-primary hover:underline'>
                目标系统
              </Link>
              {targetQuery.data ? ` / ${targetQuery.data.name}` : ''}
              {' · 查看已认识的页面、对象、条件和受影响场景'}
            </span>
          }
          actions={
            <div className='flex gap-2'>
              <Button
                variant='outline'
                onClick={() => {
                  page.reset()
                  void queryClient.invalidateQueries({
                    queryKey: ['map', targetId],
                  })
                }}
              >
                刷新知识
              </Button>
              <Can permission='map:publish'>
                <Button
                  disabled={publishDisabled || publishMutation.isPending}
                  onClick={() => publishMutation.mutate()}
                >
                  发布此版本
                </Button>
              </Can>
            </div>
          }
        />
        {summaryQuery.isPending || objectsQuery.isPending ? (
          <PageSkeleton />
        ) : summaryQuery.isError ? (
          <QueryErrorState
            description={summaryQuery.error?.message}
            onRetry={() => void summaryQuery.refetch()}
          />
        ) : (
          <>
            <ConsumptionPolicyCard targetId={targetId} />
            <JobMaintenanceCard targetId={targetId} />
            <AutoRefreshCard targetId={targetId} />
            <ExplorationCard targetId={targetId} />
            {summary?.projectionStatus === 'missing' ||
            summary?.view.viewRef.kind === 'missing' ? (
              <Alert>
                <AlertDescription>
                  还没有知识投影。列表为空，不能发布。
                </AlertDescription>
              </Alert>
            ) : null}
            {summary?.rebuildStatus ? (
              <Alert>
                <AlertDescription>
                  {summary.rebuildStatus === 'failed'
                    ? '新投影重建失败。'
                    : '新投影重建中。'}
                  当前显示旧投影，完成后请刷新知识。
                </AlertDescription>
              </Alert>
            ) : null}
            {summary?.projectionStatus === 'failed' ? (
              <Alert>
                <AlertDescription>
                  投影处理失败。列表仍可读上次结果，但不能发布。
                </AlertDescription>
              </Alert>
            ) : null}
            {summary?.projectionStatus === 'shadow' ||
            summary?.rebuildCompleteness === 'partial' ? (
              <Alert>
                <AlertDescription>
                  {summary.projectionStatus === 'shadow'
                    ? '投影重建中。'
                    : '证据已过保留期，重建结果不完整。'}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className='grid gap-3 sm:grid-cols-4'>
              <Card>
                <CardHeader>
                  <CardTitle>页面</CardTitle>
                </CardHeader>
                <CardContent>{summary?.pageCount ?? 0}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>对象</CardTitle>
                </CardHeader>
                <CardContent>{summary?.objectCount ?? 0}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>冲突</CardTitle>
                </CardHeader>
                <CardContent>{summary?.conflictCount ?? 0}</CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>发布</CardTitle>
                </CardHeader>
                <CardContent>
                  {summary?.publicationStatus === 'published'
                    ? '已发布'
                    : '未发布'}
                </CardContent>
              </Card>
            </div>
            {(summary?.changeCount ?? 0) + (summary?.conflictCount ?? 0) > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>待复核变更</CardTitle>
                </CardHeader>
                <CardContent className='space-y-2'>
                  {(changesQuery.data?.items ?? []).length === 0 ? (
                    <p className='text-small text-muted-foreground'>
                      变化仍在加载，或当前页没有可见项。
                    </p>
                  ) : (
                    <ul className='space-y-1'>
                      {(changesQuery.data?.items ?? []).map((item, index) => (
                        <li
                          key={`${item.kind}-${item.assetRefKey ?? item.conflictKey ?? index}`}
                        >
                          {item.kind === 'conflict'
                            ? `未关闭冲突 ${item.conflictKey}`
                            : `${item.assetRefKey} · ${item.changeCount ?? 0} 次变化`}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ) : null}
            <Card>
              <CardHeader className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                <CardTitle>查看知识</CardTitle>
                <div className='flex flex-wrap items-center gap-2'>
                  <div
                    className='flex gap-1'
                    role='tablist'
                    aria-label='知识类型'
                  >
                    <Button
                      size='sm'
                      variant={kind === 'objects' ? 'default' : 'outline'}
                      onClick={() => {
                        setKind('objects')
                        setSelected(null)
                        page.reset()
                      }}
                    >
                      对象
                    </Button>
                    <Button
                      size='sm'
                      variant={kind === 'pages' ? 'default' : 'outline'}
                      onClick={() => {
                        setKind('pages')
                        setSelected(null)
                        page.reset()
                      }}
                    >
                      页面
                    </Button>
                    <Button
                      size='sm'
                      variant={kind === 'terms' ? 'default' : 'outline'}
                      onClick={() => {
                        setKind('terms')
                        setSelected(null)
                        page.reset()
                      }}
                    >
                      术语
                    </Button>
                  </div>
                  <Input
                    aria-label={kind === 'terms' ? '搜索术语' : '搜索对象'}
                    placeholder={
                      kind === 'terms' ? '搜索规范名或别名' : '搜索名称或路径'
                    }
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value)
                      page.reset()
                    }}
                    className='sm:max-w-xs'
                  />
                </div>
              </CardHeader>
              <CardContent className='space-y-3'>
                {kind === 'terms' ? (
                  <>
                    {canReview ? (
                      <div className='grid gap-2 sm:grid-cols-2'>
                        <Input
                          aria-label='术语名称'
                          placeholder='规范名，如销售订单'
                          value={termName}
                          onChange={(event) => setTermName(event.target.value)}
                        />
                        <Input
                          aria-label='术语别名'
                          placeholder='别名，逗号分隔'
                          value={termAliases}
                          onChange={(event) =>
                            setTermAliases(event.target.value)
                          }
                        />
                        <Input
                          aria-label='术语含义'
                          placeholder='业务含义'
                          value={termMeaning}
                          onChange={(event) =>
                            setTermMeaning(event.target.value)
                          }
                          className='sm:col-span-2'
                        />
                        <Button
                          size='sm'
                          disabled={
                            !termName.trim() ||
                            !termMeaning.trim() ||
                            createTermMutation.isPending
                          }
                          loading={createTermMutation.isPending}
                          onClick={() => createTermMutation.mutate()}
                        >
                          保存术语
                        </Button>
                      </div>
                    ) : null}
                    {termsQuery.isError ? (
                      <QueryErrorState
                        description={termsQuery.error?.message}
                        onRetry={() => {
                          page.reset()
                          void termsQuery.refetch()
                        }}
                      />
                    ) : (termsQuery.data?.items ?? []).length === 0 ? (
                      <EmptyState
                        title={
                          search.trim() ? '没有符合筛选的术语' : '还没有术语'
                        }
                        description='先登记业务名称和别名，编写建议才不会把同名对象混在一起。'
                      />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>术语</TableHead>
                            <TableHead>别名</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(termsQuery.data?.items ?? []).map((term) => (
                            <TableRow key={term.termId}>
                              <TableCell>
                                <div className='font-medium'>
                                  {term.canonicalName}
                                </div>
                                <div className='text-small text-muted-foreground'>
                                  {term.meaning}
                                </div>
                              </TableCell>
                              <TableCell>
                                {term.aliases.join('、') || '—'}
                              </TableCell>
                              <TableCell>
                                <StatusBadge
                                  tone={
                                    term.termStatus === 'retired'
                                      ? 'warning'
                                      : term.termStatus === 'confirmed'
                                        ? 'success'
                                        : 'neutral'
                                  }
                                >
                                  {term.termStatus === 'confirmed'
                                    ? '已确认'
                                    : term.termStatus === 'retired'
                                      ? '已退役'
                                      : '候选'}
                                </StatusBadge>
                              </TableCell>
                              <TableCell><TermEditor term={term} canReview={canReview} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </>
                ) : objectsQuery.isError ? (
                  <QueryErrorState
                    description={objectsQuery.error?.message}
                    onRetry={() => {
                      page.reset()
                      void objectsQuery.refetch()
                    }}
                  />
                ) : items.length === 0 ? (
                  <EmptyState
                    title={
                      filteredEmpty ? '没有符合筛选的对象' : '还没有目标知识'
                    }
                    description={
                      filteredEmpty
                        ? '试试清空搜索，或换一个条件。'
                        : '运行和录制产生观察后，这里才会出现可复用的页面和对象。'
                    }
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>对象</TableHead>
                        <TableHead>路径</TableHead>
                        <TableHead>生命周期</TableHead>
                        <TableHead>验证</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow
                          key={item.assetRefKey}
                          data-state={
                            selected?.assetRefKey === item.assetRefKey
                              ? 'selected'
                              : undefined
                          }
                          className='cursor-pointer'
                          onClick={() => setSelected(item)}
                        >
                          <TableCell>
                            <button
                              type='button'
                              className='text-left text-link underline-offset-4 hover:underline focus-visible:underline'
                              onClick={() => setSelected(item)}
                            >
                              {item.name ??
                                item.assetRef.objectId ??
                                item.routeTemplate ??
                                item.assetRefKey}
                            </button>
                          </TableCell>
                          <TableCell className='max-w-[16rem] truncate'>
                            {item.routeTemplate ?? '—'}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              tone={
                                item.lifecycle === 'RETIRED'
                                  ? 'warning'
                                  : item.lifecycle === 'TRUSTED'
                                    ? 'success'
                                    : 'neutral'
                              }
                            >
                              {MAP_LIFECYCLE_LABELS[
                                item.lifecycle as MapLifecycle
                              ] ?? item.lifecycle}
                            </StatusBadge>
                          </TableCell>
                          <TableCell>
                            {item.unknownFields.length
                              ? `未知 ${item.unknownFields.join('、')}`
                              : item.dimensions.length
                                ? item.dimensions
                                    .map(
                                      (dimension) =>
                                        `${MAP_DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension}:${dimension.verdict}`
                                    )
                                    .join(' · ')
                                : '尚未判断该条件下是否适用'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <CursorPagination
                  pageIndex={page.pageIndex}
                  pageSize={page.pageSize}
                  hasPreviousPage={page.pageIndex > 0}
                  hasNextPage={Boolean(
                    kind === 'terms'
                      ? termsQuery.data?.nextCursor
                      : objectsQuery.data?.nextCursor
                  )}
                  updating={
                    kind === 'terms'
                      ? termsQuery.isFetching && termsQuery.isPlaceholderData
                      : objectsQuery.isFetching &&
                        objectsQuery.isPlaceholderData
                  }
                  onPageSizeChange={page.setPageSize}
                  onPreviousPage={page.goPrev}
                  onNextPage={() => {
                    const cursor =
                      kind === 'terms'
                        ? termsQuery.data?.nextCursor
                        : objectsQuery.data?.nextCursor
                    if (cursor) page.goNext(cursor)
                  }}
                />
              </CardContent>
            </Card>
            <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]'>
              <Card>
                <CardHeader>
                  <CardTitle>
                    {selected ? '对象详情' : '选择一个对象'}
                  </CardTitle>
                </CardHeader>
                <CardContent className='space-y-3'>
                  {!selected ? (
                    <p className='text-small text-muted-foreground'>
                      选择一个对象，查看适用条件、验证结果和变更影响。
                    </p>
                  ) : !selected.assetRef.objectId ? (
                    <p className='break-all'>
                      页面路径：{selected.routeTemplate ?? '未知'}
                      。切换到对象列表查看页面内对象的实现与验证。
                    </p>
                  ) : detailQuery.isPending ? (
                    <PageSkeleton />
                  ) : detailQuery.isError ? (
                    <QueryErrorState
                      description={detailQuery.error?.message}
                      onRetry={() => void detailQuery.refetch()}
                    />
                  ) : (
                    <>
                      <p>
                        身份：
                        {detailQuery.data?.identityHistory.length
                          ? '有纠正历史'
                          : '尚无纠正'}
                      </p>
                      <p>
                        适用条件：
                        {detailQuery.data?.applicability === 'satisfied'
                          ? '该条件下适用'
                          : detailQuery.data?.applicability === 'unsatisfied'
                            ? '该条件下不适用'
                            : detailQuery.data?.implementations[0]
                                  ?.conditionUnknownFields.length
                              ? `未知 ${detailQuery.data.implementations[0].conditionUnknownFields.join('、')}`
                              : '尚未判断该条件下是否适用'}
                      </p>
                      <div className='space-y-2'>
                        <p>条件实现</p>
                        {detailQuery.data?.implementations.map((item) => (
                          <div
                            key={`${item.implementationKey}:${item.descriptorVersion ?? 0}`}
                            className='space-y-1 text-small'
                          >
                            <p className='break-all'>
                              {item.semanticName ?? item.implementationKey} ·
                              版本 {item.descriptorVersion ?? '未知'}
                            </p>
                            <p>
                              语言：{item.locale ?? '未知'} · 工作区：
                              {item.workspace ?? '未知'} · 视口：
                              {item.conditionSnapshot?.viewport?.category ??
                                '未知'}
                            </p>
                            {item.conditionUnknownFields.length ? (
                              <p className='text-muted-foreground'>
                                未确认条件：
                                {item.conditionUnknownFields.join('、')}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <p>
                        验证维度：
                        {detailQuery.data?.dimensions.length
                          ? detailQuery.data.dimensions
                              .map(
                                (item) =>
                                  `${MAP_DIMENSION_LABELS[item.dimension] ?? item.dimension} ${item.verdict}`
                              )
                              .join('；')
                          : '未知'}
                      </p>
                      <p>
                        来源证据：
                        {detailQuery.data?.evidenceAvailability === 'available'
                          ? '有持久化证据记录'
                          : detailQuery.data?.evidenceAvailability === 'partial'
                            ? '部分可用'
                            : '已过保留期或不可用'}
                      </p>
                      {canReview ? (
                        <div className='flex flex-col gap-2'>
                          <Input
                            aria-label='治理理由'
                            placeholder='说明为何确认、退役或恢复'
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                          <div className='flex flex-col gap-2 sm:flex-row'>
                            <Button
                              variant='outline'
                              disabled={governanceMutation.isPending}
                              onClick={() =>
                                governanceMutation.mutate('confirm_semantics')
                              }
                            >
                              确认语义
                            </Button>
                            <Button
                              variant='outline'
                              disabled={governanceMutation.isPending}
                              onClick={() =>
                                governanceMutation.mutate('retire')
                              }
                            >
                              退役对象
                            </Button>
                            {selected.overlayLifecycle ? (
                              <Button
                                variant='outline'
                                disabled={governanceMutation.isPending}
                                onClick={() =>
                                  governanceMutation.mutate('restore')
                                }
                              >
                                恢复原值
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>受影响场景</CardTitle>
                </CardHeader>
                <CardContent className='space-y-2'>
                  {impactsQuery.data?.restricted ||
                  referencesQuery.data?.restricted ? (
                    <Alert>
                      <AlertDescription>结果受权限限制</AlertDescription>
                    </Alert>
                  ) : null}
                  {(impactsQuery.data?.items ?? []).length === 0 ? (
                    <p className='text-small text-muted-foreground'>
                      没有可见的确切引用。扫描候选不会自动算作影响。
                    </p>
                  ) : (
                    <ul className='space-y-2'>
                      {(impactsQuery.data?.items ?? []).map((item, index) => (
                        <li key={`${item.scenarioId ?? 'x'}-${index}`}>
                          {MAP_GRADE_LABELS[item.grade]} ·{' '}
                          {item.scenarioName ?? '（无名称）'}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </Main>
    </>
  )
}
