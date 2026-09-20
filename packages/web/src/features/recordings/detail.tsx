import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { hasPermission, recordingSourceLabel } from '@cairn/shared'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Trash2,
} from 'lucide-react'
import { deleteRecording, fetchRecording } from '@/lib/recordings-api'
import { useAuthStore } from '@/stores/auth-store'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { RecordingHandoffDialog } from './components/handoff-dialog'
import { RecordingMetricStrip } from './components/metric-strip'
import { RecordingStepInspector } from './components/step-inspector'
import { type FilterOption, RecordingStepStream } from './components/step-stream'
import { RecordingRenameDialog } from './rename-dialog'
import { SavedDemonstrationFacts } from './demonstration-facts'

export function RecordingDetailPage() {
  const { recordingId } = useParams({ from: '/_authenticated/recordings/$recordingId/' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.auth.user)
  const isAdmin = Boolean(user?.roles.includes('admin'))

  const query = useQuery({
    queryKey: ['recordings', recordingId],
    queryFn: () => fetchRecording(recordingId),
  })
  const draft = query.data

  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)

  // 步骤交互状态
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusFilter, setStatusFilter] = useState<FilterOption>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const canWrite =
    Boolean(draft) &&
    hasPermission(user?.permissions ?? [], 'workflow:write') &&
    (isAdmin || draft?.createdBy.id === user?.id)
  const canDelete =
    Boolean(draft) &&
    hasPermission(user?.permissions ?? [], 'workflow:delete') &&
    (isAdmin || draft?.createdBy.id === user?.id)

  const items = draft?.items ?? []

  const filteredItems = items.filter((item) => {
    if (statusFilter === 'mapped' && item.status !== 'mapped') return false
    if (statusFilter === 'parameterized' && item.status !== 'parameterized') return false
    if (statusFilter === 'unresolved' && item.status !== 'unresolved') return false
    if (statusFilter === 'sensitive' && !item.sensitive) return false
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      const matchName = item.name.toLowerCase().includes(q)
      const matchAction = item.sourceAction.toLowerCase().includes(q)
      return matchName || matchAction
    }
    return true
  })

  const selectedItem =
    filteredItems.find((i) => i.index === selectedIndex) ??
    filteredItems[0] ??
    items.find((i) => i.index === selectedIndex) ??
    items[0]

  const currentFilteredIdx = selectedItem ? filteredItems.findIndex((i) => i.index === selectedItem.index) : -1

  const handleSelectIndex = (idx: number) => {
    setSelectedIndex(idx)
    // 窄屏下点击步骤自动唤出移动端检查面板
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setMobileDrawerOpen(true)
    }
  }

  const handlePrev = () => {
    if (currentFilteredIdx > 0) {
      setSelectedIndex(filteredItems[currentFilteredIdx - 1].index)
    }
  }

  const handleNext = () => {
    if (currentFilteredIdx >= 0 && currentFilteredIdx < filteredItems.length - 1) {
      setSelectedIndex(filteredItems[currentFilteredIdx + 1].index)
    }
  }

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          parent={
            <Link
              to='/recordings'
              className='inline-flex items-center gap-1.5 hover:text-link'
            >
              <ArrowLeft className='size-4' />
              返回录制草稿
            </Link>
          }
          title={draft?.name ?? '录制草稿'}
          description={
            draft ? (
              <span className='flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-muted-foreground'>
                <span>目标系统</span>
                <Link
                  to='/targets/$targetId'
                  params={{ targetId: draft.targetId }}
                  className='font-medium text-primary hover:underline'
                >
                  {draft.targetName}
                </Link>
                <span>·</span>
                <span>来源 {recordingSourceLabel(draft.sourceVersion)}</span>
                <span>·</span>
                <span>创建者: {draft.createdBy.displayName}</span>
                <span>·</span>
                {draft.imported && draft.importedScenarioId ? (
                  <span className='text-status-success-foreground font-medium'>已回填到场景</span>
                ) : (
                  <span className='text-muted-foreground'>尚未回填</span>
                )}
              </span>
            ) : (
              '来自识途录制器的操作序列。'
            )
          }
          actions={
            draft ? (
              <div className='flex flex-wrap items-center gap-2'>
                {/* 核心主操作 CTA */}
                {draft.imported && draft.importedScenarioId ? (
                  <Button asChild>
                    <Link
                      to='/scenarios/$scenarioId'
                      params={{ scenarioId: draft.importedScenarioId }}
                      search={{ import: draft.id }}
                      className='gap-1.5'
                    >
                      前往对应 Studio
                      <ExternalLink className='size-3.5' />
                    </Link>
                  </Button>
                ) : canWrite ? (
                  <Button onClick={() => setHandoffOpen(true)} className='gap-1.5'>
                    回填到场景
                    <ArrowRight className='size-3.5' />
                  </Button>
                ) : null}

                {/* 次要操作 */}
                {canWrite ? (
                  <Button variant='outline' onClick={() => setRenaming(true)}>
                    重命名
                  </Button>
                ) : null}

                {canDelete ? (
                  <Button
                    variant='ghost'
                    className='text-destructive hover:bg-destructive/10'
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 className='size-3.5 mr-1' />
                    删除
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        />

        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError || !draft ? (
          <QueryErrorState title='无法加载录制草稿' onRetry={() => void query.refetch()} />
        ) : draft.sourceProtocol === 'demonstration@1' ? (
          <SavedDemonstrationFacts id={draft.id} />
        ) : (
          <div className='flex flex-col gap-5'>
            {/* 就绪度看板条 */}
            <RecordingMetricStrip
              draft={draft}
              activeFilter={statusFilter}
              onFilterChange={setStatusFilter}
            />

            {/* 双栏工作台：左侧步骤时间线流水 + 右侧单步深度透视器 */}
            <div className='grid grid-cols-1 items-start gap-5 lg:grid-cols-12'>
              {/* 左栏：步骤流水线 (Master) */}
              <div className='lg:col-span-7 xl:col-span-7'>
                <div className='flex items-center justify-between pb-2'>
                  <h2 className='text-body font-semibold text-foreground'>
                    操作步骤流水线 ({items.length})
                  </h2>
                  <span className='text-label text-muted-foreground'>
                    点击步骤可在右侧审查定位符与原始事件
                  </span>
                </div>
                <RecordingStepStream
                  items={items}
                  selectedIndex={selectedItem?.index ?? 0}
                  onSelectIndex={handleSelectIndex}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                />
              </div>

              {/* 右栏：单步深度透视器 (Inspector Panel) - 桌面端粘性常驻 */}
              <div className='hidden lg:sticky lg:top-20 lg:col-span-5 lg:block xl:col-span-5'>
                <div className='flex items-center justify-between pb-2'>
                  <h2 className='text-body font-semibold text-foreground'>步骤检查与上下文</h2>
                  <span className='text-label text-muted-foreground'>支持复制选择器与 DSL</span>
                </div>
                <RecordingStepInspector
                  item={selectedItem}
                  totalCount={items.length}
                  events={draft.events}
                  onPrev={handlePrev}
                  onNext={handleNext}
                  hasPrev={currentFilteredIdx > 0}
                  hasNext={currentFilteredIdx >= 0 && currentFilteredIdx < filteredItems.length - 1}
                />
              </div>
            </div>

            {/* 窄屏响应式抽屉 (Sheet) */}
            <Sheet open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
              <SheetContent side='right' className='w-full sm:max-w-lg overflow-y-auto'>
                <SheetHeader className='pb-2'>
                  <SheetTitle>步骤检查与上下文</SheetTitle>
                </SheetHeader>
                <div className='mt-2'>
                  <RecordingStepInspector
                    item={selectedItem}
                    totalCount={items.length}
                    events={draft.events}
                    onPrev={handlePrev}
                    onNext={handleNext}
                    hasPrev={Boolean(selectedItem && selectedItem.index > 0)}
                    hasNext={Boolean(selectedItem && selectedItem.index < items.length - 1)}
                  />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        )}
      </Main>

      {/* 重命名弹窗 */}
      <RecordingRenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        recording={draft ?? null}
        onRenamed={() => {
          setRenaming(false)
          void queryClient.invalidateQueries({ queryKey: ['recordings', recordingId] })
        }}
      />

      {/* 删除确认弹窗 */}
      <ResourceDeleteDialog
        open={removing}
        onOpenChange={setRemoving}
        resourceId={recordingId}
        resourceName={draft?.name ?? ''}
        resourceType='recording'
        deleteFn={() => deleteRecording(recordingId)}
        onSuccess={() => {
          setRemoving(false)
          void queryClient.invalidateQueries({ queryKey: ['recordings'] })
          void navigate({ to: '/recordings' })
        }}
      />

      {/* 回填到场景弹窗 */}
      {draft ? (
        <RecordingHandoffDialog
          open={handoffOpen}
          onOpenChange={setHandoffOpen}
          recordingId={recordingId}
          recordingName={draft.name}
          targetId={draft.targetId}
          targetName={draft.targetName}
        />
      ) : null}
    </>
  )
}
