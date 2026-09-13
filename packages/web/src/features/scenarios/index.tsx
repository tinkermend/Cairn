import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CheckCircle2,
  Globe2,
  ListOrdered,
  Plus,
  Search,
  Workflow,
} from 'lucide-react'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
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
import { EmptyState } from '@/components/empty-state'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { ScenarioCreateDialog } from './create-dialog'
import { SCENARIO_STATUS_LABELS } from './labels'

export function ScenariosPage() {
  const query = useQuery({ queryKey: ['scenarios'], queryFn: fetchScenarios })
  const canReadTargets = useCan('target:read')
  const targets = useQuery({
    queryKey: ['targets'],
    queryFn: fetchTargets,
    enabled: canReadTargets,
  })
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const items = query.data?.items ?? []
  const targetNames = new Map(
    (canReadTargets ? (targets.data?.items ?? []) : []).map((item) => [
      item.id,
      item.name,
    ])
  )
  const keyword = search.trim().toLocaleLowerCase()
  const filtered = items.filter(
    (item) =>
      (status === 'all' || item.status === status) &&
      [item.name, targetNames.get(item.targetId) ?? item.targetId].some(
        (value) => value.toLocaleLowerCase().includes(keyword)
      )
  )

  return (
    <>
      <AppHeader
        fixed
        leading={
          <span className='me-auto text-small text-muted-foreground'>
            自动化 <span className='mx-2'>/</span> 场景
          </span>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='场景'
          description='把业务任务组织成有序步骤，在同一场景中管理定义、版本与执行入口。'
          actions={
            <Can permission='workflow:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                新建场景
              </Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState
            title='无法加载场景'
            onRetry={() => void query.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title='还没有场景'
            description='从一个目标系统开始，创建第一组有序步骤。'
          />
        ) : (
          <>
            <CollectionSummary
              items={[
                {
                  label: '场景总数',
                  value: items.length,
                  description: '当前已加载的场景',
                  icon: <Workflow className='size-4' />,
                },
                {
                  label: '已启用',
                  value: items.filter((item) => item.status === 'active')
                    .length,
                  description: '场景定义处于启用状态',
                  icon: (
                    <CheckCircle2 className='size-4 text-status-success-foreground' />
                  ),
                },
                {
                  label: '关联目标系统',
                  value: new Set(items.map((item) => item.targetId)).size,
                  description: '每个场景绑定一个目标系统',
                  icon: <Globe2 className='size-4' />,
                },
                {
                  label: '步骤总数',
                  value: items.reduce((sum, item) => sum + item.stepCount, 0),
                  description: '按各场景最新版本统计',
                  icon: <ListOrdered className='size-4' />,
                },
              ]}
            />
            <section
              aria-label='场景列表'
              className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
            >
              <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
                <div className='flex flex-wrap gap-1' aria-label='场景状态筛选'>
                  {(
                    [
                      ['all', '全部场景'],
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
                <div className='relative w-full sm:w-72'>
                  <Search
                    aria-hidden='true'
                    className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                  />
                  <Input
                    aria-label='搜索场景'
                    placeholder='搜索场景或目标系统'
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className='pl-9'
                  />
                </div>
              </div>
              {canReadTargets && targets.isError ? (
                <p className='px-4 pt-3 text-small text-muted-foreground'>
                  目标系统名称暂不可用，以下显示系统 ID。
                  <Button
                    variant='link'
                    size='sm'
                    onClick={() => void targets.refetch()}
                  >
                    重新加载名称
                  </Button>
                </p>
              ) : null}
              {filtered.length === 0 ? (
                <EmptyState
                  title='没有匹配的场景'
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
                      <TableHead>场景</TableHead>
                      <TableHead>目标系统</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>最新版本</TableHead>
                      <TableHead>步骤</TableHead>
                      <TableHead>最近更新</TableHead>
                      <TableHead>
                        <span className='sr-only'>查看</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className='py-4'>
                          <div className='flex items-center gap-3'>
                            <span
                              aria-hidden='true'
                              className='flex size-10 shrink-0 items-center justify-center rounded-md bg-selection-background text-primary'
                            >
                              <ListOrdered className='size-5' />
                            </span>
                            <div className='min-w-0'>
                              <Link
                                to='/scenarios/$scenarioId'
                                params={{ scenarioId: item.id }}
                                className='block max-w-72 truncate rounded-sm text-body font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring'
                                title={item.name}
                              >
                                {item.name}
                              </Link>
                              <p className='mt-1 text-label text-muted-foreground'>
                                顺序执行 · {item.stepCount} 个步骤
                                {item.draftDirty ? ' · 有未发布草稿' : ''}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {canReadTargets ? (
                            <Link
                              to='/targets/$targetId'
                              params={{ targetId: item.targetId }}
                              title={
                                targetNames.get(item.targetId) ?? item.targetId
                              }
                              className='block max-w-48 truncate text-link hover:underline'
                            >
                              {targetNames.get(item.targetId) ?? item.targetId}
                            </Link>
                          ) : (
                            <span
                              title={item.targetId}
                              className='block max-w-48 truncate font-mono text-label'
                            >
                              {item.targetId}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className='flex flex-wrap gap-2'>
                            <StatusBadge
                              tone={
                                item.status === 'active' ? 'success' : 'neutral'
                              }
                            >
                              {SCENARIO_STATUS_LABELS[item.status]}
                            </StatusBadge>
                            {item.draftDirty ? (
                              <StatusBadge tone='warning'>未发布草稿</StatusBadge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone='neutral'>
                            v{item.latestVersionNo}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className='tabular-nums'>
                          {item.stepCount}
                        </TableCell>
                        <TableCell className='text-label text-muted-foreground'>
                          {new Date(item.updatedAt).toLocaleString('zh-CN', {
                            hour12: false,
                          })}
                        </TableCell>
                        <TableCell>
                          <Button asChild variant='ghost' size='icon'>
                            <Link
                              to='/scenarios/$scenarioId'
                              params={{ scenarioId: item.id }}
                              aria-label={`打开${item.name}`}
                            >
                              <ArrowUpRight />
                            </Link>
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
                显示 {filtered.length} / {items.length} 个场景
                {query.data?.nextCursor ? ' · 当前为首批数据' : ''}
              </p>
            </section>
          </>
        )}
      </Main>
      <ScenarioCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void navigate({
            to: '/scenarios/$scenarioId',
            params: { scenarioId: id },
          })
        }}
      />
    </>
  )
}
