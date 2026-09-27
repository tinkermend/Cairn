import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { hasPermission, recordingSourceLabel } from '@cairn/shared'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Trash2,
  Sparkles,
  ListTree,
  FileCode2,
  History,
  Edit2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  deleteRecording,
  fetchRecording,
  fetchRecordingGeneralization,
  observeRecordingGeneralization,
  renameRecording,
} from '@/lib/recordings-api'
import { fetchDemonstration } from '@/lib/demonstrations-api'
import { useAuthStore } from '@/stores/auth-store'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RecordingHandoffDialog } from './components/handoff-dialog'
import { RecordingMetricStrip } from './components/metric-strip'
import { RecordingStepInspector } from './components/step-inspector'
import { type FilterOption, RecordingStepStream } from './components/step-stream'
import { RecordingRenameDialog } from './rename-dialog'
import { SavedDemonstrationFacts } from './demonstration-facts'
import { CandidateScenarioPreview } from './components/candidate-preview'
import { GeneralizationPanel } from './components/generalization-panel'

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

  const demonstrationQuery = useQuery({
    queryKey: ['demonstration', recordingId],
    queryFn: () => fetchDemonstration(recordingId),
    enabled: Boolean(draft?.sourceProtocol === 'demonstration@1'),
  })

  const generalizationQuery = useQuery({
    queryKey: ['recording-generalization', recordingId],
    queryFn: () => fetchRecordingGeneralization(recordingId),
    enabled: Boolean(draft?.sourceProtocol === 'demonstration@1'),
  })

  useEffect(() => {
    if (draft?.sourceProtocol !== 'demonstration@1') return
    return observeRecordingGeneralization(recordingId, {
      onUpdate: (data) => {
        queryClient.setQueryData(['recording-generalization', recordingId], data)
      },
    })
  }, [draft?.sourceProtocol, recordingId, queryClient])

  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'workbench' | 'candidate' | 'generalization' | 'facts'>('workbench')

  // 标题行内编辑状态
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)

  const handleStartEditTitle = () => {
    if (!canWrite || !draft) return
    setTitleDraft(draft.name)
    setIsEditingTitle(true)
  }

  const handleSaveTitle = async () => {
    if (!draft) return
    const trimmed = titleDraft.trim()
    if (!trimmed) {
      toast.error('名称不能为空')
      return
    }
    if (trimmed === draft.name) {
      setIsEditingTitle(false)
      return
    }
    setSavingTitle(true)
    try {
      await renameRecording(draft.id, trimmed)
      toast.success('已更新草稿名称')
      setIsEditingTitle(false)
      void queryClient.invalidateQueries({ queryKey: ['recordings', recordingId] })
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '重命名失败')
    } finally {
      setSavingTitle(false)
    }
  }

  const handleKeyDownTitle = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSaveTitle()
    } else if (e.key === 'Escape') {
      setIsEditingTitle(false)
    }
  }

  const genData = generalizationQuery.data?.generalization
  const candidateDoc = generalizationQuery.data?.candidateDocument ?? genData?.candidateDocument

  // 步骤交互状态与轻量清洗
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusFilter, setStatusFilter] = useState<FilterOption>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [ignoredIndexes, setIgnoredIndexes] = useState<Set<number>>(new Set())

  const handleToggleIgnore = (index: number) => {
    setIgnoredIndexes((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

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
    selectedIndex >= 0
      ? filteredItems.find((i) => i.index === selectedIndex) ??
        items.find((i) => i.index === selectedIndex) ??
        filteredItems[0] ??
        items[0]
      : undefined

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
          title={
            isEditingTitle ? (
              <div className='flex items-center gap-2'>
                <input
                  type='text'
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={handleKeyDownTitle}
                  onBlur={() => void handleSaveTitle()}
                  autoFocus
                  disabled={savingTitle}
                  className='h-8 max-w-md rounded-md border border-input bg-background px-2.5 text-page font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring'
                  maxLength={128}
                  aria-label='编辑草稿名称'
                />
              </div>
            ) : (
              <div className='group inline-flex items-center gap-2'>
                <span>{draft?.name ?? '录制草稿'}</span>
                {canWrite ? (
                  <button
                    type='button'
                    onClick={handleStartEditTitle}
                    className='opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary'
                    title='点击修改名称'
                    aria-label='点击修改名称'
                  >
                    <Edit2 className='size-4' />
                  </button>
                ) : null}
              </div>
            )
          }
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
                  <>
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
                    {canWrite ? (
                      <Button variant='outline' onClick={() => setHandoffOpen(true)} className='gap-1.5'>
                        再次回填到场景...
                      </Button>
                    ) : null}
                  </>
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

        {draft?.sourceProtocol === 'demonstration@1' ? (
          <div className='flex items-center justify-between border-b pb-2'>
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as typeof viewMode)}>
              <TabsList className='grid grid-cols-4 w-full sm:w-auto'>
                <TabsTrigger value='workbench' className='gap-1.5'>
                  <ListTree className='size-3.5' />
                  流水工作台
                </TabsTrigger>
                <TabsTrigger value='generalization' className='gap-1.5'>
                  <Sparkles className='size-3.5 text-primary' />
                  AI 意图泛化
                  {genData?.rounds.length ? (
                    <span className='ml-1 rounded-full bg-primary/10 px-1.5 py-0.2 text-[10px] font-medium text-primary'>
                      {genData.rounds.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value='candidate' className='gap-1.5'>
                  <FileCode2 className='size-3.5' />
                  候选场景预览
                  {candidateDoc?.nodes.length !== undefined ? (
                    <span className='ml-1 rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground'>
                      {candidateDoc.nodes.length} 步
                    </span>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value='facts' className='gap-1.5'>
                  <History className='size-3.5' />
                  原始示教事实
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        ) : null}

        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError || !draft ? (
          <QueryErrorState title='无法加载录制草稿' onRetry={() => void query.refetch()} />
        ) : viewMode === 'generalization' ? (
          <GeneralizationPanel
            recordingId={recordingId}
            generalization={genData}
            candidateDocument={candidateDoc}
            onGeneralizationUpdated={(gen, doc) => {
              queryClient.setQueryData(['recording-generalization', recordingId], {
                generalization: gen,
                candidateDocument: doc ?? gen.candidateDocument,
              })
            }}
            canWrite={canWrite}
            selectedStepId={selectedItem ? `rec_${selectedItem.index}` : undefined}
            selectedStepName={selectedItem?.name}
            onClearSelection={() => setSelectedIndex(-1)}
          />
        ) : viewMode === 'candidate' ? (
          <CandidateScenarioPreview
            candidateDocument={candidateDoc}
            generalization={genData}
            onOpenHandoff={() => setHandoffOpen(true)}
            canWrite={canWrite}
          />
        ) : viewMode === 'facts' ? (
          <div className='flex flex-col gap-4'>
            <div className='flex items-center justify-between'>
              <h2 className='text-body font-semibold text-foreground'>原始示教事实溯源</h2>
              <Button variant='outline' size='sm' onClick={() => setViewMode('workbench')}>
                返回步骤流水线工作台
              </Button>
            </div>
            <SavedDemonstrationFacts id={draft.id} />
          </div>
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
                  <div className='flex items-center gap-2'>
                    <h2 className='text-body font-semibold text-foreground'>
                      操作步骤流水线 ({items.length})
                    </h2>
                    {ignoredIndexes.size > 0 ? (
                      <span className='text-label text-muted-foreground'>
                        (已剔除 {ignoredIndexes.size} 步)
                      </span>
                    ) : null}
                  </div>
                  <div className='flex items-center gap-2'>
                    <span className='hidden sm:inline text-label text-muted-foreground'>
                      点击步骤在右侧审查定位与截图
                    </span>
                  </div>
                </div>
                <RecordingStepStream
                  items={items}
                  selectedIndex={selectedItem?.index ?? 0}
                  onSelectIndex={handleSelectIndex}
                  statusFilter={statusFilter}
                  onStatusFilterChange={setStatusFilter}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  ignoredIndexes={ignoredIndexes}
                  onToggleIgnore={handleToggleIgnore}
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
                  demonstrationDetail={demonstrationQuery.data}
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
                    demonstrationDetail={demonstrationQuery.data}
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
          sourceProtocol={draft.sourceProtocol}
          generalizationRevision={genData?.revision}
          candidateDigest={genData?.candidateDigest}
        />
      ) : null}
    </>
  )
}
