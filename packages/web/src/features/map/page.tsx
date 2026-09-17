import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import { ArrowLeft, Compass, ShieldCheck, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMapSummary, publishMapRelease } from '@/lib/map-api'
import { fetchTarget } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { MapAssetsPane } from './assets-pane'
import { AutoRefreshCard } from './auto-refresh'
import { ConsumptionPolicyCard } from './consumption-policy'
import { ExplorationCard } from './exploration'
import { JobMaintenanceCard } from './job-maintenance'
import { MapSummaryBanner } from './summary-banner'

const route = getRouteApi('/_authenticated/targets/$targetId/map/')

export function TargetMapPage() {
  const { targetId } = route.useParams()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('assets')
  const page = useCursorPage()
  const canPublish = useCan('map:publish')

  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
  })

  const summaryQuery = useQuery({
    queryKey: ['map', targetId, 'summary'],
    queryFn: () => fetchMapSummary(targetId),
  })

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
        reason: '发布当前知识版本',
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

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          parent={
            <Link
              to='/targets/$targetId'
              params={{ targetId }}
              className='inline-flex items-center gap-1.5 hover:text-link'
            >
              <ArrowLeft className='size-4' />
              返回目标系统
            </Link>
          }
          title='目标知识'
          description={
            <span className='flex flex-wrap items-center gap-2 text-small text-muted-foreground'>
              <Link to='/targets' className='text-primary hover:underline'>
                目标系统
              </Link>
              {targetQuery.data ? (
                <>
                  <span>/</span>
                  <span className='font-medium text-text-primary'>
                    {targetQuery.data.name}
                  </span>
                </>
              ) : null}
              <span>·</span>
              <span>查看已认识的页面、对象、条件和受影响场景</span>
              {summary ? (
                <>
                  <span>·</span>
                  <StatusBadge
                    tone={
                      summary.projectionStatus === 'active' ||
                      summary.projectionStatus === 'ready'
                        ? 'success'
                        : summary.projectionStatus === 'shadow'
                          ? 'info'
                          : 'warning'
                    }
                  >
                    投影：{summary.projectionStatus}
                  </StatusBadge>
                </>
              ) : null}
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
                  {publishMutation.isPending ? '发布中…' : '发布此版本'}
                </Button>
              </Can>
            </div>
          }
        />

        {summaryQuery.isPending ? (
          <PageSkeleton />
        ) : summaryQuery.isError ? (
          <QueryErrorState
            description={summaryQuery.error?.message}
            onRetry={() => void summaryQuery.refetch()}
          />
        ) : (
          <>
            <MapSummaryBanner summary={summary} />
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className='w-full space-y-4'
            >
              <TabsList className='border-b border-border bg-transparent p-0'>
                <TabsTrigger value='assets'>
                  <Compass className='size-4' />
                  知识资产全景
                </TabsTrigger>
                <TabsTrigger value='maintenance'>
                  <Wrench className='size-4' />
                  地图维护与复查
                </TabsTrigger>
                <TabsTrigger value='policy'>
                  <ShieldCheck className='size-4' />
                  运行消费与探索
                </TabsTrigger>
              </TabsList>

              <TabsContent value='assets' className='space-y-4'>
                <MapAssetsPane
                  targetId={targetId}
                  summary={summary}
                  page={page}
                />
              </TabsContent>

              <TabsContent value='maintenance' className='space-y-5'>
                <JobMaintenanceCard targetId={targetId} />
                <AutoRefreshCard targetId={targetId} />
              </TabsContent>

              <TabsContent value='policy' className='space-y-5'>
                <ConsumptionPolicyCard targetId={targetId} />
                <ExplorationCard targetId={targetId} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </Main>
    </>
  )
}
