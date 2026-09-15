import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  canAdoptAssistantProposal,
  entityIdSchema,
  hasAiSteps,
  canExecuteRun,
  canTrialRun,
  hasPermission,
  isAiStepType,
  MAX_SCENARIO_STEPS,
  type CompileDiagnostic,
  type ExecutableStepType,
  type RecordingInsertAnchor,
  type RunDetailDto,
} from '@cairn/shared'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Info,
  ListOrdered,
  Play,
  Plus,
  Save,
  TriangleAlert,
  Undo2,
  Video,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { notifyExtensionStart } from '@/lib/extension-bridge'
import { closeRecordingBinding } from '@/lib/recordings-api'
import {
  createRecordingBinding,
  deleteScenario,
  fetchRecordingImports,
  fetchScenario,
  fetchScenarioCapabilities,
  previewDeleteScenario,
  publishScenario,
  saveScenarioDraft,
  updateScenario,
} from '@/lib/scenarios-api'
import { observeRun } from '@/lib/runs-api'
import { fetchTarget } from '@/lib/targets-api'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/status-badge'
import { StudioHoldBar } from '@/features/runs/debug-hold-bar'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { RunCreateDialog } from '@/features/runs/create-dialog'
import {
  createBlankStep,
  DETERMINISTIC_STUDIO_TYPES,
  selectableStudioTypes,
  STEP_TYPE_HINTS,
  unavailableStudioTypes,
} from './step-registry'
import { AuthoringObserveProvider } from './authoring-observe'
import { InputsEditor, StepEditor } from './step-editor'
import { TrialDialog } from './trial-dialog'
import { TrialPanel } from './trial-panel'
import { SCENARIO_STATUS_LABELS, stepTypeLabel } from './labels'
import { RecordingImportPanel } from './recording-import-panel'
import { useStudioDraft } from './use-studio-draft'
import {
  documentContextKeys,
  focusStudioField,
  insertStep,
  isTypingTarget,
  moveStep,
  outputConsumers,
  priorBindings,
  priorOutputShapes,
} from './studio-document'

const FlowgramCanvas = lazy(() => import('./flowgram/canvas'))

export function ScenarioDetailPage() {
  const { scenarioId } = useParams({
    from: '/_authenticated/scenarios/$scenarioId/',
  })
  const search = useSearch({ strict: false })
  const flowgram = (search as { editor?: string }).editor === 'flowgram'
  const runId = entityIdSchema.optional().safeParse((search as { runId?: unknown }).runId).data
  const importDraftId = entityIdSchema.optional().safeParse((search as { import?: unknown }).import).data
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const query = useQuery({
    queryKey: ['scenarios', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
  })
  const capabilitiesQuery = useQuery({
    queryKey: ['scenarios', 'capabilities'],
    queryFn: fetchScenarioCapabilities,
  })
  const canReadTarget = useCan('target:read')
  const canWrite = useCan('workflow:write')
  const canDelete = useCan('workflow:delete')
  const canAssist = useCan('ai:assist')
  const openAssistant = useAssistantStore((state) => state.openPanel)
  const registerAdoptHandler = useAssistantStore((state) => state.registerAdoptHandler)
  const canStartFormalRun = Boolean(user && canExecuteRun(user.permissions))
  const canStartTrial = Boolean(user && canTrialRun(user.permissions))
  const canAi = Boolean(user && hasPermission(user.permissions, 'ai:execute'))
  const scenario = query.data
  const targetQuery = useQuery({
    queryKey: ['target', scenario?.targetId],
    queryFn: () => fetchTarget(scenario!.targetId),
    enabled: !!scenario && canReadTarget,
  })
  const target = canReadTarget ? targetQuery.data : undefined
  const draft = useStudioDraft(
    scenarioId,
    scenario?.draft
      ? { revision: scenario.draft.revision, document: scenario.draft.document }
      : undefined,
    target
      ? { exists: true, status: target.status }
      : scenario
        ? { exists: true, status: 'active' }
        : undefined,
    capabilitiesQuery.data?.executableStepTypes ?? DETERMINISTIC_STUDIO_TYPES,
  )
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [typeChange, setTypeChange] = useState<ExecutableStepType | null>(null)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [startingRecord, setStartingRecord] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [nextName, setNextName] = useState('')
  const [removing, setRemoving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const importedQueryKey = ['scenarios', scenarioId, 'imported-step-ids'] as const
  const importedStepsQuery = useQuery({
    queryKey: importedQueryKey,
    queryFn: async () => queryClient.getQueryData<string[]>(importedQueryKey) ?? [],
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  })
  const importedStepIds = importedStepsQuery.data ?? []
  const [mobilePane, setMobilePane] = useState<'steps' | 'properties' | 'page'>('steps')
  const [stepNavigation, setStepNavigation] = useState<{ id: string; sequence: number } | null>(null)
  const [canvasLayout, setCanvasLayout] = useState<'vertical' | 'snake'>('snake')
  function locateStep(id: string) {
    draft.setSelectedId(id)
    setStepNavigation((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
  }
  const stepList = useRef<HTMLOListElement>(null)
  const selectedListId = draft.selected?.id
  useEffect(() => {
    if (!flowgram && selectedListId) {
      const selected = stepList.current?.querySelector('[aria-pressed="true"]')
      if (selected?.getClientRects().length) selected.scrollIntoView({ block: 'nearest' })
    }
  }, [flowgram, mobilePane, selectedListId])
  const { run: trialRun } = useRunObservation(runId ?? '', Boolean(runId))
  const openedPageForRun = useRef<string | null>(null)
  useEffect(() => {
    if (!runId || !trialRun) return
    if (!['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(trialRun.status)) {
      return
    }
    if (openedPageForRun.current === runId) return
    openedPageForRun.current = runId
    setMobilePane('page')
  }, [runId, trialRun])
  const holdingStepId =
    trialRun?.status === 'HOLDING' && trialRun.debugMode !== 'runThrough'
      ? trialRun.checkpoint?.stepId
      : undefined
  const canRecord = canWrite && canReadTarget
  const recordingQuery = useQuery({
    queryKey: ['scenarios', scenarioId, 'recording-imports'],
    queryFn: () => fetchRecordingImports(scenarioId),
    enabled: Boolean(scenario && canReadTarget),
  })
  const openBinding = recordingQuery.data?.bindings.find((item) => item.status !== 'closed')

  const document = draft.candidate
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const disabled = !canWrite || saving || publishing
  const compile = draft.compile ?? (draft.hasFieldDrafts ? null : scenario?.compile)
  const editableTypes = selectableStudioTypes(capabilitiesQuery.data)
  const draftHasAi = Boolean(document && hasAiSteps(document.steps))
  const canTrial = Boolean(
    canStartTrial &&
      (!draftHasAi || canAi) &&
      !draft.dirty &&
      compile?.ok &&
      scenario?.status === 'active' &&
      target?.status !== 'disabled',
  )
  const canPublish = Boolean(
    canWrite &&
      !draft.dirty &&
      compile?.ok &&
      scenario &&
      scenario.status === 'active' &&
      target?.status !== 'disabled',
  )
  const unpublishedDraft = Boolean(scenario?.draftDirty)
  const consumers = document ? outputConsumers(document, document.steps.find((step) => step.id === deleteId)?.outputKey) : []
  const bindings = document && draft.selectedIndex >= 0 ? priorBindings(document, draft.selectedIndex) : []
  const shapes = document && draft.selectedIndex >= 0 ? priorOutputShapes(document, draft.selectedIndex) : new Map()
  const trialDisabledReason = useMemo(() => {
    if (compile?.ok === false) return '先修复编译错误'
    if (draft.hasFieldDrafts) return '先修正尚未合法的字段'
    if (draft.dirty) return '先保存草稿'
    if (draftHasAi && !canAi) return '缺少 ai:execute，不能试跑含 AI 步骤的场景'
    return '当前不能试跑'
  }, [canAi, compile?.ok, draft.dirty, draft.hasFieldDrafts, draftHasAi])

  const applyStructure = draft.applyStructure
  const selectedIndex = draft.selectedIndex
  const selectedStepId = draft.selected?.id ?? null
  const canPropose =
    canAssist &&
    canWrite &&
    canReadTarget &&
    !draft.dirty &&
    !draft.hasFieldDrafts &&
    !draft.conflict &&
    !draft.remoteStale &&
    Boolean(scenario?.draft && draft.selected)

  useEffect(() => {
    if (!canPropose || !scenario?.draft || !document) {
      registerAdoptHandler(null)
      return
    }
    const revision = scenario.draft.revision
    const current = document
    registerAdoptHandler(async (proposal) => {
      const allowed = await canAdoptAssistantProposal({
        proposal,
        revision,
        document: current,
        hasFieldDrafts: false,
        remoteConflict: draft.conflict || draft.remoteStale,
      })
      if (!allowed.ok) return allowed
      applyStructure(proposal.document, proposal.stepId)
      return { ok: true }
    })
    return () => registerAdoptHandler(null)
  }, [
    applyStructure,
    canPropose,
    document,
    draft.conflict,
    draft.remoteStale,
    registerAdoptHandler,
    scenario?.draft,
  ])

  useEffect(() => {
    if (!canWrite || disabled || !document || selectedIndex < 0) return
    const current = document
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || isTypingTarget(event.target)) return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = moveStep(current, selectedIndex, -1)
        if (next) applyStructure(next, selectedStepId)
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = moveStep(current, selectedIndex, 1)
        if (next) applyStructure(next, selectedStepId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyStructure, canWrite, disabled, document, selectedIndex, selectedStepId])

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!draft.dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [draft.dirty])

  function markConflict() {
    draft.setConflict(true)
    toast.error('他人已更新这份草稿，请重新加载')
  }

  const currentInsertAnchor: RecordingInsertAnchor = draft.selected?.id
    ? { kind: 'after', stepId: draft.selected.id }
    : { kind: 'start' }

  function setImportSearch(next: string | undefined) {
    void navigate({
      to: '/scenarios/$scenarioId',
      params: { scenarioId },
      search: { runId, import: next, editor: flowgram ? 'flowgram' : undefined },
      replace: true,
    })
  }

  useEffect(() => {
    if (!importDraftId) {
      setImportOpen(false)
      return
    }
    if (draft.dirty || draft.hasFieldDrafts) {
      toast.error('先保存草稿再打开录制回填')
      return
    }
    setImportOpen(true)
  }, [draft.dirty, draft.hasFieldDrafts, importDraftId])

  async function startRecording() {
    if (!document || !draft.baseline || startingRecord) return
    if (draft.dirty || draft.hasFieldDrafts) {
      toast.error('先保存草稿')
      return
    }
    setStartingRecord(true)
    try {
      const created = await createRecordingBinding(scenarioId, {
        revision: draft.baseline.revision,
        insertAnchor: currentInsertAnchor,
      })
      await notifyExtensionStart(created)
      await queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'recording-imports'] })
      toast.message('点击浏览器工具栏中的识途录制器图标，继续同一绑定')
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        markConflict()
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '无法开始录制')
      }
    } finally {
      setStartingRecord(false)
    }
  }

  async function cancelRecording() {
    if (!openBinding) return
    try {
      await closeRecordingBinding(openBinding.id)
      await queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'recording-imports'] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '无法关闭录制绑定')
    }
  }

  async function save(): Promise<boolean> {
    if (!document || !draft.baseline || saving) return false
    if (draft.hasFieldDrafts) {
      toast.error('先修正尚未合法的字段')
      draft.focusFirstDraft()
      return false
    }
    setSaving(true)
    try {
      const next = await saveScenarioDraft(scenarioId, {
        revision: draft.baseline.revision,
        document,
      })
      if (next.draft) draft.acceptServer({ revision: next.draft.revision, document: next.draft.document })
      queryClient.setQueryData(['scenarios', scenarioId], next)
      toast.success('草稿已保存')
      if (runId && draft.selected) {
        try {
          await observeRun(runId, { op: 'highlight', clearOverlayStepId: draft.selected.id })
        } catch {
          // 草稿已按 OCC 落库；覆盖层清理失败不回滚保存
        }
      }
      return true
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        markConflict()
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
      }
      return false
    } finally {
      setSaving(false)
    }
  }

  async function publish() {
    if (!draft.baseline || draft.dirty || publishing) return
    setPublishing(true)
    try {
      const next = await publishScenario(scenarioId, { revision: draft.baseline.revision })
      if (next.draft) draft.acceptServer({ revision: next.draft.revision, document: next.draft.document })
      queryClient.setQueryData(['scenarios', scenarioId], next)
      toast.success('已发布新版本')
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        markConflict()
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
      }
    } finally {
      setPublishing(false)
    }
  }

  function addStep(type: ExecutableStepType) {
    if (!document) return
    const nextStep = createBlankStep(type, documentContextKeys(document))
    const after = draft.selectedIndex
    draft.applyStructure(insertStep(document, nextStep, after), nextStep.id)
    setMobilePane('properties')
  }

  function changeType(type: ExecutableStepType) {
    if (!document || !draft.selected) return
    const next = createBlankStep(type, documentContextKeys({
      ...document,
      steps: document.steps.filter((step) => step.id !== draft.selected!.id),
    }))
    draft.applyStructure(
      {
        ...document,
        steps: document.steps.map((step) =>
          step.id === draft.selected!.id ? { ...next, id: step.id, name: step.name || next.name } : step,
        ),
      },
      draft.selected.id,
    )
    setTypeChange(null)
  }

  function confirmReload() {
    void query.refetch().then((result) => {
      if (result.data?.draft) {
        draft.acceptServer({ revision: result.data.draft.revision, document: result.data.draft.document })
      }
      setReloadOpen(false)
    })
  }

  function attachRun(run: RunDetailDto) {
    queryClient.setQueryData(['runs', run.id], run)
    void navigate({
      to: '/scenarios/$scenarioId',
      params: { scenarioId },
      search: { runId: run.id, editor: flowgram ? 'flowgram' : undefined },
      replace: true,
    })
  }

  return (
    <>
      <AppHeader
        fixed
        leading={
          <Link
            to='/scenarios'
            className='me-auto flex items-center gap-2 text-small text-muted-foreground hover:text-link'
            onClick={(event) => {
              if (!draft.dirty) return
              event.preventDefault()
              setLeaveOpen(true)
            }}
          >
            <ArrowLeft className='size-4' />
            返回场景
          </Link>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-5 overflow-x-clip'>
        <PageHeader
          title={scenario?.name ?? '场景'}
          description='编辑有序步骤、查看编译诊断。保存后再试跑；试跑结果留在本页，完整复盘另开。'
          actions={
            scenario && !query.isError ? (
              <div className='flex flex-wrap items-center gap-2'>
                {canWrite ? (
                  <Button
                    variant={draft.dirty ? 'default' : 'outline'}
                    disabled={!draft.dirty || saving}
                    loading={saving}
                    onClick={() => void save()}
                  >
                    <Save />
                    保存草稿
                  </Button>
                ) : null}
                {canTrial ? (
                  <Button onClick={() => setTrialOpen(true)}>
                    <Play />
                    试跑
                  </Button>
                ) : canStartFormalRun ? (
                  <Button variant='outline' disabled title={trialDisabledReason}>
                    <Play />
                    试跑
                  </Button>
                ) : null}
                {canWrite && (draft.dirty || unpublishedDraft) ? (
                  <Button
                    variant='outline'
                    disabled={!canPublish || publishing}
                    loading={publishing}
                    onClick={() => void publish()}
                  >
                    发布
                  </Button>
                ) : null}
                {canStartFormalRun && !draft.dirty && compile?.ok && !unpublishedDraft ? (
                  <Button variant='outline' onClick={() => setRunOpen(true)}>
                    运行已发布版本
                  </Button>
                ) : null}
                {canAssist && canReadTarget ? (
                  <Button
                    variant='outline'
                    onClick={() =>
                      openAssistant({
                        question: '解释当前步骤',
                        capabilityHint: 'scenario.explain',
                        pageContext: {
                          page: 'studio',
                          scenarioId,
                          stepId: draft.selected?.id,
                          ...(scenario.draft
                            ? { draftRevision: scenario.draft.revision }
                            : scenario.latestVersionId
                              ? { versionId: scenario.latestVersionId }
                              : {}),
                        },
                      })
                    }
                  >
                    解释步骤
                  </Button>
                ) : null}
                {canPropose ? (
                  <Button
                    variant='outline'
                    onClick={() =>
                      openAssistant({
                        question: '把这条指令写清楚',
                        capabilityHint: 'scenario.propose-step',
                        pageContext: {
                          page: 'studio',
                          scenarioId,
                          stepId: draft.selected!.id,
                          draftRevision: scenario.draft!.revision,
                        },
                      })
                    }
                  >
                    修改建议
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant='outline'>
                      更多
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align='end'>
                    {canWrite && !draft.dirty && !unpublishedDraft ? (
                      <DropdownMenuItem disabled={!canPublish || publishing} onClick={() => void publish()}>
                        发布
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem disabled={!canStartFormalRun} onClick={() => setRunOpen(true)}>
                      运行已发布版本
                    </DropdownMenuItem>
                    {canRecord ? (
                      <DropdownMenuItem
                        disabled={disabled}
                        onClick={() => {
                          if (draft.dirty || draft.hasFieldDrafts) {
                            toast.error('先保存草稿')
                            return
                          }
                          setImportOpen(true)
                        }}
                      >
                        导入已有录制
                      </DropdownMenuItem>
                    ) : null}
                    {canWrite ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => {
                            setNextName(scenario?.name ?? '')
                            setRenameOpen(true)
                          }}
                        >
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={disabled}
                          onClick={() => {
                            if (!scenario) return
                            const next = scenario.status === 'active' ? 'disabled' : 'active'
                            void updateScenario(scenario.id, { status: next })
                              .then(() => {
                                toast.success(next === 'active' ? '已启用' : '已停用')
                                void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
                              })
                              .catch((error) => {
                                toast.error(
                                  error instanceof ApiRequestError ? error.message : '更新失败',
                                )
                              })
                          }}
                        >
                          {scenario?.status === 'active' ? '停用' : '启用'}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {canDelete ? (
                      <DropdownMenuItem
                        className='text-destructive'
                        onClick={() => setRemoving(true)}
                      >
                        删除
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null
          }
        />
        {query.isPending || !document || !scenario ? (
          query.isError ? (
            <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
          ) : (
            <PageSkeleton />
          )
        ) : (
          <>
            {draft.conflict || draft.remoteStale ? (
              <Alert variant='warning'>
                <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                  {draft.conflict ? '他人已更新这份草稿。重新加载会丢掉未保存的本地修改。' : '服务端草稿已更新。本地修改仍保留，确认后才重载。'}
                  <Button size='sm' variant='outline' onClick={() => setReloadOpen(true)}>
                    重新加载
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {canStartFormalRun && !canTrial && draftHasAi && !canAi && !draft.dirty && compile?.ok ? (
              <Alert>
                <AlertDescription>缺少 AI 执行权限。仍可保存和发布，但不能试跑或创建含 AI 步骤的正式 Run。</AlertDescription>
              </Alert>
            ) : null}
            {!canTrial && !draft.dirty && compile && !compile.ok ? (
              <p className='text-label text-status-warning-foreground'>试跑不可用：{trialDisabledReason}。</p>
            ) : null}
            {openBinding ? (
              <Alert>
                <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                  <span>
                    {openBinding.status === 'issued'
                      ? `已发起录制「${openBinding.targetName}」。点击浏览器工具栏中的识途录制器图标继续，未挂上页面之前不算录制中。`
                      : openBinding.recordingDraftId
                        ? `场景「${openBinding.scenarioName}」的录制已上传，待预览回填。`
                        : `插件已领取「${openBinding.targetName}」。完成操作后上传，再回 Studio 预览。`}
                  </span>
                  <span className='flex flex-wrap gap-2'>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void recordingQuery.refetch()}
                    >
                      刷新批次
                    </Button>
                    {openBinding.recordingDraftId || (recordingQuery.data?.drafts[0] && canRecord) ? (
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() =>
                          setImportSearch(
                            openBinding.recordingDraftId ?? recordingQuery.data?.drafts[0]?.id,
                          )
                        }
                      >
                        预览回填
                      </Button>
                    ) : null}
                    {canWrite ? (
                      <Button size='sm' variant='ghost' onClick={() => void cancelRecording()}>
                        关闭绑定
                      </Button>
                    ) : null}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
            {scenario.status === 'disabled' || target?.status === 'disabled' ? (
              <Alert variant='warning'>
                <AlertDescription>
                  {scenario.status === 'disabled'
                    ? '场景已停用，不能发布或试跑。'
                    : '绑定的目标系统已停用，不能发布或试跑。'}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className='flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border-card bg-card px-5 py-4 shadow-card'>
              <div>
                <p className='text-label text-muted-foreground'>目标系统</p>
                {canReadTarget ? (
                  <Link
                    to='/targets/$targetId'
                    params={{ targetId: scenario.targetId }}
                    className='text-body font-medium text-link hover:underline'
                  >
                    {target?.name ?? scenario.targetId}
                  </Link>
                ) : (
                  <p className='font-mono text-label'>{scenario.targetId}</p>
                )}
              </div>
              <div>
                <p className='text-label text-muted-foreground'>已发布</p>
                <p className='text-body font-medium'>v{scenario.latestVersionNo}</p>
              </div>
              <div>
                <p className='text-label text-muted-foreground'>草稿</p>
                <p className='text-body font-medium'>r{draft.baseline?.revision ?? scenario.draft?.revision ?? 1}</p>
              </div>
              <StatusBadge tone={draft.dirty || scenario.draftDirty ? 'warning' : 'success'}>
                {draft.dirty ? '未保存' : scenario.draftDirty ? '有未发布草稿' : '与已发布一致'}
              </StatusBadge>
              {compile?.ok === false ? (
                <StatusBadge tone='error'>编译未通过</StatusBadge>
              ) : null}
              <StatusBadge tone={scenario.status === 'active' ? 'success' : 'neutral'}>
                {SCENARIO_STATUS_LABELS[scenario.status]}
              </StatusBadge>
            </div>
            <div className='flex gap-2 lg:hidden'>
              <Button
                size='sm'
                variant={mobilePane === 'steps' ? 'default' : 'outline'}
                aria-pressed={mobilePane === 'steps'}
                onClick={() => setMobilePane('steps')}
              >
                步骤
              </Button>
              <Button
                size='sm'
                variant={mobilePane === 'properties' ? 'default' : 'outline'}
                aria-pressed={mobilePane === 'properties'}
                onClick={() => setMobilePane('properties')}
              >
                属性
              </Button>
              {runId ? (
                <Button
                  size='sm'
                  variant={mobilePane === 'page' ? 'default' : 'outline'}
                  aria-pressed={mobilePane === 'page'}
                  onClick={() => setMobilePane('page')}
                >
                  页面
                </Button>
              ) : null}
            </div>
            <AuthoringObserveProvider
              runId={runId}
              selectedStepId={draft.selected?.id}
              enabled={Boolean(runId)}
              authoring={capabilitiesQuery.data?.authoring}
              onWriteBack={() => save()}
              onApplyTarget={(target) => {
                const current = draft.selected
                if (!current || !current.input || typeof current.input !== 'object' || !('target' in current.input)) {
                  return
                }
                draft.updateStep({ ...current, input: { ...current.input, target } } as typeof current)
              }}
            >
            {runId ? <StudioHoldBar runId={runId} /> : null}
            <div className='grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]'>
              <section
                aria-label='执行步骤'
                className={cn(
                  'min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card',
                  mobilePane !== 'steps' && 'max-lg:hidden',
                )}
              >
                <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider px-5 py-4'>
                  <h2 className='flex shrink-0 items-center gap-2 text-section font-semibold'>
                    <ListOrdered className='size-4 text-primary' />
                    执行步骤
                  </h2>
                  {canWrite ? (
                    <div className='flex flex-wrap items-center gap-2'>
                    {canRecord ? (
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={disabled || startingRecord}
                        loading={startingRecord}
                        onClick={() => void startRecording()}
                      >
                        <Video />
                        录制步骤
                      </Button>
                    ) : null}
                    <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || document.steps.length >= MAX_SCENARIO_STEPS}
                        >
                          <Plus />
                          添加步骤
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuLabel>确定性</DropdownMenuLabel>
                        {editableTypes
                          .filter((type) =>
                            ['navigate', 'click', 'fill', 'extract', 'assert', 'select', 'keyboard', 'wait'].includes(
                              type,
                            ),
                          )
                          .map((type) => (
                            <DropdownMenuItem key={type} onClick={() => addStep(type)}>
                              {stepTypeLabel(type)}
                            </DropdownMenuItem>
                          ))}
                        {editableTypes.some((type) => type.startsWith('ai_')) ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className='text-ai-foreground'>AI</DropdownMenuLabel>
                            {editableTypes
                              .filter((type) => type.startsWith('ai_'))
                              .map((type) => (
                                <DropdownMenuItem key={type} className='text-ai-foreground' onClick={() => addStep(type)}>
                                  {stepTypeLabel(type)}
                                </DropdownMenuItem>
                              ))}
                          </>
                        ) : null}
                        {unavailableStudioTypes(capabilitiesQuery.data).map((item) => (
                          <DropdownMenuItem key={item.type} disabled>
                            {stepTypeLabel(item.type)}（{item.message}）
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>调试夹具</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {editableTypes
                              .filter((type) => ['echo', 'delay', 'fail'].includes(type))
                              .map((type) => (
                                <DropdownMenuItem key={type} onClick={() => addStep(type)}>
                                  {stepTypeLabel(type)}
                                  <span className='text-label text-muted-foreground'> · {STEP_TYPE_HINTS[type]}</span>
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  ) : null}
                </div>
                <div className='flex flex-wrap items-center gap-2 border-b border-border-divider px-4 py-2'>
                  <div role='group' aria-label='步骤视图' className='flex gap-1'>
                    <Button size='sm' variant={!flowgram ? 'secondary' : 'ghost'} aria-pressed={!flowgram} onClick={() => void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId }, search: (prev) => ({ ...prev, editor: undefined }), replace: true })}>步骤列表</Button>
                    <Button size='sm' variant={flowgram ? 'secondary' : 'ghost'} aria-pressed={flowgram} onClick={() => void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId }, search: (prev) => ({ ...prev, editor: 'flowgram' }), replace: true })}>流程画布</Button>
                  </div>
                  <div className='flex min-w-0 flex-1 basis-48 items-center gap-1'>
                    <Button size='icon' variant='ghost' aria-label='定位上一步' title='定位上一步' disabled={draft.selectedIndex <= 0}
                      onClick={() => locateStep(document.steps[draft.selectedIndex - 1]!.id)}><ArrowLeft /></Button>
                    <Select value={draft.selected?.id ?? ''} onValueChange={locateStep}>
                      <SelectTrigger aria-label='定位步骤' className='min-w-0 flex-1'><SelectValue placeholder='定位步骤' /></SelectTrigger>
                      <SelectContent>
                        {document.steps.map((step, index) => <SelectItem key={step.id} value={step.id}>{String(index + 1).padStart(2, '0')} · {step.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size='icon' variant='ghost' aria-label='定位下一步' title='定位下一步' disabled={draft.selectedIndex >= document.steps.length - 1}
                      onClick={() => locateStep(document.steps[draft.selectedIndex + 1]!.id)}><ArrowRight /></Button>
                  </div>
                </div>
                {flowgram ? (
                  <Suspense fallback={<p className='p-6 text-small text-muted-foreground'>正在加载画布…</p>}>
                    <FlowgramCanvas
                      key={scenarioId}
                      trialRun={trialRun?.scenarioId === scenarioId ? trialRun : undefined}
                      document={document}
                      selectedId={draft.selected?.id ?? null}
                      navigation={stepNavigation}
                      layout={canvasLayout}
                      onLayoutChange={setCanvasLayout}
                      disabled={disabled}
                      diagnostics={compile?.diagnostics ?? []}
                      onSelect={(id) => {
                        draft.setSelectedId(id)
                        setMobilePane('properties')
                      }}
                      onInsertAfter={(id) => {
                        if (disabled || document.steps.length >= MAX_SCENARIO_STEPS) return
                        draft.setSelectedId(id)
                        setAddMenuOpen(true)
                      }}
                      onReorder={draft.applyStructure}
                    />
                  </Suspense>
                ) : (
                <ol ref={stepList} aria-label='有序步骤列表' className='max-h-[65vh] space-y-2 overflow-y-auto p-4'>
                  {document.steps.map((step, index) => {
                    const stepDiagnostics = (compile?.diagnostics ?? []).filter((item) => item.stepId === step.id)
                    const errorCount = stepDiagnostics.filter((item) => item.severity === 'error').length
                    const warningCount = stepDiagnostics.filter((item) => item.severity === 'warning').length
                    const imported = importedStepIds.includes(step.id)
                    return (
                      <li key={step.id} data-list-step={step.id} className='flex min-w-0 items-center gap-2'>
                        <span className='w-5 shrink-0 text-center font-mono text-label text-muted-foreground'>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <button
                          type='button'
                          aria-pressed={draft.selected?.id === step.id}
                          data-imported={imported || undefined}
                          onClick={() => {
                            draft.setSelectedId(step.id)
                            setMobilePane('properties')
                          }}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-3 rounded-md border p-4 text-left',
                            draft.selected?.id === step.id
                              ? 'border-selection-border bg-selection-background shadow-control-focus'
                              : 'border-border-default bg-card hover:bg-action-hover',
                          )}
                        >
                          <span className='min-w-0 flex-1'>
                            <span className='block text-body font-medium break-words'>{step.name}</span>
                            <span className='mt-1 flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
                              {holdingStepId === step.id ? <StatusBadge tone='warning'>挂起</StatusBadge> : null}
                              {imported ? <StatusBadge tone='info'>刚导入</StatusBadge> : null}
                              {isAiStepType(step.type) ? (
                                <StatusBadge tone='ai'>{stepTypeLabel(step.type)}</StatusBadge>
                              ) : (
                                stepTypeLabel(step.type)
                              )}
                              {step.outputKey ? <span>输出 {step.outputKey}</span> : null}
                              {errorCount > 0 ? <span className='inline-flex items-center gap-1 text-status-error-foreground'><TriangleAlert className='size-3' />{errorCount} 项错误</span> : null}
                              {warningCount > 0 ? <span className='inline-flex items-center gap-1'><Info className='size-3' />{warningCount} 项提醒</span> : null}
                            </span>
                          </span>
                          <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
                        </button>
                      </li>
                    )
                  })}
                </ol>
                )}
                <p className='border-t border-border-divider bg-surface-header px-5 py-3 text-label text-muted-foreground'>
                  {draft.selected
                    ? '新步骤插入到当前步骤之后。使用 Alt + ↑ / Alt + ↓ 重排；输入框内不拦截。'
                    : '未选中步骤时，新步骤追加到末尾。删除需要确认。'}
                </p>
              </section>
              <section
                aria-label={draft.selected ? '步骤属性' : '场景输入'}
                className={cn(
                  'min-w-0 rounded-lg border border-border-card bg-card shadow-card',
                  mobilePane !== 'properties' && 'max-lg:hidden',
                )}
              >
                <div className='border-b border-border-divider p-5'>
                  <p className='text-label text-muted-foreground'>
                    {draft.selected ? `步骤 ${draft.selectedIndex + 1} / ${document.steps.length}` : '场景级'}
                  </p>
                  <h2 className='mt-1 text-section font-semibold break-words'>
                    {draft.selected ? draft.selected.name : '输入与诊断'}
                  </h2>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='mt-2 lg:hidden'
                    onClick={() => setMobilePane('steps')}
                  >
                    返回步骤列表
                  </Button>
                </div>
                <div className='space-y-6 p-5'>
                  {draft.selected ? (
                    <>
                      <StepEditor
                        step={draft.selected}
                        index={draft.selectedIndex}
                        bindings={bindings}
                        shapes={shapes}
                        editableTypes={editableTypes}
                        diagnostics={(compile?.diagnostics ?? []) as CompileDiagnostic[]}
                        disabled={disabled}
                        onChange={draft.updateStep}
                        onRequestTypeChange={setTypeChange}
                      />
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || draft.selectedIndex === 0}
                          onClick={() => {
                            const next = moveStep(document, draft.selectedIndex, -1)
                            if (next) draft.applyStructure(next, draft.selected?.id ?? null)
                          }}
                        >
                          上移
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || draft.selectedIndex === document.steps.length - 1}
                          onClick={() => {
                            const next = moveStep(document, draft.selectedIndex, 1)
                            if (next) draft.applyStructure(next, draft.selected?.id ?? null)
                          }}
                        >
                          下移
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || document.steps.length <= 1}
                          onClick={() => setDeleteId(draft.selected!.id)}
                        >
                          删除
                        </Button>
                        <Button size='sm' variant='outline' disabled={!draft.undo} onClick={draft.undoStructure}>
                          <Undo2 />
                          撤销结构操作
                        </Button>
                      </div>
                    </>
                  ) : (
                    <InputsEditor
                      inputs={draft.displayInputs}
                      disabled={disabled}
                      onChange={draft.updateInputs}
                    />
                  )}
                  {!draft.selected ? (
                    <DiagnosticList
                      diagnostics={compile?.diagnostics ?? []}
                      onSelect={(item) => {
                        if (item.stepId) draft.setSelectedId(item.stepId)
                        queueMicrotask(() => focusStudioField(item))
                      }}
                    />
                  ) : (
                    <button
                      type='button'
                      className='text-small text-link hover:underline'
                      onClick={() => draft.setSelectedId(null)}
                    >
                      查看场景输入与全局诊断
                    </button>
                  )}
                </div>
              </section>
            {runId ? (
              <div className={cn(mobilePane !== 'page' && 'max-lg:hidden', 'min-w-0 lg:col-span-2')}>
                <TrialPanel
                  runId={runId}
                  scenarioId={scenarioId}
                  selectedDraftStepId={draft.selected?.id ?? null}
                  onSelectDraftStep={draft.setSelectedId}
                />
              </div>
            ) : null}
            </div>
            </AuthoringObserveProvider>
          </>
        )}
      </Main>
      <AlertDialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这一步？</AlertDialogTitle>
            <AlertDialogDescription>
              {consumers.length > 0
                ? `后续 ${consumers.map((item) => item.name).join('、')} 引用了它的输出。删除后保留这些失效引用，不会改成字面量。`
                : '删除后需要保存才会写入草稿。没有后续步骤引用这个输出。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!document || !deleteId) return
                const steps = document.steps.filter((step) => step.id !== deleteId)
                const nextSelected = steps[Math.max(0, draft.selectedIndex - 1)]?.id ?? null
                draft.applyStructure({ ...document, steps }, nextSelected)
                setDeleteId(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(typeChange)} onOpenChange={(open) => !open && setTypeChange(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>更换步骤类型？</AlertDialogTitle>
            <AlertDialogDescription>
              会重置专有输入和输出，但保留步骤 ID 和名称。不会把 AI 意图转成确定性动作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => typeChange && changeType(typeChange)}>更换类型</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={reloadOpen} onOpenChange={setReloadOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃本地修改并重载？</AlertDialogTitle>
            <AlertDialogDescription>确认后才会用服务端草稿覆盖当前编辑，没有强制覆盖入口。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReload}>确认重载</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>离开当前场景？</AlertDialogTitle>
            <AlertDialogDescription>未保存的修改或尚未合法的字段会丢失。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>留在本页</AlertDialogCancel>
            <AlertDialogAction onClick={() => void navigate({ to: '/scenarios' })}>离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {scenario ? (
        <RecordingImportPanel
          open={importOpen}
          scenarioId={scenarioId}
          recordingDraftId={importDraftId ?? null}
          revision={draft.baseline?.revision ?? scenario.draft?.revision ?? 1}
          insertAnchor={currentInsertAnchor}
          stepCount={document?.steps.length ?? 0}
          inputs={document?.inputs ?? []}
          canApply={canWrite}
          onOpenChange={(open) => {
            setImportOpen(open)
            if (!open) setImportSearch(undefined)
          }}
          onSelectDraft={setImportSearch}
          onConflict={markConflict}
          onApplied={(next, insertedIds) => {
            queryClient.setQueryData(['scenarios', scenarioId], next)
            if (next.draft) {
              draft.acceptServer({ revision: next.draft.revision, document: next.draft.document })
            }
            if (insertedIds[0]) draft.setSelectedId(insertedIds[0])
            queryClient.setQueryData(importedQueryKey, insertedIds)
            void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'recording-imports'] })
          }}
        />
      ) : null}
      {scenario && trialOpen ? (
        <TrialDialog
          open
          onOpenChange={setTrialOpen}
          scenarioId={scenario.id}
          targetId={scenario.targetId}
          revision={draft.baseline?.revision ?? 1}
          inputs={document?.inputs ?? []}
          onCreated={attachRun}
          onConflict={markConflict}
        />
      ) : null}
      {scenario && runOpen ? (
        <RunCreateDialog
          key={scenario.id}
          open
          onOpenChange={setRunOpen}
          defaultScenarioId={scenario.id}
          defaultTargetId={scenario.targetId}
        />
      ) : null}
      <AlertDialog open={renameOpen} onOpenChange={setRenameOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重命名场景</AlertDialogTitle>
            <AlertDialogDescription>只改展示名称，不改变步骤定义和历史运行。</AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label='场景名称'
            value={nextName}
            onChange={(event) => setNextName(event.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={renaming}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={renaming || !nextName.trim()}
              onClick={(event) => {
                event.preventDefault()
                if (!scenario || renaming) return
                setRenaming(true)
                void updateScenario(scenario.id, { name: nextName.trim() })
                  .then(() => {
                    toast.success('已重命名')
                    setRenameOpen(false)
                    void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
                  })
                  .catch((error) => {
                    toast.error(error instanceof ApiRequestError ? error.message : '重命名失败')
                  })
                  .finally(() => setRenaming(false))
              }}
            >
              保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ResourceDeleteDialog
        open={removing}
        onOpenChange={setRemoving}
        resourceId={scenarioId}
        resourceName={scenario?.name ?? ''}
        resourceType='scenario'
        previewFn={() => previewDeleteScenario(scenarioId)}
        deleteFn={(body) => deleteScenario(scenarioId, body)}
        onSuccess={() => {
          setRemoving(false)
          void queryClient.invalidateQueries({ queryKey: ['scenarios'] })
          void navigate({ to: '/scenarios' })
        }}
      />
    </>
  )
}

function DiagnosticList({
  diagnostics,
  onSelect,
}: {
  diagnostics: CompileDiagnostic[]
  onSelect: (item: CompileDiagnostic) => void
}) {
  if (diagnostics.length === 0) {
    return <p className='text-small text-muted-foreground'>当前没有编译诊断。</p>
  }
  return (
    <ul className='space-y-2' aria-label='编译诊断'>
      {diagnostics.map((item) => (
        <li key={`${item.code}-${item.stepId ?? item.inputKey ?? 'global'}-${item.message}`}>
          <button
            type='button'
            className={
              item.severity === 'error'
                ? 'w-full rounded-md bg-status-error-background p-3 text-left text-small text-status-error-foreground'
                : 'w-full rounded-md bg-status-warning-background p-3 text-left text-small text-status-warning-foreground'
            }
            onClick={() => onSelect(item)}
          >
            {item.message}
          </button>
        </li>
      ))}
    </ul>
  )
}
