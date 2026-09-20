import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  ATTEMPT_STATUSES,
  EVIDENCE_AVAILABILITY_FILTER_LABELS,
  EVIDENCE_SEARCH_VIEW_LABELS,
  EVIDENCE_SEARCH_VIEWS,
  EVIDENCE_TYPE_LABELS,
  EVIDENCE_TYPES,
  OUTCOME_STATUSES,
  RUN_EVIDENCE_STATUSES,
  RUN_STATUSES,
  STEP_RUN_STATUSES,
  type AttemptStatus,
  type EvidenceAvailabilityFilter,
  type EvidenceSearchItem,
  type EvidenceType,
  type OutcomeStatus,
  type RunEvidenceStatus,
  type RunStatus,
  type StepRunStatus,
} from '@cairn/shared'
import { Columns3, FileSearch, RefreshCw, X } from 'lucide-react'
import {
  fetchEvidenceDetail,
  fetchEvidenceRetentionObjects,
  fetchEvidenceRetentionSummary,
  fetchEvidenceSearch,
} from '@/lib/evidence-api'
import { fetchReports } from '@/lib/reports-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargets, fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CollectionSummary } from '@/components/collection-summary'
import { CursorPagination } from '@/components/data-table'
import { DateRangePicker } from '@/components/date-range-picker'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { TruncatedText } from '@/components/truncated-text'
import {
  RUN_STATUS_LABELS,
  ATTEMPT_STATUS_LABELS,
  STEP_RUN_STATUS_LABELS,
  RUN_EVIDENCE_STATUS_LABELS,
} from '@/features/runs/labels'
import { buildActiveFilters } from './active-filters'
import {
  OPTIONAL_COLUMN_LABELS,
  OPTIONAL_COLUMNS,
  parseOptionalColumns,
  type OptionalColumn,
} from './columns'
import { EvidenceDetailBody } from './detail-panel'
import {
  CANDIDATE_REASON_LABELS,
  formatKnownBytes,
  formatWhen,
  OUTCOME_STATUS_LABELS,
  RETENTION_VIEW_LABELS,
} from './labels'
import { csvList, toggleCsv, type EvidencePageSearch } from './search-state'
import { EvidenceThumb } from './thumb'

const EVIDENCE_PAGE_SIZES = [20, 50, 100] as const
const RETENTION_PAGE_SIZES = [20] as const

function StatusFilterMenu({
  label,
  values,
  options,
  labels,
  onToggle,
}: {
  label: string
  values: string[]
  options: readonly string[]
  labels: Record<string, string>
  onToggle: (value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size='sm'
          variant={values.length > 0 ? 'secondary' : 'outline'}
          aria-label={label}
        >
          {label}
          {values.length > 0 ? ` · ${values.length}` : ''}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={values.includes(option)}
            onCheckedChange={() => onToggle(option)}
          >
            {labels[option] ?? option}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function useDesktop() {
  const [desktop, setDesktop] = useState(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia('(min-width: 1024px)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setDesktop(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return desktop
}

export function EvidencePage() {
  const search = useSearch({ strict: false }) as EvidencePageSearch
  const navigate = useNavigate()
  const tab =
    search.tab === 'retention'
      ? 'retention'
      : search.tab === 'reports'
        ? 'reports'
        : 'search'
  const patch = (
    next: Partial<EvidencePageSearch>,
    options?: { replace?: boolean }
  ) => {
    void navigate({
      to: '/evidence',
      replace: options?.replace,
      search: {
        ...search,
        ...next,
        ...('cursor' in next ? {} : { cursor: undefined }),
        ...('retentionCursor' in next
          ? {}
          : next.tab || next.retentionView
            ? { retentionCursor: undefined }
            : {}),
      },
    })
  }

  return (
    <Main className='flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden sm:gap-6'>
      <PageHeader
        className='shrink-0'
        title='证据与报告'
        description='跨运行查找截图、录像、Trace 与结构化证据，并查看报告与留存清理事实。此处只接受结构化筛选，不提供关键词检索。'
        actions={
          <Button
            variant='outline'
            onClick={() => {
              patch({
                asOf: undefined,
                cursor: undefined,
                retentionCursor: undefined,
                selected: undefined,
              })
            }}
          >
            <RefreshCw className='size-4' />
            刷新
          </Button>
        }
      />
      <Tabs
        value={tab}
        activationMode='manual'
        className='flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden'
        onValueChange={(value) => {
          patch({
            tab:
              value === 'retention'
                ? 'retention'
                : value === 'reports'
                  ? 'reports'
                  : 'search',
          })
        }}
      >
        <TabsList className='shrink-0'>
          <TabsTrigger value='search'>证据检索</TabsTrigger>
          <TabsTrigger value='reports'>报告</TabsTrigger>
          <TabsTrigger value='retention'>留存与清理</TabsTrigger>
        </TabsList>
        {tab === 'retention' ? (
          <RetentionPanel search={search} patch={patch} />
        ) : tab === 'reports' ? (
          <ReportsCenterPanel
            key={[
              search.targetId,
              search.runId,
              search.suiteRunId,
              search.suiteId,
            ].join(':')}
            search={search}
          />
        ) : (
          <SearchPanel search={search} patch={patch} />
        )}
      </Tabs>
    </Main>
  )
}

/** 可选列的单元格。没有对象的结构化证据没有体积和期限，写“—”，不写成未知。 */
function optionalCell(column: OptionalColumn, item: EvidenceSearchItem) {
  switch (column) {
    case 'size':
      return item.objectLinked
        ? formatKnownBytes(item.byteSize, item.byteSizeUnknown)
        : '—'
    case 'expires':
      if (!item.objectLinked) return '—'
      return item.retainUntilUnknown || !item.retainUntil
        ? '未记录'
        : formatWhen(item.retainUntil)
    case 'version':
      return item.scenarioVersionNo != null
        ? `v${item.scenarioVersionNo}${item.scenarioVersionKind === 'trial' ? ' · 试跑' : ''}`
        : '—'
    case 'released':
      return item.evidence.externalAccess ? (
        <StatusBadge tone='neutral'>已对外发布</StatusBadge>
      ) : (
        '—'
      )
  }
}

function SearchPanel({
  search,
  patch,
}: {
  search: EvidencePageSearch
  patch: (
    next: Partial<EvidencePageSearch>,
    options?: { replace?: boolean }
  ) => void
}) {
  const navigate = useNavigate()
  const desktop = useDesktop()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const queryInput = useMemo(
    () => ({
      asOf: search.asOf,
      timePreset: search.timePreset,
      createdFrom: search.createdFrom,
      createdTo: search.createdTo,
      timeZone,
      targetId: search.targetId,
      targetAccountId: search.targetAccountId,
      scenarioId: search.scenarioId,
      scenarioVersionId: search.scenarioVersionId,
      isTrial: search.isTrial,
      runId: search.runId,
      suiteId: search.suiteId,
      suiteRunId: search.suiteRunId,
      memberId: search.memberId,
      evidenceId: search.evidenceId,
      stepRunId: search.stepRunId,
      attemptId: search.attemptId,
      types: csvList(search.types) as EvidenceType[] | undefined,
      runStatuses: csvList(search.runStatuses) as RunStatus[] | undefined,
      stepRunStatuses: csvList(search.stepRunStatuses) as
        StepRunStatus[] | undefined,
      attemptStatuses: csvList(search.attemptStatuses) as
        AttemptStatus[] | undefined,
      outcomeStatuses: csvList(search.outcomeStatuses) as
        OutcomeStatus[] | undefined,
      runEvidenceStatuses: csvList(search.runEvidenceStatuses) as
        RunEvidenceStatus[] | undefined,
      availability: csvList(search.availability) as
        EvidenceAvailabilityFilter[] | undefined,
      view: search.view,
      released: search.released,
      limit: search.limit ?? 20,
      cursor: search.cursor,
    }),
    [search, timeZone]
  )
  const listed = useQuery({
    queryKey: ['evidence', 'search', queryInput],
    queryFn: () => fetchEvidenceSearch(queryInput),
    placeholderData: keepPreviousData,
  })
  useEffect(() => {
    // 自动补上的 asOf 只是把本次读取时刻写进地址，不是用户的一次导航：用 replace，
    // 否则后退会回到无 asOf 的地址，再被这里推一次，形成后退陷阱。
    if (listed.data?.asOf && !search.asOf)
      patch({ asOf: listed.data.asOf }, { replace: true })
  }, [listed.data?.asOf, patch, search.asOf])

  const targets = useQuery({
    queryKey: ['targets', 'evidence'],
    queryFn: () => fetchTargets({ limit: 100 }),
  })
  const scenarios = useQuery({
    queryKey: ['scenarios', 'evidence'],
    queryFn: () => fetchScenarios({ limit: 100 }),
  })
  const accounts = useQuery({
    queryKey: ['target-accounts', search.targetId],
    queryFn: () => fetchTargetAccounts(search.targetId!, { limit: 100 }),
    enabled: Boolean(search.targetId),
  })
  const selected = search.selected
  const detail = useQuery({
    queryKey: ['evidence', 'detail', selected],
    queryFn: () => fetchEvidenceDetail(selected!),
    enabled: Boolean(selected) && desktop,
  })

  const items = listed.data?.items ?? []
  const types = csvList(search.types) ?? []
  const runStatuses = csvList(search.runStatuses) ?? []
  const stepRunStatuses = csvList(search.stepRunStatuses) ?? []
  const attemptStatuses = csvList(search.attemptStatuses) ?? []
  const outcomeStatuses = csvList(search.outcomeStatuses) ?? []
  const runEvidenceStatuses = csvList(search.runEvidenceStatuses) ?? []
  const availability = csvList(search.availability) ?? []
  const filterNames = useMemo(
    () => ({
      targets: new Map(
        (targets.data?.items ?? []).map((item) => [item.id, item.name] as const)
      ),
      accounts: new Map(
        (accounts.data?.items ?? []).map(
          (item) => [item.id, item.displayName] as const
        )
      ),
      scenarios: new Map(
        (scenarios.data?.items ?? []).map(
          (item) => [item.id, item.name] as const
        )
      ),
    }),
    [targets.data, accounts.data, scenarios.data]
  )
  const activeFilters = useMemo(
    () => buildActiveFilters(search, filterNames),
    [search, filterNames]
  )
  const hasStructuredFilters = activeFilters.length > 0
  const optionalColumns = parseOptionalColumns(search.columns)
  const resetFilters = () =>
    patch({
      view: undefined,
      timePreset: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      targetId: undefined,
      targetAccountId: undefined,
      scenarioId: undefined,
      scenarioVersionId: undefined,
      isTrial: undefined,
      runId: undefined,
      suiteId: undefined,
      suiteRunId: undefined,
      memberId: undefined,
      evidenceId: undefined,
      stepRunId: undefined,
      attemptId: undefined,
      types: undefined,
      runStatuses: undefined,
      stepRunStatuses: undefined,
      attemptStatuses: undefined,
      outcomeStatuses: undefined,
      runEvidenceStatuses: undefined,
      availability: undefined,
      released: undefined,
      cursor: undefined,
      selected: undefined,
    })
  const openItem = (evidenceId: string) => {
    if (desktop) patch({ selected: evidenceId })
    else {
      void navigate({
        to: '/evidence/$evidenceId',
        params: { evidenceId },
        search,
      })
    }
  }

  return (
    <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden'>
      <div className='flex shrink-0 flex-wrap gap-2'>
        <Button
          size='sm'
          variant={!search.view ? 'secondary' : 'outline'}
          onClick={() => patch({ view: undefined })}
        >
          全部
        </Button>
        {EVIDENCE_SEARCH_VIEWS.map((view) => (
          <Button
            key={view}
            size='sm'
            variant={search.view === view ? 'secondary' : 'outline'}
            onClick={() =>
              patch({ view: search.view === view ? undefined : view })
            }
          >
            {EVIDENCE_SEARCH_VIEW_LABELS[view]}
          </Button>
        ))}
      </div>
      <div className='flex shrink-0 flex-wrap items-center gap-2'>
        <Select
          value={
            search.timePreset ??
            (search.createdFrom || search.createdTo ? 'custom' : '7d')
          }
          onValueChange={(value) => {
            patch({
              timePreset: value as EvidencePageSearch['timePreset'],
              createdFrom: value === 'custom' ? search.createdFrom : undefined,
              createdTo: value === 'custom' ? search.createdTo : undefined,
            })
          }}
        >
          <SelectTrigger className='h-8 w-36' aria-label='时间范围'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='24h'>最近 24 小时</SelectItem>
            <SelectItem value='7d'>最近 7 天</SelectItem>
            <SelectItem value='30d'>最近 30 天</SelectItem>
            <SelectItem value='custom'>自定义</SelectItem>
          </SelectContent>
        </Select>
        {search.timePreset === 'custom' ||
        search.createdFrom ||
        search.createdTo ? (
          <DateRangePicker
            value={{
              from: search.createdFrom
                ? new Date(search.createdFrom)
                : undefined,
              to: search.createdTo ? new Date(search.createdTo) : undefined,
            }}
            onChange={(range) => {
              patch({
                timePreset: 'custom',
                createdFrom: range?.from?.toISOString(),
                createdTo: range?.to?.toISOString(),
              })
            }}
          />
        ) : null}
        <Select
          value={search.targetId ?? 'all'}
          onValueChange={(value) =>
            patch({
              targetId: value === 'all' ? undefined : value,
              targetAccountId: undefined,
            })
          }
        >
          <SelectTrigger className='h-8 w-44' aria-label='目标系统'>
            <SelectValue placeholder='全部目标' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部目标</SelectItem>
            {(targets.data?.items ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.targetAccountId ?? 'all'}
          onValueChange={(value) =>
            patch({ targetAccountId: value === 'all' ? undefined : value })
          }
        >
          <SelectTrigger className='h-8 w-44' aria-label='目标账号'>
            <SelectValue placeholder='全部账号' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部账号</SelectItem>
            {(accounts.data?.items ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={search.scenarioId ?? 'all'}
          onValueChange={(value) =>
            patch({
              scenarioId: value === 'all' ? undefined : value,
              scenarioVersionId: undefined,
            })
          }
        >
          <SelectTrigger className='h-8 w-44' aria-label='场景'>
            <SelectValue placeholder='全部场景' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部场景</SelectItem>
            {(scenarios.data?.items ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={
            search.isTrial == null
              ? 'all'
              : search.isTrial
                ? 'trial'
                : 'published'
          }
          onValueChange={(value) =>
            patch({ isTrial: value === 'all' ? undefined : value === 'trial' })
          }
        >
          <SelectTrigger className='h-8 w-32' aria-label='运行种类'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>正式与试跑</SelectItem>
            <SelectItem value='published'>正式运行</SelectItem>
            <SelectItem value='trial'>试跑</SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label='场景集 ID'
          className='h-8 w-44'
          placeholder='场景集 ID'
          value={search.suiteId ?? ''}
          onChange={(event) =>
            patch({ suiteId: event.target.value || undefined })
          }
        />
        <Input
          aria-label='集合运行 ID'
          className='h-8 w-44'
          placeholder='集合运行 ID'
          value={search.suiteRunId ?? ''}
          onChange={(event) =>
            patch({
              suiteRunId: event.target.value || undefined,
              memberId: event.target.value ? search.memberId : undefined,
            })
          }
        />
        <Input
          aria-label='运行 ID'
          placeholder='运行 ID'
          className='h-8 w-56'
          value={search.runId ?? ''}
          onChange={(event) =>
            patch({ runId: event.target.value.trim() || undefined })
          }
        />
        <Input
          aria-label='证据 ID'
          placeholder='证据 ID'
          className='h-8 w-56'
          value={search.evidenceId ?? ''}
          onChange={(event) =>
            patch({ evidenceId: event.target.value.trim() || undefined })
          }
        />
        <Input
          aria-label='步骤运行 ID'
          placeholder='步骤运行 ID'
          className='h-8 w-56'
          value={search.stepRunId ?? ''}
          onChange={(event) =>
            patch({ stepRunId: event.target.value.trim() || undefined })
          }
        />
        <Input
          aria-label='尝试 ID'
          placeholder='尝试 ID'
          className='h-8 w-56'
          value={search.attemptId ?? ''}
          onChange={(event) =>
            patch({ attemptId: event.target.value.trim() || undefined })
          }
        />
        {hasStructuredFilters ? (
          <Button size='sm' variant='ghost' onClick={resetFilters}>
            重置筛选
          </Button>
        ) : null}
      </div>
      <div className='flex shrink-0 flex-wrap gap-2'>
        {EVIDENCE_TYPES.map((type) => (
          <Button
            key={type}
            size='sm'
            variant={types.includes(type) ? 'secondary' : 'outline'}
            aria-pressed={types.includes(type)}
            onClick={() => patch({ types: toggleCsv(search.types, type) })}
          >
            {EVIDENCE_TYPE_LABELS[type]}
          </Button>
        ))}
        {(
          [
            'available',
            'collecting',
            'capture_upload_anomaly',
            'purged',
            'expiring_soon',
            'due_for_purge',
            'purge_failed',
            'released',
          ] as const
        ).map((item) => (
          <Button
            key={item}
            size='sm'
            variant={availability.includes(item) ? 'secondary' : 'outline'}
            aria-pressed={availability.includes(item)}
            onClick={() =>
              patch({ availability: toggleCsv(search.availability, item) })
            }
          >
            {EVIDENCE_AVAILABILITY_FILTER_LABELS[item]}
          </Button>
        ))}
        <StatusFilterMenu
          label='运行状态'
          values={runStatuses}
          options={RUN_STATUSES}
          labels={RUN_STATUS_LABELS}
          onToggle={(value) =>
            patch({ runStatuses: toggleCsv(search.runStatuses, value) })
          }
        />
        <StatusFilterMenu
          label='步骤状态'
          values={stepRunStatuses}
          options={STEP_RUN_STATUSES}
          labels={STEP_RUN_STATUS_LABELS}
          onToggle={(value) =>
            patch({ stepRunStatuses: toggleCsv(search.stepRunStatuses, value) })
          }
        />
        <StatusFilterMenu
          label='尝试状态'
          values={attemptStatuses}
          options={ATTEMPT_STATUSES}
          labels={ATTEMPT_STATUS_LABELS}
          onToggle={(value) =>
            patch({ attemptStatuses: toggleCsv(search.attemptStatuses, value) })
          }
        />
        <StatusFilterMenu
          label='业务结果'
          values={outcomeStatuses}
          options={OUTCOME_STATUSES}
          labels={OUTCOME_STATUS_LABELS}
          onToggle={(value) =>
            patch({ outcomeStatuses: toggleCsv(search.outcomeStatuses, value) })
          }
        />
        <StatusFilterMenu
          label='运行证据完整性'
          values={runEvidenceStatuses}
          options={RUN_EVIDENCE_STATUSES}
          labels={RUN_EVIDENCE_STATUS_LABELS}
          onToggle={(value) =>
            patch({
              runEvidenceStatuses: toggleCsv(search.runEvidenceStatuses, value),
            })
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size='sm' variant='outline' aria-label='显示列'>
              <Columns3 className='size-4' aria-hidden />
              显示列
              {optionalColumns.length > 0 ? ` · ${optionalColumns.length}` : ''}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {OPTIONAL_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={optionalColumns.includes(column)}
                // 只改显示，不动翻页位置。
                onCheckedChange={() =>
                  patch({
                    columns: toggleCsv(search.columns, column),
                    cursor: search.cursor,
                  })
                }
              >
                {OPTIONAL_COLUMN_LABELS[column]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {activeFilters.length > 0 ? (
        <ul
          aria-label='已生效筛选'
          className='flex shrink-0 flex-wrap items-center gap-2'
        >
          {activeFilters.map((filter) => (
            <li
              key={filter.id}
              className='inline-flex max-w-full items-center gap-1 rounded-sm border border-border-card bg-card py-0.5 ps-2 pe-0.5 text-label'
            >
              <span className='truncate'>{filter.label}</span>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                className='size-5'
                aria-label={`清除筛选：${filter.label}`}
                onClick={() => patch(filter.clear)}
              >
                <X className='size-3' aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {listed.data?.timeWindowLifted ? (
        <p className='shrink-0 text-label text-muted-foreground'>
          已按完整 ID 或预置视图解除默认时间窗。
        </p>
      ) : null}
      {listed.data ? (
        <p className='shrink-0 text-label text-muted-foreground'>
          读取于 {formatWhen(listed.data.readAt)} · 时区 {timeZone} · 范围内{' '}
          {listed.data.summary.evidenceCount} 条证据 ·{' '}
          {listed.data.summary.objectCount} 个对象 · 已知{' '}
          {formatKnownBytes(listed.data.summary.knownBytes)}
          {listed.data.summary.unknownByteObjects > 0
            ? ` · ${listed.data.summary.unknownByteObjects} 个对象字节未知`
            : ''}
        </p>
      ) : null}
      {listed.data?.relatedRunGaps && listed.data.relatedRunGaps.count > 0 ? (
        <p className='shrink-0 text-label text-muted-foreground'>
          另有 {listed.data.relatedRunGaps.count}{' '}
          次运行完整性异常但没有对应证据行。
          {listed.data.relatedRunGaps.items.map((gap) => (
            <Link
              key={gap.runId}
              to='/runs/$runId'
              params={{ runId: gap.runId }}
              className='ms-2 text-link'
            >
              {gap.runId.slice(0, 8)}
            </Link>
          ))}
        </p>
      ) : null}
      {listed.isPending ? (
        <PageSkeleton />
      ) : listed.isError ? (
        <QueryErrorState
          title='无法加载证据'
          onRetry={() => void listed.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title='没有符合筛选条件的证据'
          description='改时间、目标、类型或预置视图后再试。成功运行里的失败尝试不会被丢掉。'
        />
      ) : (
        <section
          aria-label='证据列表'
          className='min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-border-card bg-card shadow-card'
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>目标与场景</TableHead>
                <TableHead>步骤 / 尝试</TableHead>
                <TableHead>采集时间</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>可用性</TableHead>
                {optionalColumns.map((column) => (
                  <TableHead key={column}>
                    {OPTIONAL_COLUMN_LABELS[column]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.evidence.id}
                  tabIndex={0}
                  aria-label={`${EVIDENCE_TYPE_LABELS[item.evidence.type]} ${item.targetName} ${item.scenarioName}`}
                  data-state={
                    search.selected === item.evidence.id
                      ? 'selected'
                      : undefined
                  }
                  className='cursor-pointer'
                  onClick={() => openItem(item.evidence.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openItem(item.evidence.id)
                    }
                  }}
                >
                  <TableCell className='min-w-28'>
                    <div className='flex items-center gap-2'>
                      {item.evidence.type === 'screenshot' &&
                      item.evidence.status === 'available' ? (
                        <EvidenceThumb
                          runId={item.evidence.runId}
                          evidenceId={item.evidence.id}
                          compact
                        />
                      ) : null}
                      <span className='whitespace-nowrap'>
                        {EVIDENCE_TYPE_LABELS[item.evidence.type]}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <p>{item.targetName}</p>
                    <p className='text-label text-muted-foreground'>
                      {item.scenarioName}
                    </p>
                  </TableCell>
                  <TableCell>
                    {item.stepOrdinal != null
                      ? `${item.stepOrdinal + 1}${item.stepName ? ` · ${item.stepName}` : ''}${item.attemptNo != null ? ` · #${item.attemptNo}` : ''}`
                      : '运行级'}
                  </TableCell>
                  <TableCell className='whitespace-nowrap'>
                    {formatWhen(item.evidence.createdAt)}
                  </TableCell>
                  <TableCell>
                    <p>{RUN_STATUS_LABELS[item.runStatus]}</p>
                    <p className='text-label text-muted-foreground'>
                      {item.attemptStatus
                        ? ATTEMPT_STATUS_LABELS[item.attemptStatus]
                        : '—'}
                    </p>
                    {item.hitKind ? (
                      <StatusBadge tone='error' className='mt-1'>
                        {item.hitKind === 'attempt_failed'
                          ? '尝试失败'
                          : '运行失败'}
                      </StatusBadge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      tone={
                        item.displayStatus.startsWith('available')
                          ? 'success'
                          : item.displayStatus.includes('anomaly') ||
                              item.displayStatus === 'unlinked'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {item.displayStatusLabel}
                    </StatusBadge>
                    {item.errorSummary ? (
                      // 限宽：摘要再长也只省略显示，不能把表撑宽而把可选列挤出视口。
                      <div className='mt-1 max-w-64'>
                        <TruncatedText
                          className='text-label text-muted-foreground'
                          text={item.errorSummary}
                        />
                      </div>
                    ) : null}
                  </TableCell>
                  {optionalColumns.map((column) => (
                    <TableCell key={column} className='whitespace-nowrap'>
                      {optionalCell(column, item)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {items.length > 0 || search.cursor ? (
        <CursorPagination
          className='shrink-0'
          pageIndex={search.cursor ? 1 : 0}
          pageSize={
            search.limit === 50 || search.limit === 100 ? search.limit : 20
          }
          sizes={EVIDENCE_PAGE_SIZES}
          hasPreviousPage={Boolean(listed.data?.prevCursor)}
          hasNextPage={Boolean(listed.data?.nextCursor)}
          updating={listed.isFetching && listed.isPlaceholderData}
          onPageSizeChange={(size) => patch({ limit: size, cursor: undefined })}
          onPreviousPage={() => {
            if (listed.data?.prevCursor)
              patch({ cursor: listed.data.prevCursor })
          }}
          onNextPage={() => {
            if (listed.data?.nextCursor)
              patch({ cursor: listed.data.nextCursor })
          }}
        />
      ) : null}
      <Sheet
        open={Boolean(selected) && desktop}
        onOpenChange={(open) => {
          if (!open) patch({ selected: undefined })
        }}
      >
        <SheetContent className='sm:max-w-xl' side='right'>
          <SheetHeader>
            <SheetTitle>证据详情</SheetTitle>
            <SheetDescription>
              查看来源、可用性与仍可访问的内容。
            </SheetDescription>
          </SheetHeader>
          <div className='min-h-0 flex-1 overflow-auto px-6 pb-6'>
            {detail.isPending ? (
              <PageSkeleton />
            ) : detail.isError || !detail.data ? (
              <QueryErrorState
                title='无法加载证据详情'
                onRetry={() => void detail.refetch()}
              />
            ) : (
              <EvidenceDetailBody detail={detail.data} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function RetentionPanel({
  search,
  patch,
}: {
  search: EvidencePageSearch
  patch: (
    next: Partial<EvidencePageSearch>,
    options?: { replace?: boolean }
  ) => void
}) {
  const canDelete = useCan('run:delete')
  const canReadConfig = useCan('platform-config:read')
  const view = search.retentionView ?? 'pending_cleanup'
  const summary = useQuery({
    queryKey: ['evidence', 'retention', 'summary'],
    queryFn: fetchEvidenceRetentionSummary,
  })
  const objects = useQuery({
    queryKey: [
      'evidence',
      'retention',
      'objects',
      view,
      search.targetId,
      search.asOf,
      search.retentionCursor,
    ],
    queryFn: () =>
      fetchEvidenceRetentionObjects({
        view,
        targetId: search.targetId,
        asOf: search.asOf,
        cursor: search.retentionCursor,
        limit: 20,
      }),
    enabled: view !== 'deleted_run' || canDelete,
  })

  return (
    <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto'>
      {summary.isPending ? (
        <PageSkeleton />
      ) : summary.isError || !summary.data ? (
        <QueryErrorState
          title='无法加载留存汇总'
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <>
          <CollectionSummary
            items={[
              {
                label: '可访问对象',
                value: summary.data.accessible.objectCount,
                description: `已知 ${formatKnownBytes(summary.data.accessible.knownBytes)}${
                  summary.data.accessible.unknownByteObjects > 0
                    ? ` · ${summary.data.accessible.unknownByteObjects} 个字节未知`
                    : ''
                }`,
                icon: <FileSearch className='size-4' />,
              },
              {
                label: '即将到期',
                value: summary.data.accessible.expiringSoon.objectCount,
                description: `已知 ${formatKnownBytes(summary.data.accessible.expiringSoon.knownBytes)}`,
                icon: <FileSearch className='size-4' />,
              },
              {
                label: '待清理',
                value: summary.data.accessible.pendingCleanup.objectCount,
                description: `已知 ${formatKnownBytes(summary.data.accessible.pendingCleanup.knownBytes)}`,
                icon: <FileSearch className='size-4' />,
              },
              {
                label: '清理失败',
                value: summary.data.accessible.purgeFailed,
                description: '按尝试次数或最近错误判定',
                icon: <FileSearch className='size-4' />,
              },
            ]}
          />
          <section className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
            <h2 className='text-section font-semibold'>已删除运行待清理</h2>
            <p className='mt-1 text-label text-muted-foreground'>
              {summary.data.deletedRunCleanup.pending} 个对象待处理 · 失败{' '}
              {summary.data.deletedRunCleanup.failed} · 处理中{' '}
              {summary.data.deletedRunCleanup.inProgress} · 已知{' '}
              {formatKnownBytes(summary.data.deletedRunCleanup.knownBytes)}
              {summary.data.deletedRunCleanup.unknownByteObjects > 0
                ? ` · ${summary.data.deletedRunCleanup.unknownByteObjects} 个字节未知`
                : ''}
              。逐项清单不含截图或原文，且需要 run:delete。
            </p>
          </section>
          {canReadConfig ? (
            <p className='text-label'>
              新运行的默认采集与留存策略在
              <Link
                to='/platform-config'
                search={{ tab: undefined }}
                className='ms-1 text-link'
              >
                平台配置
              </Link>
              维护。
            </p>
          ) : null}
        </>
      )}
      <div className='flex flex-wrap gap-2'>
        {(
          [
            'pending_cleanup',
            'expiring_soon',
            'purge_failed',
            'deleted_run',
          ] as const
        ).map((item) => (
          <Button
            key={item}
            size='sm'
            variant={view === item ? 'secondary' : 'outline'}
            disabled={item === 'deleted_run' && !canDelete}
            onClick={() => patch({ retentionView: item })}
          >
            {RETENTION_VIEW_LABELS[item]}
          </Button>
        ))}
      </div>
      {view === 'deleted_run' && !canDelete ? (
        <EmptyState
          title='没有逐项清单权限'
          description='具备 run:read 只能看到上方聚合。查看已删除运行的对象标识需要 run:delete。'
        />
      ) : objects.isPending ? (
        <PageSkeleton />
      ) : objects.isError ? (
        <QueryErrorState
          title='无法加载清理对象'
          onRetry={() => void objects.refetch()}
        />
      ) : (objects.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title='这个视图没有对象'
          description='清理队列会在到期、上传未完成或运行删除后出现。'
        />
      ) : (
        <section
          aria-label='留存对象'
          className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>对象</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>期限 / 体积</TableHead>
                <TableHead>进度</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {objects.data?.items.map((item) => (
                <TableRow key={item.objectId}>
                  <TableCell>
                    <p>
                      {item.type
                        ? EVIDENCE_TYPE_LABELS[item.type]
                        : '无证据记录'}
                    </p>
                    <p className='text-label text-muted-foreground'>
                      {item.targetName ?? '未知目标'}
                      {item.sourceIdVisible
                        ? ` · ${item.runId.slice(0, 8)}`
                        : ''}
                      {item.runDeleted ? ' · 来源已删除' : ''}
                    </p>
                  </TableCell>
                  <TableCell>
                    {CANDIDATE_REASON_LABELS[item.candidateReason]}
                  </TableCell>
                  <TableCell>
                    <p>{formatWhen(item.retainUntil)}</p>
                    <p className='text-label text-muted-foreground'>
                      {formatKnownBytes(item.byteSize, item.byteSizeUnknown)}
                    </p>
                  </TableCell>
                  <TableCell>
                    {item.purgeAttempts} 次
                    {item.lastPurgeErrorAt
                      ? ` · 最近失败 ${formatWhen(item.lastPurgeErrorAt)}`
                      : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {objects.data &&
      (objects.data.items.length > 0 || search.retentionCursor) ? (
        <CursorPagination
          pageIndex={search.retentionCursor ? 1 : 0}
          pageSize={20}
          sizes={RETENTION_PAGE_SIZES}
          hasPreviousPage={Boolean(objects.data.prevCursor)}
          hasNextPage={Boolean(objects.data.nextCursor)}
          updating={objects.isFetching && objects.isPlaceholderData}
          onPageSizeChange={() => undefined}
          onPreviousPage={() => {
            if (objects.data.prevCursor)
              patch({ retentionCursor: objects.data.prevCursor })
          }}
          onNextPage={() => {
            if (objects.data.nextCursor)
              patch({ retentionCursor: objects.data.nextCursor })
          }}
        />
      ) : null}
    </div>
  )
}

function ReportsCenterPanel({ search }: { search: EvidencePageSearch }) {
  const canRead = useCan('report:read')
  const [cursors, setCursors] = useState<string[]>([])
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20)
  const reports = useQuery({
    queryKey: [
      'reports',
      'center',
      search.suiteRunId,
      search.runId,
      search.targetId,
      search.suiteId,
      cursors[cursors.length - 1],
      pageSize,
    ],
    queryFn: () =>
      fetchReports({
        suiteRunId: search.suiteRunId,
        suiteId: search.suiteId,
        runId: search.runId,
        targetId: search.targetId,
        limit: pageSize,
        cursor: cursors[cursors.length - 1],
      }),
    enabled: canRead,
  })
  if (!canRead) {
    return (
      <EmptyState
        title='没有报告读取权限'
        description='当前角色不能查看报告列表。'
      />
    )
  }
  if (reports.isPending) return <PageSkeleton />
  if (reports.isError)
    return (
      <QueryErrorState
        title='无法加载报告'
        onRetry={() => void reports.refetch()}
      />
    )
  const items = reports.data?.items ?? []
  return (
    <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
      {items.length === 0 ? (
        <EmptyState
          title='还没有报告'
          description='从运行详情或集合运行页生成报告后，会显示在这里。'
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标题</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>修订</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Link to='/reports/$reportId' params={{ reportId: item.id }} className='text-link'>{item.currentRevision?.title ?? item.id.slice(0, 8)}</Link>
                </TableCell>
                <TableCell>
                  {item.subject.kind === 'RUN' ? (
                    <Link
                      to='/runs/$runId'
                      params={{ runId: item.subject.runId }}
                      className='text-link'
                    >
                      运行
                    </Link>
                  ) : (
                    <Link
                      to='/suite-runs/$suiteRunId'
                      params={{ suiteRunId: item.subject.suiteRunId }}
                      className='text-link'
                    >
                      集合运行
                    </Link>
                  )}
                </TableCell>
                <TableCell>{item.currentRevision?.revisionNo ?? '—'}</TableCell>
                <TableCell>
                  {new Date(item.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CursorPagination
        pageIndex={cursors.length}
        pageSize={pageSize}
        sizes={EVIDENCE_PAGE_SIZES}
        hasPreviousPage={cursors.length > 0}
        hasNextPage={Boolean(reports.data?.nextCursor)}
        updating={reports.isFetching}
        onPageSizeChange={(size) => {
          setPageSize(size as 20 | 50 | 100)
          setCursors([])
        }}
        onPreviousPage={() => setCursors((previous) => previous.slice(0, -1))}
        onNextPage={() => {
          if (reports.data?.nextCursor)
            setCursors((previous) => [...previous, reports.data!.nextCursor!])
        }}
      />
    </div>
  )
}
