import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ScenarioReportSettings } from '@/features/reports/profiles'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  canAdoptAssistantProposal,
  entityIdSchema,
  canExecuteRun,
  canTrialRun,
  FACTORY_COMPILE_RESOLUTION,
  hasPermission,
  isAiStepType,
  isFixtureStepType,
  isAuthoringDocumentV2,
  MAX_AUTHORING_NODES,
  MAX_SCENARIO_STEPS,
  type CompileDiagnostic,
  type CompileResolutionContext,
  type ExecutableStepType,
  type RecordingInsertAnchor,
  type RunDetailDto,
  outcomeCandidateMeaning,
  outcomeContractFromCandidate,
  proposeOutcomeCandidate,
  type ScenarioModuleInvocationNode,
} from '@cairn/shared'
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Info,
  Layers,
  ListOrdered,
  Monitor,
  Plus,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { closeRecordingBinding } from '@/lib/recordings-api'
import {
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
import { fetchAccountSession } from '@/lib/sessions-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { preferredPasswordAccountId } from '@/features/runs/target-account'
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
import { Checkbox } from '@/components/ui/checkbox'
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
import { Main } from '@/components/layout/main'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/status-badge'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { RunCreateDialog } from '@/features/runs/create-dialog'
import {
  createBlankStep,
  DETERMINISTIC_STUDIO_TYPES,
  selectableScenarioStudioTypes,
  STEP_TYPE_HINTS,
  unavailableStudioTypes,
} from './step-registry'
import { AuthoringObserveProvider } from './authoring-observe'
import { applyTargetToDraftStep, resolveHoldingDraftStepId } from './holding-writeback'
import { ResolutionSourceProvider } from '@/features/authoring/resolution-source'
import { InputsEditor, StepEditor } from './step-editor'
import { withPickedSemantic } from '@/features/authoring/fields/target'
import { expectFromPreviewText } from '@/features/authoring/pick-apply'
import { ScenarioResolutionStats } from './resolution-stats'
import { OutcomeListEditor } from '@/features/authoring/outcome-editor'
import { RuntimeInvariantEditor } from '@/features/authoring/invariant-editor'
import { resolveOutcomeWriteback } from '@cairn/authoring'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { TrialDialog } from './trial-dialog'
import { TrialPanel } from './trial-panel'
import { StudioScreen } from './studio-screen'
import { HealingCard } from '@/features/authoring/fields/healing-card'
import { stepTypeLabel } from './labels'
import { MapStepBinding } from '@/features/map/step-binding'
import { KnowledgeProposal } from '@/features/scenarios/knowledge-proposal'
import { RecordingImportPanel } from './recording-import-panel'
import { ScenarioValidationSummary } from './validation-summary'
import { StudioToolbar } from './studio-toolbar'
import { useStudioDraft } from './use-studio-draft'
import {
  authoringNodes,
  consecutiveExtractStepIds,
  findInsertedModuleInvocationId,
  documentContextKeysAny,
  documentHasAiSteps,
  documentNodeCount,
  documentUsesBrowser,
  focusStudioField,
  insertStep,
  isTypingTarget,
  moveNode,
  moveStep,
  nodeId,
  outputConsumers,
  priorBindings,
  priorBindingsV2,
  priorOutputShapesAny,
  removeAuthoringNode,
} from './studio-document'
import { InsertModuleDialog } from './insert-module-dialog'
import { ModuleInvocationEditor } from './module-invocation-editor'
import { ModuleExtractWizard } from './extract-wizard'
import { ModuleReplaceDialog } from './replace-module-dialog'

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
  const platformConfigQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
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
  const compileResolution = useMemo((): CompileResolutionContext | undefined => {
    const caps = capabilitiesQuery.data?.resolution
    const policy = target?.resolutionPolicy
    if (!caps && !policy) return undefined
    return {
      ceiling: caps?.ceiling ?? FACTORY_COMPILE_RESOLUTION.ceiling,
      default: caps?.default ?? FACTORY_COMPILE_RESOLUTION.default,
      targetCeiling: policy?.ceiling,
      targetPreference: policy?.preference,
      aiRungAvailable: caps?.aiRungAvailable,
      waitKindsAvailable: caps?.waitKindsAvailable,
    }
  }, [capabilitiesQuery.data?.resolution, target?.resolutionPolicy])
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
    compileResolution,
  )
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [typeChange, setTypeChange] = useState<ExecutableStepType | null>(null)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [insertModuleOpen, setInsertModuleOpen] = useState(false)
  const [extractIds, setExtractIds] = useState<string[]>([])
  const [extractOpen, setExtractOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const actionModulesEnabled = Boolean(capabilitiesQuery.data?.actionModules)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
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
  const [rightTab, setRightTab] = useState<'step' | 'inputs' | 'outcomes'>('step')
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const [stepNavigation, setStepNavigation] = useState<{ id: string; sequence: number } | null>(null)
  const [canvasLayout, setCanvasLayout] = useState<'vertical' | 'snake'>('snake')
  const [pipOpen, setPipOpen] = useState(false)
  function locateStep(id: string) {
    draft.setSelectedId(id)
    setRightTab('step')
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
  const canReadSession = Boolean(user && hasPermission(user.permissions, 'session:read'))
  const accountsQuery = useQuery({
    queryKey: ['target-accounts', scenario?.targetId],
    queryFn: () => fetchTargetAccounts(scenario!.targetId),
    enabled: Boolean(scenario?.targetId && canReadTarget),
  })
  const studioAccountId =
    trialRun?.targetAccountId ??
    (preferredPasswordAccountId(accountsQuery.data?.items ?? []) || undefined)
  const sessionQuery = useQuery({
    queryKey: ['account-session', scenario?.targetId, studioAccountId],
    queryFn: () => fetchAccountSession(scenario!.targetId, studioAccountId!),
    enabled: Boolean(scenario?.targetId && studioAccountId && canReadSession),
  })
  const studioSessionId =
    sessionQuery.data?.session?.status === 'OPEN' ? sessionQuery.data.session.id : undefined
  const openedPageForRun = useRef<string | null>(null)
  const holdingSelectKey = useRef<string | null>(null)
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
  const holdingDraftStepId = resolveHoldingDraftStepId(
    holdingStepId,
    trialRun?.snapshot.outcomeManifest,
    draft.nodes.filter((node) => node.kind === 'step').map((node) => node.step.id),
  )
  useEffect(() => {
    if (!holdingStepId || !trialRun) return
    const key = `${trialRun.id}:${holdingStepId}`
    if (holdingSelectKey.current === key) return
    holdingSelectKey.current = key
    if (holdingDraftStepId) {
      draft.setSelectedId(holdingDraftStepId)
      return
    }
    toast.message('挂起的步骤无法对应到当前草稿，未改选中步')
  }, [holdingDraftStepId, holdingStepId, trialRun])
  const canRecord = canWrite && canReadTarget
  const recordingQuery = useQuery({
    queryKey: ['scenarios', scenarioId, 'recording-imports'],
    queryFn: () => fetchRecordingImports(scenarioId),
    enabled: Boolean(scenario && canReadTarget),
  })
  const openBinding = recordingQuery.data?.bindings.find((item) => item.status !== 'closed')
  const pendingImportDraftId = openBinding?.recordingDraftId ?? recordingQuery.data?.drafts[0]?.id

  const document = draft.candidate
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const disabled = !canWrite || saving || publishing
  const compile = draft.compile ?? (draft.hasFieldDrafts ? null : scenario?.compile)
  const editableTypes = selectableScenarioStudioTypes(capabilitiesQuery.data)
  // 夹具类型由平台闸门决定是否出现在能力清单里，这里不再按字面量兜底。
  const fixtureTypes = editableTypes.filter((type) => isFixtureStepType(type))
  const supportsAuthoringV2 = Boolean(
    capabilitiesQuery.data?.authoringSchemaVersions?.includes(2),
  )
  const extractableStepIds =
    draft.v2Document && isAuthoringDocumentV2(document) ? consecutiveExtractStepIds(draft.v2Document, extractIds) : []
  const canExtract = Boolean(actionModulesEnabled && supportsAuthoringV2 && extractableStepIds.length > 0 && canWrite)
  const draftHasAi = Boolean(document && documentHasAiSteps(document))
  const nodeCount = document ? documentNodeCount(document) : 0
  const nodeLimit = draft.v2Document ? MAX_AUTHORING_NODES : MAX_SCENARIO_STEPS
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
  const consumers =
    document && deleteId && !isAuthoringDocumentV2(document)
      ? outputConsumers(document, document.steps.find((step) => step.id === deleteId)?.outputKey)
      : []
  const bindings =
    draft.v2Document && isAuthoringDocumentV2(document) && draft.selectedIndex >= 0
      ? priorBindingsV2(draft.v2Document, draft.selectedIndex)
      : document && !isAuthoringDocumentV2(document) && draft.selectedIndex >= 0
        ? priorBindings(document, draft.selectedIndex)
        : []
  const shapes =
    document && draft.selectedIndex >= 0 ? priorOutputShapesAny(document, draft.selectedIndex) : new Map()
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
    Boolean(scenario?.draft && draft.selected && document && !isAuthoringDocumentV2(document))

  useEffect(() => {
    if (!canPropose || !scenario?.draft || !document || isAuthoringDocumentV2(document)) {
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
        if (isAuthoringDocumentV2(current)) {
          const next = moveNode(current, selectedIndex, -1)
          if (next) applyStructure(next, draft.selectedId)
        } else {
          const next = moveStep(current, selectedIndex, -1)
          if (next) applyStructure(next, selectedStepId)
        }
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (isAuthoringDocumentV2(current)) {
          const next = moveNode(current, selectedIndex, 1)
          if (next) applyStructure(next, draft.selectedId)
        } else {
          const next = moveStep(current, selectedIndex, 1)
          if (next) applyStructure(next, selectedStepId)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applyStructure, canWrite, disabled, document, selectedIndex, selectedStepId, draft.selectedId])

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

  const currentInsertAnchor: RecordingInsertAnchor = draft.selectedId
    ? { kind: 'after', stepId: draft.selectedId }
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

  async function cancelRecording() {
    if (!openBinding) return
    try {
      await closeRecordingBinding(openBinding.id)
      await queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId, 'recording-imports'] })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '无法关闭录制绑定')
    }
  }

  async function save(): Promise<number | false> {
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
      return next.draft?.revision ?? false
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

  async function ensureDraftSaved(): Promise<number | null> {
    if (draft.hasFieldDrafts) {
      toast.error('先修正尚未合法的字段')
      draft.focusFirstDraft()
      return null
    }
    if (draft.dirty) {
      const revision = await save()
      return revision === false ? null : revision
    }
    return draft.baseline?.revision ?? scenario?.draft?.revision ?? 0
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
    const nextStep = createBlankStep(type, documentContextKeysAny(document))
    const after = draft.selectedIndex
    if (isAuthoringDocumentV2(document)) {
      draft.insertNode({ kind: 'step', step: nextStep }, after)
    } else {
      draft.applyStructure(insertStep(document, nextStep, after), nextStep.id)
    }
    setMobilePane('properties')
  }

  function insertModule(moduleId: string, versionId: string, name: string) {
    const invocation: ScenarioModuleInvocationNode = {
      kind: 'module',
      invocationId: crypto.randomUUID(),
      name,
      moduleId,
      moduleVersionId: versionId,
      implementationKey: 'default',
      inputBindings: {},
      outputBindings: {},
    }
    draft.insertNode(invocation, draft.selectedIndex)
    setMobilePane('properties')
  }

  function changeType(type: ExecutableStepType) {
    if (!document || !draft.selected) return
    const used = documentContextKeysAny(document)
    if (draft.selected.outputKey) used.delete(draft.selected.outputKey)
    const next = createBlankStep(type, used)
    if (isAuthoringDocumentV2(document) && draft.selectedNode?.kind === 'step') {
      draft.updateNode({
        kind: 'step',
        step: { ...next, id: draft.selected.id, name: draft.selected.name || next.name },
      })
      setTypeChange(null)
      return
    }
    if (!('steps' in document)) return
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
      <Main fixed fluid className='flex min-w-0 flex-1 flex-col overflow-hidden p-2 sm:p-2.5 md:p-3 xl:p-3.5 gap-0'>
        <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-card bg-card shadow-sm'>
          <StudioToolbar
          scenario={scenario}
          target={target}
          scenarioId={scenarioId}
          revision={draft.baseline?.revision ?? scenario?.draft?.revision ?? 1}
          dirty={draft.dirty}
          hasDraftDirty={Boolean(scenario?.draftDirty)}
          saving={saving}
          publishing={publishing}
          canWrite={canWrite}
          canTrial={canTrial}
          canStartFormalRun={canStartFormalRun}
          trialDisabledReason={trialDisabledReason}
          canPublish={canPublish}
          unpublishedDraft={unpublishedDraft}
          compileOk={compile?.ok}
          canReadTarget={canReadTarget}
          canAssist={canAssist}
          canPropose={canPropose}
          canRecord={canRecord}
          canDelete={canDelete}
          disabled={disabled}
          onSave={() => void save()}
          onPublish={() => void publish()}
          onStartTrial={() => setTrialOpen(true)}
          onOpenRun={() => setRunOpen(true)}
          onOpenImport={() => {
            if (draft.dirty || draft.hasFieldDrafts) {
              toast.error('先保存草稿')
              return
            }
            setImportOpen(true)
          }}
          onOpenRename={() => {
            setNextName(scenario?.name ?? '')
            setRenameOpen(true)
          }}
          onToggleStatus={() => {
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
          onOpenRemove={() => setRemoving(true)}
          onOpenAssistant={(question, hint) =>
            openAssistant({
              question,
              capabilityHint: hint,
              pageContext: {
                page: 'studio',
                scenarioId,
                stepId: draft.selected?.id,
                ...(scenario?.draft
                  ? { draftRevision: scenario.draft.revision }
                  : scenario?.latestVersionId
                    ? { versionId: scenario.latestVersionId }
                    : {}),
              },
            })
          }
          onLeave={(event) => {
            if (!draft.dirty) return
            event.preventDefault()
            setLeaveOpen(true)
          }}
        />
        {query.isPending || !document || !scenario ? (
          query.isError ? (
            <div className='p-6'>
              <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
            </div>
          ) : (
            <div className='p-6'>
              <PageSkeleton />
            </div>
          )
        ) : (
          <>
            {(draft.conflict || draft.remoteStale || pendingImportDraftId || (canStartFormalRun && !canTrial && draftHasAi && !canAi && !draft.dirty && compile?.ok) || !canTrial || scenario.status === 'disabled' || target?.status === 'disabled') ? (
              <div className='shrink-0 border-b border-border-divider bg-surface-header px-4 py-2 space-y-2'>
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
                    <AlertDescription>缺少 AI 执行权限。仍可保存和发布，但不能试跑或创建含 AI 步骤的正式运行。</AlertDescription>
                  </Alert>
                ) : null}
                {!canTrial &&
                !(canStartFormalRun && draftHasAi && !canAi && !draft.dirty && compile?.ok) ? (
                  <p className='text-label text-status-warning-foreground'>试跑不可用：{trialDisabledReason}。</p>
                ) : null}
                {pendingImportDraftId ? (
                  <Alert>
                    <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                      <span>
                        {openBinding?.recordingDraftId
                          ? `场景「${openBinding.scenarioName}」有已上传的录制，待预览回填。`
                          : '有可导入当前场景的录制草稿。'}
                      </span>
                      <span className='flex flex-wrap gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => void recordingQuery.refetch()}
                        >
                          刷新批次
                        </Button>
                        {canRecord ? (
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => setImportSearch(pendingImportDraftId)}
                          >
                            预览回填
                          </Button>
                        ) : null}
                        {canWrite && openBinding ? (
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
              </div>
            ) : null}
            <div className='flex shrink-0 gap-2 border-b border-border-divider bg-surface-header px-4 py-2 lg:hidden'>
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
              <Button
                size='sm'
                variant={mobilePane === 'page' ? 'default' : 'outline'}
                aria-pressed={mobilePane === 'page'}
                onClick={() => setMobilePane('page')}
              >
                页面
              </Button>
            </div>
            <AuthoringObserveProvider
              runId={runId}
              sessionId={studioSessionId}
              selectedStepId={draft.selected?.id}
              enabled={Boolean(runId || studioSessionId)}
              authoring={capabilitiesQuery.data?.authoring}
              onWriteBack={async () => Boolean(await save())}
              onEnsureStepOutputKey={(stepId, outputKey) => {
                const node = draft.nodes.find((n) => n.kind === 'step' && n.step.id === stepId)
                if (node && node.kind === 'step' && !node.step.outputKey) {
                  draft.updateStep({ ...node.step, outputKey })
                }
              }}
              onApplyTarget={(target, extras) => {
                const picked = withPickedSemantic(target)
                const previewText = extras?.previewText?.trim()
                const writeback = resolveOutcomeWriteback(
                  trialRun?.snapshot.outcomeManifest,
                  trialRun?.checkpoint?.stepId,
                )
                if (!extras?.addOutcome && writeback?.sourceStepId) {
                  draft.updateOutcomeTarget({
                    stepId: writeback.sourceStepId,
                    contractId: writeback.contractId,
                    target: picked,
                  })
                  return
                }
                if (!extras?.addOutcome && writeback?.scope === 'scenario') {
                  draft.updateOutcomeTarget({
                    contractId: writeback.contractId,
                    target: picked,
                    scenario: true,
                  })
                  return
                }
                const current = draft.selected
                if (current && extras?.addOutcome) {
                  const expect = previewText
                    ? expectFromPreviewText(previewText)
                    : { kind: 'exists' as const }
                  const candidate = proposeOutcomeCandidate({
                    meaning: outcomeCandidateMeaning({ expect, target: picked }),
                    scope: 'step',
                    provenance: 'manual',
                    target: picked,
                    expect,
                  })
                  const existing =
                    draft.selectedNode?.kind === 'step' ? draft.selectedNode.outcomes ?? [] : []
                  draft.updateOutcomes(current.id, [
                    ...existing,
                    outcomeContractFromCandidate(candidate, crypto.randomUUID()),
                  ])
                  return
                }
                if (!current || !current.input || typeof current.input !== 'object') {
                  return
                }
                if (current.type === 'assert') {
                  draft.updateStep({
                    ...current,
                    input: {
                      ...current.input,
                      target: picked,
                      expect: previewText
                        ? expectFromPreviewText(previewText)
                        : current.input.expect,
                    },
                  })
                  return
                }
                if (!('target' in current.input)) return
                draft.updateStep({
                  ...current,
                  input: {
                    ...current.input,
                    target: picked,
                  },
                } as typeof current)
              }}
            >
            <ResolutionSourceProvider targetId={scenario.targetId}>
            <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
              <div
                className={cn(
                  'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                  flowgram ? 'lg:flex-row' : 'lg:flex-row',
                )}
              >
              <section
                aria-label='执行步骤'
                className={cn(
                  flowgram
                    ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card'
                    : 'w-full lg:w-[230px] xl:w-[260px] 2xl:w-[290px] shrink-0 border-r border-border-divider bg-card flex flex-col min-h-0 overflow-hidden',
                  mobilePane !== 'steps' && 'max-lg:hidden',
                )}
              >
                <div className='flex items-center justify-between gap-1.5 border-b border-border-divider px-3 py-2 shrink-0'>
                  <h2 className='flex shrink-0 items-center gap-1.5 text-body font-semibold'>
                    <ListOrdered className='size-4 text-primary' />
                    <span>步骤</span>
                    <span className='font-mono text-label text-muted-foreground font-normal'>
                      ({nodeCount})
                    </span>
                  </h2>
                  {canWrite ? (
                    <div className='flex items-center gap-1 shrink-0'>
                    <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 px-2 text-label'
                          aria-label='添加步骤'
                          disabled={disabled || nodeCount >= nodeLimit}
                        >
                          <Plus className='size-3.5 mr-1' />
                          添加步骤
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        <DropdownMenuLabel>确定性</DropdownMenuLabel>
                        {editableTypes
                          .filter((type) =>
                            ['navigate', 'click', 'fill', 'extract', 'select', 'keyboard', 'wait'].includes(
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
                        {unavailableStudioTypes(capabilitiesQuery.data)
                          .filter((item) => item.type !== 'assert' && item.type !== 'ai_assert')
                          .map((item) => (
                            <DropdownMenuItem key={item.type} disabled>
                              {stepTypeLabel(item.type)}（{item.message}）
                            </DropdownMenuItem>
                          ))}
                        {fixtureTypes.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>调试夹具</DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {fixtureTypes.map((type) => (
                                  <DropdownMenuItem key={type} onClick={() => addStep(type)}>
                                    {stepTypeLabel(type)}
                                    <span className='text-label text-muted-foreground'> · {STEP_TYPE_HINTS[type]}</span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          </>
                        )}
                        {actionModulesEnabled && supportsAuthoringV2 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => {
                                window.setTimeout(() => setInsertModuleOpen(true), 0)
                              }}
                            >
                              <Layers className='size-4 mr-2 text-primary' />
                              动作模块…
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {canExtract ? (
                      <>
                        <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={() => setExtractOpen(true)}>
                          提炼为动作模块
                        </Button>
                        <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={() => setReplaceOpen(true)}>
                          替换为模块调用
                        </Button>
                      </>
                    ) : null}
                    </div>
                  ) : null}
                </div>
                <div className='flex flex-wrap items-center gap-1.5 border-b border-border-divider px-3 py-1.5 shrink-0 bg-surface-header'>
                  <div role='group' aria-label='步骤视图' className='flex gap-1'>
                    <Button
                      size='sm'
                      variant={!flowgram ? 'secondary' : 'ghost'}
                      className='h-7 px-2 text-label'
                      aria-pressed={!flowgram}
                      onClick={() =>
                        void navigate({
                          to: '/scenarios/$scenarioId',
                          params: { scenarioId },
                          search: (prev) => ({ ...prev, editor: undefined }),
                          replace: true,
                        })
                      }
                    >
                      步骤列表
                    </Button>
                    <Button
                      size='sm'
                      variant={flowgram ? 'secondary' : 'ghost'}
                      className='h-7 px-2 text-label'
                      aria-pressed={flowgram}
                      onClick={() =>
                        void navigate({
                          to: '/scenarios/$scenarioId',
                          params: { scenarioId },
                          search: (prev) => ({ ...prev, editor: 'flowgram' }),
                          replace: true,
                        })
                      }
                    >
                      流程画布
                    </Button>
                  </div>
                  <div className='flex min-w-0 flex-1 basis-40 items-center gap-0.5'>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-7 shrink-0'
                      aria-label='定位上一步'
                      title='定位上一步'
                      disabled={draft.selectedIndex <= 0}
                      onClick={() => {
                        const prev = authoringNodes(document)[draft.selectedIndex - 1]
                        if (prev) locateStep(nodeId(prev))
                      }}
                    >
                      <ArrowLeft className='size-3.5' />
                    </Button>
                    <Select value={draft.selectedId ?? ''} onValueChange={locateStep}>
                      <SelectTrigger aria-label='定位步骤' className='h-7 min-w-0 flex-1 text-label'>
                        <SelectValue placeholder='定位步骤' />
                      </SelectTrigger>
                      <SelectContent>
                        {authoringNodes(document).map((node, index) => (
                          <SelectItem key={nodeId(node)} value={nodeId(node)}>
                            {String(index + 1).padStart(2, '0')} · {node.kind === 'module' ? (node.name || '动作模块') : node.step.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-7 shrink-0'
                      aria-label='定位下一步'
                      title='定位下一步'
                      disabled={draft.selectedIndex >= nodeCount - 1}
                      onClick={() => {
                        const next = authoringNodes(document)[draft.selectedIndex + 1]
                        if (next) locateStep(nodeId(next))
                      }}
                    >
                      <ArrowRight className='size-3.5' />
                    </Button>
                  </div>
                </div>
                {flowgram ? (
                  <div className='relative min-w-0 flex-1'>
                    <Suspense fallback={<p className='p-6 text-small text-muted-foreground'>正在加载画布…</p>}>
                      <FlowgramCanvas
                        key={scenarioId}
                        trialRun={trialRun?.scenarioId === scenarioId ? trialRun : undefined}
                        document={document}
                        selectedId={draft.selectedId}
                        navigation={stepNavigation}
                        layout={canvasLayout}
                        onLayoutChange={setCanvasLayout}
                        disabled={disabled}
                        diagnostics={compile?.diagnostics ?? []}
                        onSelect={(id) => {
                          draft.setSelectedId(id)
                          setRightTab('step')
                          setMobilePane('properties')
                        }}
                        onInsertAfter={(id) => {
                          if (disabled || nodeCount >= nodeLimit) return
                          draft.setSelectedId(id)
                          setRightTab('step')
                          setAddMenuOpen(true)
                        }}
                        onReorder={draft.applyStructure}
                      />
                    </Suspense>
                    <div className='absolute bottom-4 right-4 z-20'>
                      {pipOpen ? (
                        <div className='w-[380px] overflow-hidden rounded-lg border border-border-card bg-card shadow-2xl'>
                          <div className='flex items-center justify-between border-b border-border-divider bg-muted/40 px-3 py-1.5'>
                            <span className='text-label font-medium text-foreground'>受管画面 (画中画)</span>
                            <Button
                              size='sm'
                              variant='ghost'
                              className='h-6 px-2 text-label'
                              onClick={() => setPipOpen(false)}
                            >
                              收起
                            </Button>
                          </div>
                          <div className='max-h-[320px] overflow-y-auto p-2'>
                            <StudioScreen
                              runId={runId}
                              scenarioId={scenarioId}
                              targetId={scenario.targetId}
                              targetAccountId={studioAccountId}
                              onStartTrial={() => setTrialOpen(true)}
                              selectedStepName={draft.selected?.name}
                              selectedIsFirst={
                                draft.selected || draft.selectedNode ? draft.selectedIndex === 0 : undefined
                              }
                              trialDisabledReason={canTrial ? undefined : trialDisabledReason}
                            />
                          </div>
                        </div>
                      ) : (
                        <Button
                          size='sm'
                          variant='secondary'
                          className='border border-border-default shadow-md'
                          onClick={() => setPipOpen(true)}
                        >
                          <Monitor className='mr-1.5 size-3.5 text-primary' />
                          查看受管画面
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                <ol ref={stepList} aria-label='有序步骤列表' className='flex-1 min-h-0 space-y-1.5 overflow-y-auto p-2'>
                  {authoringNodes(document).map((node, index) => {
                    const key = nodeId(node)
                    if (node.kind === 'module') {
                      const isSelected = draft.selectedId === key
                      const nodeDiagnostics = (compile?.diagnostics ?? []).filter((item) => item.stepId === key)
                      const errorCount = nodeDiagnostics.filter((item) => item.severity === 'error').length
                      const warningCount = nodeDiagnostics.filter((item) => item.severity === 'warning').length
                      return (
                        <li key={key} data-list-step={key} className='flex min-w-0 items-center gap-1.5'>
                          <span className='w-5 shrink-0 text-center font-mono text-label text-muted-foreground'>
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <button
                            type='button'
                            aria-pressed={isSelected}
                            onClick={() => {
                              draft.setSelectedId(key)
                              setRightTab('step')
                              setMobilePane('properties')
                            }}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-md border py-2 px-2.5 text-left',
                              isSelected
                                ? 'border-selection-border bg-selection-background shadow-control-focus'
                                : 'border-border-default bg-card hover:bg-action-hover',
                            )}
                          >
                            <span className='min-w-0 flex-1'>
                              <span className='flex items-center gap-1.5'>
                                <Layers className='size-3.5 text-primary shrink-0' />
                                <span className='block text-body font-medium break-words leading-snug'>
                                  {node.name || '动作模块'}
                                </span>
                              </span>
                              <span className='mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                                <StatusBadge tone='neutral'>动作模块</StatusBadge>
                                {errorCount > 0 ? (
                                  <span className='inline-flex items-center gap-0.5 text-status-error-foreground'>
                                    <TriangleAlert className='size-3' />{errorCount} 项错误
                                  </span>
                                ) : null}
                                {warningCount > 0 ? (
                                  <span className='inline-flex items-center gap-0.5'>
                                    <Info className='size-3' />{warningCount} 项提醒
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />
                          </button>
                        </li>
                      )
                    }

                    const step = node.step
                    const stepDiagnostics = (compile?.diagnostics ?? []).filter((item) => item.stepId === step.id)
                    const errorCount = stepDiagnostics.filter((item) => item.severity === 'error').length
                    const warningCount = stepDiagnostics.filter((item) => item.severity === 'warning').length
                    const imported = importedStepIds.includes(step.id)
                    return (
                      <li key={step.id} data-list-step={step.id} className='flex min-w-0 items-center gap-1.5'>
                        {actionModulesEnabled && supportsAuthoringV2 && isAuthoringDocumentV2(document) ? (
                          <Checkbox
                            aria-label={`选择提炼 ${step.name}`}
                            checked={extractIds.includes(step.id)}
                            onCheckedChange={(value) =>
                              setExtractIds((current) =>
                                value === true ? [...current, step.id] : current.filter((id) => id !== step.id),
                              )
                            }
                          />
                        ) : null}
                        <span className='w-5 shrink-0 text-center font-mono text-label text-muted-foreground'>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <button
                          type='button'
                          aria-pressed={draft.selected?.id === step.id}
                          data-imported={imported || undefined}
                          onClick={() => {
                            draft.setSelectedId(step.id)
                            setRightTab('step')
                            setMobilePane('properties')
                          }}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-md border py-2 px-2.5 text-left',
                            draft.selected?.id === step.id
                              ? 'border-selection-border bg-selection-background shadow-control-focus'
                              : 'border-border-default bg-card hover:bg-action-hover',
                          )}
                        >
                          <span className='min-w-0 flex-1'>
                            <span className='block text-body font-medium break-words leading-snug'>{step.name}</span>
                            <span className='mt-0.5 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                              {holdingDraftStepId === step.id ? <StatusBadge tone='warning'>挂起</StatusBadge> : null}
                              {imported ? <StatusBadge tone='info'>刚导入</StatusBadge> : null}
                              {isAiStepType(step.type) ? (
                                <StatusBadge tone='ai'>{stepTypeLabel(step.type)}</StatusBadge>
                              ) : (
                                stepTypeLabel(step.type)
                              )}
                              {step.outputKey ? <span>输出 {step.outputKey}</span> : null}
                              {errorCount > 0 ? <span className='inline-flex items-center gap-0.5 text-status-error-foreground'><TriangleAlert className='size-3' />{errorCount} 项错误</span> : null}
                              {warningCount > 0 ? <span className='inline-flex items-center gap-0.5'><Info className='size-3' />{warningCount} 项提醒</span> : null}
                            </span>
                          </span>
                          <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />
                        </button>
                      </li>
                    )
                  })}
                </ol>
                )}
                <p className='border-t border-border-divider bg-surface-header px-3 py-2 text-label text-muted-foreground shrink-0'>
                  {draft.selected
                    ? '新步骤插入到当前步骤之后。使用 Alt + ↑ / Alt + ↓ 重排；输入框内不拦截。'
                    : '未选中步骤时，新步骤追加到末尾。删除需要确认。'}
                </p>
              </section>
              {!flowgram ? (
                <div
                  className={cn(
                    mobilePane !== 'page' && 'max-lg:hidden',
                    'flex min-h-0 min-w-0 flex-1 flex-col bg-card overflow-hidden',
                  )}
                >
                  <StudioScreen
                    runId={runId}
                    scenarioId={scenarioId}
                    targetId={scenario.targetId}
                    targetAccountId={studioAccountId}
                    onStartTrial={() => setTrialOpen(true)}
                    selectedStepName={draft.selected?.name}
                    selectedIsFirst={
                      draft.selected || draft.selectedNode ? draft.selectedIndex === 0 : undefined
                    }
                    trialDisabledReason={canTrial ? undefined : trialDisabledReason}
                  />
                </div>
              ) : null}
              <div
                ref={rightPanelRef}
                className={cn(
                  'w-full lg:w-[320px] xl:w-[360px] 2xl:w-[420px] shrink-0 border-l border-border-divider bg-card flex flex-col min-h-0 overflow-y-auto',
                  mobilePane !== 'properties' && 'max-lg:hidden',
                )}
              >
                <section
                  aria-label={
                    rightTab === 'step'
                      ? (draft.selectedNode?.kind === 'module' ? '模块调用属性' : '步骤属性')
                      : '场景输入'
                  }
                  className='min-w-0 flex flex-col'
                >
                  <div className='border-b border-border-divider p-2.5 shrink-0 bg-surface-header space-y-2'>
                    <div
                      className='flex items-center gap-1 p-0.5 bg-muted/60 rounded-lg border border-border-divider/70 text-xs'
                      role='tablist'
                      aria-label='属性面板导航'
                    >
                      <button
                        type='button'
                        role='tab'
                        aria-selected={rightTab === 'step'}
                        className={cn(
                          'flex-1 py-1.5 px-2 rounded-md font-medium text-xs transition-all text-center',
                          rightTab === 'step'
                            ? 'bg-background text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          setRightTab('step')
                          if (!draft.selected && draft.nodes.length > 0) {
                            draft.setSelectedId(nodeId(draft.nodes[0]))
                          }
                        }}
                      >
                        步骤配置
                      </button>
                      <button
                        type='button'
                        role='tab'
                        aria-selected={rightTab === 'inputs'}
                        className={cn(
                          'flex-1 py-1.5 px-2 rounded-md font-medium text-xs transition-all text-center flex items-center justify-center gap-1.5',
                          rightTab === 'inputs'
                            ? 'bg-background text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          setRightTab('inputs')
                          draft.setSelectedId(null)
                          rightPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                        }}
                      >
                        <span>输入参数</span>
                        <span
                          className={cn(
                            'inline-flex items-center justify-center px-1.5 py-0.2 text-[10px] font-semibold rounded-full',
                            rightTab === 'inputs'
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {draft.displayInputs.length}
                        </span>
                      </button>
                      <button
                        type='button'
                        role='tab'
                        aria-selected={rightTab === 'outcomes'}
                        className={cn(
                          'flex-1 py-1.5 px-2 rounded-md font-medium text-xs transition-all text-center flex items-center justify-center gap-1.5',
                          rightTab === 'outcomes'
                            ? 'bg-background text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          setRightTab('outcomes')
                          draft.setSelectedId(null)
                          rightPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                        }}
                      >
                        <span>预期与诊断</span>
                        {(compile?.diagnostics?.length ?? 0) > 0 ? (
                          <span className='inline-flex items-center justify-center px-1.5 py-0.2 text-[10px] font-semibold rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                            {compile?.diagnostics?.length}
                          </span>
                        ) : null}
                      </button>
                    </div>

                    <div className='flex items-center justify-between px-1'>
                      <div className='min-w-0 flex-1'>
                        <p className='text-label text-muted-foreground'>
                          {rightTab === 'step' && draft.selectedNode
                            ? `${draft.selectedNode.kind === 'module' ? '模块' : '步骤'} ${draft.selectedIndex + 1} / ${draft.nodes.length}`
                            : '场景级'}
                        </p>
                        <h2 className='mt-0.5 text-section font-semibold break-words'>
                          {rightTab === 'step'
                            ? (draft.selectedNode?.kind === 'module'
                                ? (draft.selectedNode.name || '动作模块')
                                : draft.selected
                                  ? draft.selected.name
                                  : '请选择步骤')
                            : '输入与诊断'}
                        </h2>
                      </div>
                      <Button
                        size='sm'
                        variant='ghost'
                        className='lg:hidden'
                        onClick={() => setMobilePane('steps')}
                      >
                        返回步骤列表
                      </Button>
                    </div>
                  </div>
                  <div className='space-y-6 p-4'>
                    {trialRun && trialRun.scenarioId === scenarioId ? (
                      <HealingCard
                        run={trialRun}
                        onChanged={() => void queryClient.invalidateQueries({ queryKey: ['run-observation', trialRun.id] })}
                        onSaveToDraft={(target) => {
                          const node = draft.nodes.find(
                            (item) => item.kind === 'step' && item.step.id === holdingDraftStepId,
                          )
                          if (!node || node.kind !== 'step') {
                            toast.message('找不到要写回的失败步骤，未改其他步骤')
                            return
                          }
                          const next = applyTargetToDraftStep(node.step, target)
                          if (!next) {
                            toast.message('挂起的步骤没有可写回的页面对象')
                            return
                          }
                          draft.updateStep(next)
                        }}
                      />
                    ) : null}
                    {rightTab === 'step' ? (
                      draft.selectedNode?.kind === 'module' ? (
                        <>
                          {!supportsAuthoringV2 ? (
                            <Alert>
                              <AlertDescription>调用节点只读。需要更新编辑器才能修改动作模块引用。</AlertDescription>
                            </Alert>
                          ) : null}
                          <ModuleInvocationEditor
                            node={draft.selectedNode}
                            scenarioId={scenario.id}
                            scenarioInputs={draft.displayInputs}
                            priorBindings={draft.v2Document ? priorBindingsV2(draft.v2Document, draft.selectedIndex) : []}
                            baselineRevision={scenario.draft?.revision ?? 1}
                            document={draft.candidate!}
                            diagnostics={(compile?.diagnostics ?? []).filter((item) => item.stepId === (draft.selectedNode as any)?.invocationId)}
                            disabled={disabled || !supportsAuthoringV2}
                            onChange={(updated) => draft.updateNode(updated)}
                            onInlined={() => {
                              void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
                            }}
                          />
                          <div className='flex flex-wrap gap-2'>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || draft.selectedIndex === 0}
                              onClick={() => {
                                if (!draft.v2Document) return
                                const next = moveNode(draft.v2Document, draft.selectedIndex, -1)
                                if (next) draft.applyStructure(next, nodeId(draft.selectedNode!))
                              }}
                            >
                              上移
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || draft.selectedIndex === draft.nodes.length - 1}
                              onClick={() => {
                                if (!draft.v2Document) return
                                const next = moveNode(draft.v2Document, draft.selectedIndex, 1)
                                if (next) draft.applyStructure(next, nodeId(draft.selectedNode!))
                              }}
                            >
                              下移
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || draft.nodes.length <= 1}
                              onClick={() => setDeleteId(nodeId(draft.selectedNode!))}
                            >
                              删除
                            </Button>
                            <Button size='sm' variant='outline' disabled={!draft.undo} onClick={draft.undoStructure}>
                              <Undo2 />
                              撤销结构操作
                            </Button>
                          </div>
                        </>
                      ) : draft.selected ? (
                        <>
                          <StepEditor
                            step={draft.selected}
                            index={draft.selectedIndex}
                            bindings={bindings}
                            shapes={shapes}
                            editableTypes={editableTypes}
                            diagnostics={(compile?.diagnostics ?? []) as CompileDiagnostic[]}
                            disabled={disabled}
                            outcomes={
                              draft.selectedNode?.kind === 'step' ? draft.selectedNode.outcomes ?? [] : []
                            }
                            onChange={draft.updateStep}
                            onOutcomesChange={(outcomes) => { if (draft.selected) draft.updateOutcomes(draft.selected.id, outcomes) }}
                            onRequestTypeChange={setTypeChange}
                          />
                          <MapStepBinding
                            targetId={scenario.targetId}
                            scenarioId={scenario.id}
                            stepId={draft.selected.id}
                            draftRevision={scenario.draft?.revision ?? 0}
                            disabled={disabled}
                          />
                          {document && scenario.draft ? (
                            <KnowledgeProposal
                              scenarioId={scenario.id}
                              draftRevision={scenario.draft.revision}
                              document={document}
                              disabled={disabled || draft.dirty || draft.hasFieldDrafts || draft.conflict || draft.remoteStale}
                              onAccepted={(revision, next) => {
                                queryClient.setQueryData(['scenarios', scenarioId], {
                                  ...scenario,
                                  draft: { ...scenario.draft, revision, document: next },
                                })
                                if (draft.dirty || draft.hasFieldDrafts) {
                                  draft.setConflict(true)
                                  toast.error('建议已保存到服务器，编辑中的本地输入已保留，请处理草稿冲突。')
                                } else draft.acceptServer({ revision, document: next })
                              }}
                            />
                          ) : null}
                          <div className='flex flex-wrap gap-2'>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || draft.selectedIndex === 0}
                              onClick={() => {
                                if (isAuthoringDocumentV2(document) && draft.v2Document) {
                                  const next = moveNode(draft.v2Document, draft.selectedIndex, -1)
                                  if (next) draft.applyStructure(next, draft.selectedId)
                                  return
                                }
                                if (isAuthoringDocumentV2(document)) return
                                const next = moveStep(document, draft.selectedIndex, -1)
                                if (next) draft.applyStructure(next, draft.selected?.id ?? null)
                              }}
                            >
                              上移
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || draft.selectedIndex === nodeCount - 1}
                              onClick={() => {
                                if (isAuthoringDocumentV2(document) && draft.v2Document) {
                                  const next = moveNode(draft.v2Document, draft.selectedIndex, 1)
                                  if (next) draft.applyStructure(next, draft.selectedId)
                                  return
                                }
                                if (isAuthoringDocumentV2(document)) return
                                const next = moveStep(document, draft.selectedIndex, 1)
                                if (next) draft.applyStructure(next, draft.selected?.id ?? null)
                              }}
                            >
                              下移
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={disabled || nodeCount <= 1}
                              onClick={() => setDeleteId(draft.selected!.id)}
                            >
                              删除
                            </Button>
                            <Button size='sm' variant='outline' disabled={!draft.undo} onClick={draft.undoStructure}>
                              <Undo2 />
                              撤销结构操作
                            </Button>
                          </div>
                          <div className='pt-2 border-t border-border-divider/50'>
                            <button
                              type='button'
                              className='text-small text-link hover:underline'
                              onClick={() => {
                                draft.setSelectedId(null)
                                setRightTab('inputs')
                                rightPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                              }}
                            >
                              查看场景输入与全局诊断
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className='text-center py-12 px-4 space-y-3'>
                          <p className='text-sm text-muted-foreground'>未选中任何步骤</p>
                          {draft.nodes.length > 0 && (
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => {
                                draft.setSelectedId(nodeId(draft.nodes[0]))
                              }}
                            >
                              选择第 1 步 (
                                {draft.nodes[0].kind === 'step'
                                  ? draft.nodes[0].step.name
                                  : draft.nodes[0].name || '步骤 1'}
                              )
                            </Button>
                          )}
                        </div>
                      )
                    ) : rightTab === 'inputs' ? (
                      <>
                        <InputsEditor
                          inputs={draft.displayInputs}
                          disabled={disabled}
                          onChange={draft.updateInputs}
                        />
                        <ScenarioResolutionStats scenarioId={scenarioId} />
                        <DiagnosticList
                          diagnostics={compile?.diagnostics ?? []}
                          onSelect={(item) => {
                            if (item.stepId) {
                              draft.setSelectedId(item.stepId)
                              setRightTab('step')
                            }
                            queueMicrotask(() => focusStudioField(item))
                          }}
                        />
                        <div className='pt-3 border-t border-border-divider/60 flex items-center justify-between text-xs text-muted-foreground'>
                          <span>配置场景预期或全局约束？</span>
                          <button
                            type='button'
                            className='text-link hover:underline font-medium'
                            onClick={() => {
                              setRightTab('outcomes')
                              rightPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                            }}
                          >
                            前往预期与诊断 →
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <OutcomeListEditor
                          outcomes={draft.v2Document?.scenarioOutcomes ?? []}
                          scope='scenario'
                          disabled={disabled}
                          onChange={draft.updateScenarioOutcomes}
                        />
                        <RuntimeInvariantEditor
                          invariants={draft.v2Document?.runtimeInvariants ?? []}
                          disabled={disabled}
                          allowEachStepProbe={
                            platformConfigQuery.data?.document.runtimeInvariants.allowEachStepProbe
                          }
                          onChange={draft.updateRuntimeInvariants}
                        />
                        <ScenarioResolutionStats scenarioId={scenarioId} />
                        <DiagnosticList
                          diagnostics={compile?.diagnostics ?? []}
                          onSelect={(item) => {
                            if (item.stepId) {
                              draft.setSelectedId(item.stepId)
                              setRightTab('step')
                            }
                            queueMicrotask(() => focusStudioField(item))
                          }}
                        />
                        <ScenarioValidationSummary
                          scenarioId={scenarioId}
                          revision={scenario.draft?.revision ?? 1}
                          runUpdate={
                            trialRun
                              ? `${trialRun.id}:${trialRun.status}:${trialRun.outcomeStatus}:${trialRun.evidenceStatus}`
                              : undefined
                          }
                          dirty={draft.dirty}
                        />
                        {scenario && (
                          <ScenarioReportSettings
                            scenarioId={scenario.id}
                            targetId={scenario.targetId}
                          />
                        )}
                      </>
                    )}
                  </div>
                </section>
                {runId ? (
                  <div className='border-t border-border-divider p-4'>
                    <TrialPanel
                      runId={runId}
                      scenarioId={scenarioId}
                      selectedDraftStepId={draft.selectedId}
                      onSelectDraftStep={draft.setSelectedId}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            <div className='hidden lg:flex h-7 shrink-0 items-center justify-between border-t border-border-divider bg-surface-header px-4 text-label text-muted-foreground'>
              <span>快捷键：Alt + ↑ / Alt + ↓ 调整步骤顺序</span>
              <span>草稿 r{draft.baseline?.revision ?? scenario?.draft?.revision ?? 1} · {draft.dirty ? '有未保存修改' : '与服务端一致'}</span>
            </div>
            </div>
            </ResolutionSourceProvider>
            </AuthoringObserveProvider>
          </>
        )}
        </div>
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
                if (isAuthoringDocumentV2(document) && draft.v2Document) {
                  const next = removeAuthoringNode(draft.v2Document, deleteId)
                  const nextSelected = next.nodes[Math.max(0, draft.selectedIndex - 1)]
                  draft.applyStructure(next, nextSelected ? nodeId(nextSelected) : null)
                  setDeleteId(null)
                  return
                }
                if (!('steps' in document)) return
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
          stepCount={nodeCount}
          inputs={document?.inputs ?? []}
          independentSteps={document ? isAuthoringDocumentV2(document) ? document.nodes.flatMap((node) => node.kind === 'step' ? [{ id: node.step.id, name: node.step.name }] : []) : document.steps.map((step) => ({ id: step.id, name: step.name })) : []}
          canApply={canWrite && !draft.dirty}
          hasLocalChanges={draft.dirty}
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
          needsAccount={document ? documentUsesBrowser(document) : false}
          onCreated={attachRun}
          onConflict={markConflict}
        />
      ) : null}
      {scenario ? (
        <InsertModuleDialog
          open={insertModuleOpen}
          onOpenChange={setInsertModuleOpen}
          targetId={scenario.targetId}
          scenarioId={scenario.id}
          draftRevision={draft.baseline?.revision ?? scenario.draft?.revision ?? 0}
          anchorNodeId={draft.selectedId ?? undefined}
          onEnsureSaved={ensureDraftSaved}
          onSelect={(module, version) => insertModule(module.id, version.id, module.name)}
          onAccepted={(next) => {
            queryClient.setQueryData(['scenarios', scenarioId], next)
            if (next.draft) {
              const previous = document && isAuthoringDocumentV2(document) ? document : undefined
              draft.acceptServer({ revision: next.draft.revision, document: next.draft.document })
              if (isAuthoringDocumentV2(next.draft.document)) {
                const inserted = findInsertedModuleInvocationId(previous, next.draft.document)
                if (inserted) draft.setSelectedId(inserted)
              }
            }
          }}
          onInsertAiStep={() => addStep('ai_action')}
        />
      ) : null}
      {scenario && extractOpen ? (
        <ModuleExtractWizard
          open
          onOpenChange={setExtractOpen}
          scenarioId={scenario.id}
          stepIds={extractableStepIds}
        />
      ) : null}
      {scenario && replaceOpen ? (
        <ModuleReplaceDialog
          open
          onOpenChange={setReplaceOpen}
          scenarioId={scenario.id}
          targetId={scenario.targetId}
          stepIds={extractableStepIds}
          baseRevision={scenario.draft?.revision ?? draft.baseline?.revision ?? 0}
          onReplaced={() => {
            setReplaceOpen(false)
            setExtractIds([])
            void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
          }}
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
