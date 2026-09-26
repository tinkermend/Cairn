import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  authoringDocumentDigest,
  canAdoptAssistantProposal,
  canAdoptAuthoringProposal,
  entityIdSchema,
  normalizeAuthoringDocument,
  scenarioDocumentDigest,
  type AssistantAuthoringProposal,
  type AssistantProposal,
  type AuthoringOperation,
  canExecuteRun,
  canTrialRun,
  authoringHasControlBlocks,
  authoringSteps,
  walkAuthoringNodes,
  insertNodeAfter,
  unwrapBlock,
  wrapNodesInIfBlock,
  insertNodeAt,
  replaceNode,
  toAuthoringDocumentV2,
  FACTORY_COMPILE_RESOLUTION,
  hasPermission,
  isFixtureStepType,
  isAuthoringDocumentV2,
  isDemonstrationHandoffPlaceholder,
  MAX_AUTHORING_NODES,
  MAX_SCENARIO_STEPS,
  type AuthoringBlockNode,
  type CompileDiagnostic,
  type CompileResolutionContext,
  type DemonstrationPlacement,
  type ExecutableStepType,
  type RecordingInsertAnchor,
  type RunDetailDto,
  outcomeCandidateMeaning,
  outcomeContractFromCandidate,
  proposeOutcomeCandidate,
  type ScenarioModuleInvocationNode,
  type Step,
  type RepairCandidate,
} from '@cairn/shared'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Layers,
  ListOrdered,
  Monitor,
  Plus,
  Settings,
  Sparkles,
  Undo2,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { applyAuthoringOperations } from '@cairn/authoring'
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
import { debugRun, observeRun } from '@/lib/runs-api'
import { fetchAccountSession } from '@/lib/sessions-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { preferredPasswordAccountId } from '@/features/runs/target-account'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import { buildDiagnosticQuote } from '@/features/assistant/quote-helper'
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
import { applyTargetToDraftStep, resolveHoldingDraftStepId, retryTargetForCheckpoint } from './holding-writeback'
import { ResolutionSourceProvider } from '@/features/authoring/resolution-source'
import { InputsEditor } from './step-editor'
import { ScenarioOutputsEditor } from './scenario-outputs-editor'
import { withPickedSemantic } from '@/features/authoring/fields/target'
import { expectFromPreviewText } from '@/features/authoring/pick-apply'
import { ScenarioResolutionStats } from './resolution-stats'
import { ScenarioSettingsDialog } from './scenario-settings-dialog'
import { OutcomeListEditor } from '@/features/authoring/outcome-editor'
import { RuntimeInvariantEditor } from '@/features/authoring/invariant-editor'
import { resolveOutcomeWriteback } from '@cairn/authoring'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { TrialDialog } from './trial-dialog'
import { TrialPanel } from './trial-panel'
import { StudioScreen } from './studio-screen'
import { HealingCard } from '@/features/authoring/fields/healing-card'
import { HealingPatchCard } from '@/features/authoring/healing-patch-card'
import {
  fetchScenarioRepairCandidates,
  adoptRepairCandidate,
  rejectRepairCandidate,
  reopenRepairCandidate,
  validateRepairCandidate,
} from '@/lib/repair-api'
import { stepTypeLabel } from './labels'
import { StepTypeIcon } from './step-type-icon'
import { MapStepBinding } from '@/features/map/step-binding'
import { KnowledgeProposal } from '@/features/scenarios/knowledge-proposal'
import { RecordingImportPanel } from './recording-import-panel'
import { ScenarioValidationSummary } from './validation-summary'
import { StudioToolbar } from './studio-toolbar'
import { StudioSplitterLayout, type StudioViewPreset } from './components/studio-splitter-layout'
import { StepPipelineRail } from './components/step-pipeline-rail'
import { PublishDiffDrawer } from './components/publish-diff-drawer'
import { ManagedStageScreen } from './components/managed-stage-screen'
import { StudioInspectorHost } from './components/inspector/studio-inspector-host'
import { SegmentedStepInspector } from './components/inspector/segmented-step-inspector'
import { useStudioDraft } from './use-studio-draft'
import { useScenarioLocatorHealth } from './use-scenario-locator-health'
import {
  authoringNodes,
  consecutiveExtractStepIds,
  createBlankBlockNode,
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
  outputConsumersAny,
  priorBindings,
  priorBindingsV2,
  priorOutputShapesAny,
  removeAuthoringNode,
} from './studio-document'
import { STEP_SNIPPET_TEMPLATES, instantiateSnippet } from './snippets/step-snippets'
import { InsertModuleDialog } from './insert-module-dialog'
import { ModuleInvocationEditor } from './module-invocation-editor'
import { BlockNodeEditor } from './components/inspector/block-node-editor'
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
  const importPlacementParam = (search as { importPlacement?: unknown }).importPlacement
  const importNodeIdParam = entityIdSchema.optional().safeParse((search as { importNodeId?: unknown }).importNodeId).data
  const initialImportPlacement = useMemo<DemonstrationPlacement | undefined>(() => {
    if (importPlacementParam === 'replace_sequence' && importNodeIdParam) {
      return { kind: 'replace_sequence', nodeId: importNodeIdParam }
    }
    if (importPlacementParam === 'replace' && importNodeIdParam) {
      return { kind: 'replace', nodeId: importNodeIdParam }
    }
    return undefined
  }, [importPlacementParam, importNodeIdParam])
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
  const registerRollbackHandler = useAssistantStore((state) => state.registerRollbackHandler)
  const setLastAdopted = useAssistantStore((state) => state.setLastAdopted)
  const previewStepId = useAssistantStore((state) => state.previewStepId)
  const setPreviewStepId = useAssistantStore((state) => state.setPreviewStepId)
  const setTrackedRunId = useAssistantStore((state) => state.setTrackedRunId)
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
    if (!caps && !policy && !platformConfigQuery.data) return undefined
    return {
      ceiling: caps?.ceiling ?? FACTORY_COMPILE_RESOLUTION.ceiling,
      default: caps?.default ?? FACTORY_COMPILE_RESOLUTION.default,
      targetCeiling: policy?.ceiling,
      targetPreference: policy?.preference,
      aiRungAvailable: caps?.aiRungAvailable,
      waitKindsAvailable: caps?.waitKindsAvailable,
      locatorDocument: platformConfigQuery.data?.document,
      locatorTarget: policy,
    }
  }, [capabilitiesQuery.data?.resolution, target?.resolutionPolicy, platformConfigQuery.data])
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

  useEffect(() => {
    if (
      flowgram &&
      draft.candidate &&
      isAuthoringDocumentV2(draft.candidate) &&
      authoringHasControlBlocks(draft.candidate)
    ) {
      void navigate({
        to: '/scenarios/$scenarioId',
        params: { scenarioId },
        search: (prev: any) => ({ ...prev, editor: undefined }),
        replace: true,
      })
    }
  }, [flowgram, draft.candidate, navigate, scenarioId])

  useAssistantContextBinding(
    scenario
      ? {
          page: 'studio',
          scenarioId,
          targetId: scenario.targetId,
          selectedStepId: draft.selected?.id,
          statusLabel: draft.selected
            ? `当前步骤 · ${(() => {
                const steps = authoringSteps(draft.v2Document)
                const idx = steps.findIndex((s) => s.id === draft.selected?.id)
                const prefix = idx >= 0 ? `第 ${idx + 1} 步 · ` : ''
                return `${prefix}${draft.selected.name || '未命名步骤'}`
              })()}`
            : `当前场景 · ${scenario.name}`,
          statusSummary: `${scenario.name} (草稿 r${draft.baseline?.revision ?? scenario.draft?.revision ?? 1})`,
          summaryText: draft.selected
            ? `已聚焦步骤「${draft.selected.name || '未命名步骤'}」，可向助手提问选择器诊断、断言编写或逻辑解释。`
            : `场景「${scenario.name}」草稿编辑中，共 ${authoringSteps(draft.v2Document).length} 个步骤。`,
          isDirty: draft.dirty,
          ...(scenario.draft && scenario.draft.revision >= 1
            ? { draftRevision: scenario.draft.revision }
            : scenario.latestVersionId
              ? { versionId: scenario.latestVersionId }
              : {}),
        }
      : {
          page: 'studio',
          scenarioId,
          statusLabel: '当前场景 · 加载中...',
          statusSummary: '加载中...',
        }
  )

  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishDiffOpen, setPublishDiffOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [typeChange, setTypeChange] = useState<ExecutableStepType | null>(null)
  const [keepTypeChangeName, setKeepTypeChangeName] = useState(false)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [insertModuleOpen, setInsertModuleOpen] = useState(false)
  const [extractIds, setExtractIds] = useState<string[]>([])
  const [extractOpen, setExtractOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const actionModulesEnabled = Boolean(capabilitiesQuery.data?.actionModules)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  const [trialPauseBeforeStepId, setTrialPauseBeforeStepId] = useState<string | undefined>(undefined)
  const [retryConfirm, setRetryConfirm] = useState<'side_effect' | 'page_changed' | null>(null)
  const [retryingStep, setRetryingStep] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const [viewPreset, setViewPreset] = useState<StudioViewPreset>('balanced')
  const [rightTab, setRightTab] = useState<'step' | 'inputs' | 'outputs' | 'outcomes'>('step')
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
  const [recordingBannerDismissed, setRecordingBannerDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.sessionStorage.getItem(`cairn:dismissed-rec-banner:${scenarioId}`) === 'true'
    } catch {
      return false
    }
  })
  function dismissRecordingBanner() {
    setRecordingBannerDismissed(true)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(`cairn:dismissed-rec-banner:${scenarioId}`, 'true')
      } catch {
        // ignore
      }
    }
  }
  useEffect(() => {
    if (draft.selectedId && rightTab === 'step') {
      rightPanelRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    }
  }, [draft.selectedId, rightTab])
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

  const repairCandidatesQuery = useQuery({
    queryKey: ['scenario-repair-candidates', scenarioId],
    queryFn: () => fetchScenarioRepairCandidates(scenarioId),
    enabled: Boolean(scenarioId),
  })
  const [selectedRepairCandidateId, setSelectedRepairCandidateId] = useState<string | undefined>()

  const stepRepairCandidates = useMemo(() => {
    if (!draft.selected?.id || !repairCandidatesQuery.data) return []
    return repairCandidatesQuery.data.filter(
      (c) => c.patchTargetRef.stepId === draft.selected?.id && c.status !== 'expired',
    )
  }, [repairCandidatesQuery.data, draft.selected?.id])

  const handleAdoptRepairCandidate = async (candidateId: string, expectedRevision: number) => {
    try {
      await adoptRepairCandidate(candidateId, { expectedRevision })
      toast.success('已采纳修复候选到草稿')
      void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
    } catch (err: any) {
      toast.error(err?.message || '采纳修复候选失败')
    }
  }

  const handleRejectRepairCandidate = async (candidateId: string, reason?: string) => {
    try {
      await rejectRepairCandidate(candidateId, { reason })
      toast.success('已驳回修复候选')
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
    } catch (err: any) {
      toast.error(err?.message || '驳回修复候选失败')
    }
  }

  const handleReopenRepairCandidate = async (candidateId: string) => {
    try {
      await reopenRepairCandidate(candidateId)
      toast.success('已重新打开修复候选')
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
    } catch (err: any) {
      toast.error(err?.message || '重新打开修复候选失败')
    }
  }

  const handleValidateRepairCandidate = async (candidateId: string) => {
    try {
      const res = await validateRepairCandidate(candidateId)
      toast.success(`已发起验证试跑 (Run ${res.runId.slice(0, 8)})`)
      void queryClient.invalidateQueries({ queryKey: ['scenario-repair-candidates', scenarioId] })
      void navigate({
        to: '/scenarios/$scenarioId',
        params: { scenarioId },
        search: (prev: any) => ({ ...prev, runId: res.runId }),
        replace: true,
      })
    } catch (err: any) {
      toast.error(err?.message || '发起验证试跑失败')
    }
  }

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
    authoringSteps(draft.v2Document).map((step) => step.id),
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
  const scenarioSteps = useMemo(() => (document ? authoringSteps(document) : []), [document])

  const handleApplyCandidatesToDraft = (
    candidatesToApply: Array<{
      stepId: string
      candidate: NonNullable<RepairCandidate['patch']['suggestedCandidate']>
    }>,
  ) => {
    for (const { stepId, candidate } of candidatesToApply) {
      const targetStep = authoringSteps(draft.v2Document).find((s) => s.id === stepId)
      if (targetStep && 'target' in targetStep && (targetStep as any).target?.kind === 'element') {
        const existingCandidates = (targetStep as any).target.candidates ?? []
        const nextCandidates = [
          candidate,
          ...existingCandidates.filter((c: any) => !(c.by === candidate.by && c.value === candidate.value)),
        ]
        draft.updateStep({
          ...targetStep,
          target: {
            ...(targetStep as any).target,
            candidates: nextCandidates,
          },
        } as unknown as Step)
      }
    }
  }

  const locatorHealth = useScenarioLocatorHealth(
    scenarioId,
    scenarioSteps,
    handleApplyCandidatesToDraft,
  )
  const [addMenuOpen, setAddMenuOpen] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ actionKey?: string }>
      if (custom.detail?.actionKey === 'open-add-step-menu') {
        setAddMenuOpen(true)
      }
    }
    window.addEventListener('cairn:assistant-action', handler)
    return () => window.removeEventListener('cairn:assistant-action', handler)
  }, [])
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
      !draft.hasFieldDrafts &&
      compile?.ok &&
      scenario &&
      scenario.status === 'active' &&
      target?.status !== 'disabled' &&
      !draft.conflict &&
      !draft.remoteStale,
  )
  const unpublishedDraft = Boolean(scenario?.draftDirty)
  const deleteNode = document ? authoringNodes(document).find((node) => nodeId(node) === deleteId) : undefined
  const deleteOutputKey = deleteNode?.kind === 'step' ? deleteNode.step.outputKey : undefined
  const consumers = outputConsumersAny(document, deleteOutputKey)
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
    Boolean(scenario?.draft && document)

  const preAdoptSnapshotRef = useRef<any>(null)

  useEffect(() => {
    if (!scenario?.draft || !document) {
      registerAdoptHandler(null)
      registerRollbackHandler(null)
      return
    }
    const revision = scenario.draft.revision
    const current = document

    registerAdoptHandler(async (proposal: AssistantProposal | AssistantAuthoringProposal) => {
      if (proposal.kind === 'authoring_proposal') {
        const v2 = normalizeAuthoringDocument(current)
        const allowed = await canAdoptAuthoringProposal({
          proposal,
          revision,
          document: v2,
          hasFieldDrafts: draft.hasFieldDrafts,
          remoteConflict: draft.conflict || draft.remoteStale,
        })
        if (!allowed.ok) return allowed

        const applied = applyAuthoringOperations(v2, proposal.operations)
        if (!applied.ok) {
          return { ok: false, reason: applied.error.message }
        }

        preAdoptSnapshotRef.current = structuredClone(v2)

        const firstInsert = proposal.operations.find(
          (op): op is Extract<AuthoringOperation, { kind: 'insert_step' }> => op.kind === 'insert_step',
        )
        const firstWithStepId = proposal.operations.find(
          (op): op is Extract<AuthoringOperation, { stepId: string }> => 'stepId' in op,
        )
        const targetStepId = firstInsert?.step.id ?? firstWithStepId?.stepId ?? null

        applyStructure(applied.document, targetStepId)
        const newDigest = await authoringDocumentDigest(applied.document)
        setLastAdopted({ proposalId: proposal.proposalId, digest: newDigest })
        return { ok: true, digest: newDigest }
      }

      if (!isAuthoringDocumentV2(current)) {
        const allowed = await canAdoptAssistantProposal({
          proposal,
          revision,
          document: current,
          hasFieldDrafts: draft.hasFieldDrafts,
          remoteConflict: draft.conflict || draft.remoteStale,
        })
        if (!allowed.ok) return allowed
        applyStructure(proposal.document, proposal.stepId)
        const newDigest = await scenarioDocumentDigest(proposal.document)
        setLastAdopted({ proposalId: proposal.stepId, digest: newDigest })
        return { ok: true, digest: newDigest }
      }

      const v2 = current
      const stepNodes = authoringSteps(v2)
      const baseDoc = {
        schemaVersion: 1 as const,
        inputs: v2.inputs,
        steps: stepNodes,
      }
      const allowed = await canAdoptAssistantProposal({
        proposal,
        revision,
        document: baseDoc,
        hasFieldDrafts: draft.hasFieldDrafts,
        remoteConflict: draft.conflict || draft.remoteStale,
      })
      if (!allowed.ok) return allowed

      const updatedStep = proposal.document.steps.find((s) => s.id === proposal.stepId)
      const nextDoc = updatedStep ? replaceNode(v2, proposal.stepId, { kind: 'step', step: updatedStep }) : v2
      applyStructure(nextDoc, proposal.stepId)
      const newDigest = await scenarioDocumentDigest(proposal.document)
      setLastAdopted({ proposalId: proposal.stepId, digest: newDigest })
      return { ok: true, digest: newDigest }
    })

    registerRollbackHandler(async (proposal: AssistantProposal | AssistantAuthoringProposal) => {
      if (proposal.kind === 'authoring_proposal' && preAdoptSnapshotRef.current) {
        applyStructure(preAdoptSnapshotRef.current, null)
        preAdoptSnapshotRef.current = null
        setLastAdopted(null)
        return { ok: true }
      }
      draft.undoStructure()
      setLastAdopted(null)
      return { ok: true }
    })

    return () => {
      registerAdoptHandler(null)
      registerRollbackHandler(null)
    }
  }, [
    applyStructure,
    document,
    draft.conflict,
    draft.hasFieldDrafts,
    draft.remoteStale,
    draft.undoStructure,
    registerAdoptHandler,
    registerRollbackHandler,
    scenario?.draft,
    setLastAdopted,
  ])

  useEffect(() => {
    if (!previewStepId) return
    locateStep(previewStepId)
    const timer = setTimeout(() => {
      setPreviewStepId(null)
    }, 3000)
    return () => clearTimeout(timer)
  }, [previewStepId, setPreviewStepId])

  useEffect(() => {
    if (search.action === 'inspect-step' && search.step_id) {
      locateStep(search.step_id)
      void navigate({
        to: '/scenarios/$scenarioId',
        params: { scenarioId },
        search: {
          editor: search.editor,
          runId: search.runId,
          import: search.import,
        },
        replace: true,
      })
    }
  }, [search.action, search.step_id, scenarioId, search.editor, search.runId, search.import, navigate])

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
      setPublishDiffOpen(false)
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        markConflict()
        setPublishDiffOpen(false)
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
      }
    } finally {
      setPublishing(false)
    }
  }

  async function handleStartPublish() {
    if (publishing || !scenario) return
    if (draft.hasFieldDrafts) {
      toast.error('先修正尚未合法的字段')
      draft.focusFirstDraft()
      return
    }
    if (draft.conflict || draft.remoteStale) {
      toast.error('他人已更新这份草稿，请重新加载')
      return
    }
    if (compile?.ok === false) {
      toast.error('场景存在编译错误，无法发布')
      return
    }
    if (draft.dirty) {
      const res = await save()
      if (res === false) return
    }
    setPublishDiffOpen(true)
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
    setRightTab('step')
    setMobilePane('properties')
  }

  function addBlock(name?: string) {
    if (!document) return
    const blockNode = createBlankBlockNode(name)
    const after = draft.selectedIndex
    if (isAuthoringDocumentV2(document)) {
      draft.insertNode(blockNode, after)
    } else {
      const v2 = toAuthoringDocumentV2(document)
      const inserted = insertNodeAfter(v2, null, blockNode)
      draft.applyStructure(inserted, blockNode.blockId)
    }
    setRightTab('step')
    setMobilePane('properties')
  }

  function wrapSelection() {
    if (!document) return
    const v2 = isAuthoringDocumentV2(document) ? document : toAuthoringDocumentV2(document)
    const blockId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `blk_${Math.random().toString(36).slice(2, 10)}`
    const result = wrapNodesInIfBlock(v2, extractIds, { blockId, name: '满足条件时执行' })
    if (!result.ok) {
      toast.error(result.reason)
      return
    }
    draft.applyStructure(result.document, blockId)
    setExtractIds([])
    setRightTab('step')
    setMobilePane('properties')
  }

  function unwrapSelectedBlock(blockId: string) {
    if (!document || !isAuthoringDocumentV2(document)) return
    const result = unwrapBlock(document, blockId)
    if (!result.ok) {
      toast.error(result.reason)
      return
    }
    draft.applyStructure(result.document, draft.selectedId === blockId ? null : draft.selectedId)
  }

  function addProbeAndBlock() {
    if (!document) return
    const probeStep = createBlankStep('probe', documentContextKeysAny(document))
    probeStep.name = '检查页面元素'
    const probeKey = probeStep.outputKey || 'probe'
    const blockNode: AuthoringBlockNode = {
      kind: 'block',
      blockId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `blk_${Math.random().toString(36).slice(2, 10)}`,
      name: '若元素存在则处理',
      control: {
        type: 'if',
        condition: {
          kind: 'compare',
          op: 'eq',
          left: { kind: 'ref', key: probeKey, field: 'matched' },
          right: { kind: 'literal', value: true },
        },
      },
      then: [
        {
          kind: 'step',
          step: createBlankStep('wait'),
        },
      ],
    }

    if (isAuthoringDocumentV2(document)) {
      const allNodes = walkAuthoringNodes(document)
      let anchorId: string | undefined = undefined
      if (draft.selectedIndex >= 0 && draft.selectedIndex < allNodes.length) {
        anchorId = allNodes[draft.selectedIndex]!.id
      } else if (draft.selectedIndex < 0 && allNodes.length > 0) {
        anchorId = allNodes[allNodes.length - 1]!.id
      }
      const doc1 = insertNodeAfter(document, anchorId, { kind: 'step', step: probeStep })
      const doc2 = insertNodeAfter(doc1, probeStep.id, blockNode)
      draft.applyStructure(doc2, blockNode.blockId)
    } else {
      const v2 = toAuthoringDocumentV2(document)
      const doc1 = insertNodeAfter(v2, null, { kind: 'step', step: probeStep })
      const doc2 = insertNodeAfter(doc1, probeStep.id, blockNode)
      draft.applyStructure(doc2, blockNode.blockId)
    }
    setRightTab('step')
    setMobilePane('properties')
  }

  function addSnippet(templateId: string) {
    if (!document) return
    const template = STEP_SNIPPET_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return
    const usedKeys = documentContextKeysAny(document)
    const newSteps = instantiateSnippet(template, usedKeys)
    if (newSteps.length === 0) return

    if (isAuthoringDocumentV2(document)) {
      const allNodes = walkAuthoringNodes(document)
      let anchorId: string | undefined = undefined
      if (draft.selectedIndex >= 0 && draft.selectedIndex < allNodes.length) {
        anchorId = allNodes[draft.selectedIndex]!.id
      } else if (draft.selectedIndex < 0 && allNodes.length > 0) {
        anchorId = allNodes[allNodes.length - 1]!.id
      }

      let currentDoc = document
      for (const step of newSteps) {
        currentDoc = insertNodeAfter(currentDoc, anchorId, { kind: 'step', step })
        anchorId = step.id
      }
      const lastInsertedId = newSteps[newSteps.length - 1]!.id
      draft.applyStructure(currentDoc, lastInsertedId)
    } else {
      const at =
        draft.selectedIndex >= 0
          ? draft.selectedIndex + 1
          : document.steps.length
      const currentSteps = [...document.steps]
      currentSteps.splice(at, 0, ...newSteps)
      const lastInsertedId = newSteps[newSteps.length - 1]!.id
      draft.applyStructure({ ...document, steps: currentSteps }, lastInsertedId)
    }
    setRightTab('step')
    setMobilePane('properties')
    toast.success(`已插入模版「${template.name}」（${newSteps.length} 个步骤）`)
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
    setRightTab('step')
    setMobilePane('properties')
  }

  function changeType(type: ExecutableStepType, keepName: boolean) {
    if (!document || !draft.selected) return
    const selected = draft.selected
    const used = documentContextKeysAny(document)
    if (selected.outputKey) used.delete(selected.outputKey)
    const next = createBlankStep(type, used)
    const name = keepName && selected.name ? selected.name : next.name
    if (isAuthoringDocumentV2(document) && draft.selectedNode?.kind === 'step') {
      draft.updateNode({
        kind: 'step',
        step: { ...next, id: selected.id, name },
      })
      setTypeChange(null)
      return
    }
    if (!('steps' in document)) return
    draft.applyStructure(
      {
        ...document,
        steps: document.steps.map((step) =>
          step.id === selected.id ? { ...next, id: step.id, name } : step,
        ),
      },
      selected.id,
    )
    setTypeChange(null)
  }

  function duplicateSelectedNode() {
    if (!document) return
    if (draft.selectedNode?.kind === 'module') {
      const mod = draft.selectedNode
      const cloned: ScenarioModuleInvocationNode = {
        ...JSON.parse(JSON.stringify(mod)),
        invocationId: crypto.randomUUID(),
        name: `${mod.name} (副本)`,
      }
      draft.insertNode(cloned, draft.selectedIndex)
      setRightTab('step')
      setMobilePane('properties')
      toast.success('已复制模块调用')
      return
    }
    if (draft.selected) {
      const currentStep = draft.selected
      const newId = crypto.randomUUID()
      let outputKey = currentStep.outputKey ? `${currentStep.outputKey}_copy` : undefined
      if (outputKey && documentContextKeysAny(document).has(outputKey)) {
        outputKey = `${outputKey}_${Math.floor(Math.random() * 1000)}`
      }
      const clonedStep: Step = {
        ...JSON.parse(JSON.stringify(currentStep)),
        id: newId,
        name: `${currentStep.name || '步骤'} (副本)`,
        outputKey,
      }
      const after = draft.selectedIndex
      if (isAuthoringDocumentV2(document)) {
        const clonedOutcomes =
          draft.selectedNode?.kind === 'step' && draft.selectedNode.outcomes
            ? draft.selectedNode.outcomes.map((o) => ({ ...o, id: crypto.randomUUID() }))
            : undefined
        draft.insertNode({ kind: 'step', step: clonedStep, outcomes: clonedOutcomes }, after)
      } else {
        draft.applyStructure(insertStep(document, clonedStep, after), newId)
      }
      setRightTab('step')
      setMobilePane('properties')
      toast.success('已复制步骤')
    }
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
    setTrackedRunId(run.id)
    void navigate({
      to: '/scenarios/$scenarioId',
      params: { scenarioId },
      search: { runId: run.id, editor: flowgram ? 'flowgram' : undefined },
      replace: true,
    })
  }

  async function handleRunToStep(targetStepId: string) {
    if (trialRun && trialRun.status === 'HOLDING') {
      if (holdingDraftStepId === targetStepId) {
        toast.message('当前步骤处于挂起/异常状态，请点击右侧「仅重试此步」或修复后重试')
        return
      }
      if (draft.dirty) {
        const savedRev = await ensureDraftSaved()
        if (savedRev === null) return
      }
      try {
        await debugRun(trialRun.id, {
          action: 'continue_to_step',
          targetStepId,
          fencingToken: trialRun.checkpoint?.fencingToken,
        })
        toast.success('已下发指令：步进到目标步骤前置')
        void queryClient.invalidateQueries({ queryKey: ['run-observation', trialRun.id] })
      } catch (error) {
        toast.error(error instanceof ApiRequestError ? error.message : '步进失败')
      }
      return
    }

    if (draft.dirty) {
      const savedRev = await ensureDraftSaved()
      if (savedRev === null) return
    }

    setTrialPauseBeforeStepId(targetStepId)
    setTrialOpen(true)
  }

  async function handleRetryCurrentStep(pageChangedAck = false) {
    if (!trialRun || trialRun.status !== 'HOLDING') return
    const savedRev = await ensureDraftSaved()
    if (savedRev === null) return

    setRetryingStep(true)
    try {
      await debugRun(trialRun.id, {
        action: 'retry_current',
        fencingToken: trialRun.checkpoint?.fencingToken,
        stepOverride: draft.selected ?? undefined,
        confirmSideEffect: trialRun.snapshot.steps.find((step) => step.id === trialRun.checkpoint?.stepId)?.effectType === 'SIDE_EFFECT' ? true : undefined,
        ...(pageChangedAck ? { pageChangedAck: true } : {}),
      })
      toast.success('已下发单步重试，执行成功后将保持挂起')
      void queryClient.invalidateQueries({ queryKey: ['run-observation', trialRun.id] })
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'PAGE_CHANGED_ACK_REQUIRED') {
        setRetryConfirm('page_changed')
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '单步重试失败')
      }
    } finally {
      setRetryingStep(false)
    }
  }

  function renderInspectorHost() {
    return (
      <StudioInspectorHost
        rightTab={rightTab}
        onTabChange={(tab) => {
          setRightTab(tab)
          if (tab === 'step' && !draft.selected && draft.nodes.length > 0) {
            draft.setSelectedId(nodeId(draft.nodes[0]))
          } else if (tab !== 'step') {
            draft.setSelectedId(null)
          }
        }}
        stepTitle={
          rightTab === 'step'
            ? (draft.selectedNode?.kind === 'module'
                ? (draft.selectedNode.name || '动作模块')
                : draft.selectedNode?.kind === 'block'
                  ? (draft.selectedNode.name || '条件分支')
                  : draft.selected
                    ? draft.selected.name
                    : '请选择步骤')
            : rightTab === 'inputs'
              ? '输入与诊断'
              : rightTab === 'outputs'
                ? '业务输出与巡检指标'
                : '预期与诊断'
        }
        stepSubTitle={
          rightTab === 'step' && draft.selectedNode
            ? `${draft.selectedNode.kind === 'module' ? '模块' : draft.selectedNode.kind === 'block' ? '分支' : '步骤'} ${draft.selectedIndex + 1} / ${draft.nodes.length}`
            : rightTab === 'inputs'
              ? '场景级 · 输入参数'
              : rightTab === 'outputs'
                ? '场景级 · 业务输出与指标'
                : '场景级 · 预期与诊断'
        }
        inputsCount={draft.displayInputs.length}
        outputsCount={draft.displayOutputs?.metrics?.length ?? 0}
        diagnosticsCount={compile?.diagnostics?.length ?? 0}
        topHealing={
          <>
            {stepRepairCandidates.length > 0 && (
              <div className="mb-4">
                <HealingPatchCard
                  candidates={stepRepairCandidates}
                  candidate={
                    stepRepairCandidates.find(
                      (c) => c.id === selectedRepairCandidateId || c.candidateId === selectedRepairCandidateId,
                    ) ?? stepRepairCandidates[0]
                  }
                  selectedCandidateId={selectedRepairCandidateId}
                  onSelectCandidate={setSelectedRepairCandidateId}
                  currentRevision={draft.baseline?.revision ?? scenario?.draft?.revision ?? 1}
                  currentStep={draft.selected ?? undefined}
                  onAdopt={handleAdoptRepairCandidate}
                  onReject={handleRejectRepairCandidate}
                  onReopen={handleReopenRepairCandidate}
                  onValidate={handleValidateRepairCandidate}
                />
              </div>
            )}
            {trialRun && trialRun.scenarioId === scenarioId ? (
              <HealingCard
                run={trialRun}
                currentStep={draft.selected ?? undefined}
                retryTarget={retryTargetForCheckpoint({
                  checkpointStepId: trialRun.checkpoint?.stepId,
                  manifest: trialRun.snapshot.outcomeManifest,
                  document: draft.v2Document,
                  selectedStep: draft.selected,
                })}
                onBeforeRetry={ensureDraftSaved}
                onChanged={() => void queryClient.invalidateQueries({ queryKey: ['run-observation', trialRun.id] })}
                onSaveToDraft={(target) => {
                  const writeback = resolveOutcomeWriteback(
                    trialRun.snapshot.outcomeManifest,
                    trialRun.checkpoint?.stepId,
                  )
                  if (writeback) {
                    draft.updateOutcomeTarget({
                      stepId: writeback.sourceStepId,
                      contractId: writeback.contractId,
                      target: withPickedSemantic(target),
                      scenario: writeback.scope === 'scenario',
                    })
                    return
                  }
                  const step = authoringSteps(draft.v2Document).find(
                    (item) => item.id === holdingDraftStepId,
                  )
                  if (!step) {
                    toast.message('找不到要写回的失败步骤，未改其他步骤')
                    return
                  }
                  const next = applyTargetToDraftStep(step, target)
                  if (!next) {
                    toast.message('挂起的步骤没有可写回的页面对象')
                    return
                  }
                  draft.updateStep(next)
                }}
              />
            ) : null}
          </>
        }
        topHoldingRetry={
          trialRun?.status === 'HOLDING' && holdingDraftStepId === draft.selected?.id ? (
            <div className='flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 p-3 shadow-xs'>
              <div className='min-w-0 pr-2'>
                <div className='flex items-center gap-1.5'>
                  <span className='size-2 rounded-full bg-status-warning' />
                  <span className='text-body font-medium text-foreground'>当前步骤正在挂起</span>
                </div>
                <p className='mt-0.5 text-label text-muted-foreground'>
                  修改参数或目标后，可直接单步重试并观察受管画面。
                </p>
              </div>
              <Button
                size='sm'
                className='shrink-0'
                disabled={saving || retryingStep}
                onClick={() => {
                  const step = trialRun.snapshot.steps.find((item) => item.id === trialRun.checkpoint?.stepId)
                  if (step?.effectType === 'SIDE_EFFECT') setRetryConfirm('side_effect')
                  else void handleRetryCurrentStep()
                }}
              >
                <Zap className='size-3.5 mr-1' />
                仅重试此步
              </Button>
            </div>
          ) : null
        }
      >
        <div className='flex items-center justify-between lg:hidden pb-2'>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => setMobilePane('steps')}
          >
            ← 返回步骤列表
          </Button>
        </div>

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
                scenarioId={scenario!.id}
                scenarioInputs={draft.displayInputs}
                priorBindings={draft.v2Document ? priorBindingsV2(draft.v2Document, draft.selectedIndex) : []}
                baselineRevision={scenario!.draft?.revision ?? 1}
                document={draft.candidate!}
                diagnostics={(compile?.diagnostics ?? []).filter((item) => item.stepId === (draft.selectedNode as any)?.invocationId)}
                disabled={disabled || !supportsAuthoringV2}
                onChange={(updated) => draft.updateNode(updated)}
                onInlined={() => {
                  void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
                }}
              />
              <div className='flex flex-wrap gap-2 pt-2 border-t border-border-divider'>
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
                  disabled={disabled}
                  onClick={duplicateSelectedNode}
                >
                  <Copy className='size-3.5 mr-1' />
                  复制模块
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
          ) : draft.selectedNode?.kind === 'block' ? (
            <>
              <BlockNodeEditor
                node={draft.selectedNode}
                priorBindings={draft.v2Document ? priorBindingsV2(draft.v2Document, draft.selectedIndex) : []}
                diagnostics={(compile?.diagnostics ?? []).filter((item) => item.stepId === (draft.selectedNode as any)?.blockId)}
                disabled={disabled}
                onChange={(updated) => draft.updateNode(updated)}
                onAddStepToBranch={(branch, type) => {
                  if (!draft.v2Document || draft.selectedNode?.kind !== 'block') return
                  const nextStep = createBlankStep(type, documentContextKeysAny(draft.v2Document))
                  const block = draft.selectedNode
                  const childCount =
                    'then' in block
                      ? branch === 'then'
                        ? (block.then?.length ?? 0)
                        : (block.else?.length ?? 0)
                      : (block.body?.length ?? 0)
                  const nextDoc = insertNodeAt(draft.v2Document, {
                    parentId: block.blockId,
                    branchKey: branch,
                    index: childCount,
                  }, { kind: 'step', step: nextStep })
                  draft.applyStructure(nextDoc, nextStep.id)
                }}
                onDelete={() => setDeleteId(nodeId(draft.selectedNode!))}
              />
              <div className='flex flex-wrap gap-2 pt-2 border-t border-border-divider'>
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
              <SegmentedStepInspector
                step={draft.selected}
                index={draft.selectedIndex}
                bindings={bindings}
                shapes={shapes}
                editableTypes={editableTypes}
                diagnostics={(compile?.diagnostics ?? []) as CompileDiagnostic[]}
                disabled={disabled}
                consumers={draft.selected?.outputKey ? outputConsumersAny(document, draft.selected.outputKey) : []}
                origin={draft.selectedNode?.kind === 'step' ? draft.selectedNode.origin : undefined}
                outcomes={
                  draft.selectedNode?.kind === 'step' ? draft.selectedNode.outcomes ?? [] : []
                }
                locatorHealth={draft.selected ? locatorHealth.healthMap.get(draft.selected.id) : undefined}
                activeCandidate={draft.selected ? locatorHealth.healthMap.get(draft.selected.id)?.activeCandidate : undefined}
                onAdoptCandidate={(candidate) => {
                  void locatorHealth.adoptCandidate(
                    candidate,
                    draft.baseline?.revision ?? scenario?.draft?.revision ?? 1,
                  )
                }}
                onRejectCandidate={(candidateId) => {
                  void locatorHealth.rejectCandidate(candidateId)
                }}
                onChange={draft.updateStep}
                onOutcomesChange={(outcomes) => { if (draft.selected) draft.updateOutcomes(draft.selected.id, outcomes) }}
                onRequestTypeChange={(type) => {
                  setKeepTypeChangeName(false)
                  setTypeChange(type)
                }}
              />
              <MapStepBinding
                targetId={scenario!.targetId}
                scenarioId={scenario!.id}
                stepId={draft.selected.id}
                draftRevision={scenario!.draft?.revision ?? 0}
                disabled={disabled}
              />
              {document && scenario?.draft ? (
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
              <div className='flex flex-wrap gap-2 pt-2 border-t border-border-divider'>
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
                    if (isAuthoringDocumentV2(document) || !document) return
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
                    if (isAuthoringDocumentV2(document) || !document) return
                    const next = moveStep(document, draft.selectedIndex, 1)
                    if (next) draft.applyStructure(next, draft.selected?.id ?? null)
                  }}
                >
                  下移
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={disabled}
                  onClick={duplicateSelectedNode}
                >
                  <Copy className='size-3.5 mr-1' />
                  复制步骤
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
                  }}
                >
                  查看场景输入与全局诊断
                </button>
              </div>
            </>
          ) : (
            <div className='py-6 px-4 space-y-4'>
              {draft.nodes.length === 0 ? (
                <div className='rounded-lg border border-border-divider/80 bg-surface-subtle p-5 space-y-4'>
                  <div className='flex items-center gap-2 text-foreground font-medium text-body'>
                    <span className='text-title'>💡</span>
                    <span>欢迎开始场景编排</span>
                  </div>
                  <div className='text-label text-muted-foreground space-y-2.5 leading-relaxed'>
                    <p>当前场景还是空的，你可以通过以下方式快速开始：</p>
                    <ol className='list-decimal list-inside space-y-1.5 pl-1'>
                      {pendingImportDraftId ? (
                        <li className='text-foreground font-medium'>
                          一键导入录制草稿，自动转换为所有操作步骤；
                        </li>
                      ) : null}
                      <li>点击左侧【+ 添加步骤】，选择【打开页面】作为起点；</li>
                      <li>或添加【AI 智能操作】，用自然语言快速描述目标动作。</li>
                    </ol>
                  </div>
                  {pendingImportDraftId && canRecord ? (
                    <Button
                      size='sm'
                      variant='default'
                      className='w-full text-label shadow-xs'
                      onClick={() => setImportSearch(pendingImportDraftId)}
                    >
                      ⚡ 一键预览并导入录制草稿
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className='text-center py-12 space-y-3'>
                  <p className='text-label text-muted-foreground'>未选中任何步骤</p>
                  <div className='flex flex-wrap items-center justify-center gap-2'>
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
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings className='size-3.5 mr-1.5' />
                      场景配置
                    </Button>
                  </div>
                </div>
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
            <div className='pt-3 border-t border-border-divider/60 flex items-center justify-between text-label text-muted-foreground'>
              <span>配置场景预期或全局约束？</span>
              <button
                type='button'
                className='text-link hover:underline font-medium'
                onClick={() => setRightTab('outcomes')}
              >
                前往预期与诊断 →
              </button>
            </div>
          </>
        ) : rightTab === 'outputs' ? (
          <>
            <ScenarioOutputsEditor
              outputs={draft.displayOutputs}
              disabled={disabled}
              availableContextKeys={document ? Array.from(documentContextKeysAny(document)) : []}
              onChange={draft.updateOutputs}
            />
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
            {locatorHealth.candidateCount > 0 && (
              <div
                data-testid='batch-healing-banner'
                className='flex items-center justify-between gap-3 p-3 rounded-lg border border-primary/20 bg-primary/5'
              >
                <div className='flex items-center gap-2 min-w-0'>
                  <Sparkles className='size-4 text-primary shrink-0' />
                  <span className='text-body font-medium truncate'>
                    检测到 <strong>{locatorHealth.candidateCount}</strong> 个步骤有可用的定位自愈建议
                  </span>
                </div>
                <Button
                  size='sm'
                  variant='default'
                  disabled={disabled}
                  className='shrink-0'
                  onClick={() =>
                    void locatorHealth.batchAdoptAll(
                      draft.baseline?.revision ?? scenario?.draft?.revision ?? 1,
                    )
                  }
                >
                  <Sparkles className='size-3.5 mr-1' />
                  一键批量自愈
                </Button>
              </div>
            )}
            <ScenarioResolutionStats
              scenarioId={scenarioId}
              steps={scenarioSteps}
              onSelectStep={(stepId) => {
                draft.setSelectedId(stepId)
                setRightTab('step')
              }}
            />
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
              revision={scenario?.draft?.revision ?? 1}
              runUpdate={
                trialRun
                  ? `${trialRun.id}:${trialRun.status}:${trialRun.outcomeStatus}:${trialRun.evidenceStatus}`
                  : undefined
              }
              dirty={draft.dirty}
            />
            <div className='pt-3 border-t border-border-divider/60 flex items-center justify-between text-label text-muted-foreground'>
              <span>配置场景运行与定位策略、报告？</span>
              <button
                type='button'
                className='text-link hover:underline font-medium'
                onClick={() => setSettingsOpen(true)}
              >
                打开场景配置 →
              </button>
            </div>
          </>
        )}

        {runId ? (
          <div className='border-t border-border-divider pt-4'>
            <TrialPanel
              runId={runId}
              scenarioId={scenarioId}
              selectedDraftStepId={draft.selectedId}
              onSelectDraftStep={draft.setSelectedId}
            />
          </div>
        ) : null}
      </StudioInspectorHost>
    )
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
          onPublish={() => void handleStartPublish()}
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
          onRename={async (newName) => {
            if (!scenario || renaming) return false
            setRenaming(true)
            try {
              await updateScenario(scenario.id, { name: newName.trim() })
              toast.success('已重命名')
              void queryClient.invalidateQueries({ queryKey: ['scenarios', scenarioId] })
              return true
            } catch (error) {
              toast.error(error instanceof ApiRequestError ? error.message : '重命名失败')
              return false
            } finally {
              setRenaming(false)
            }
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
          onOpenSettings={() => setSettingsOpen(true)}
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
                {pendingImportDraftId && !recordingBannerDismissed ? (
                  <Alert className='border-primary/40 bg-primary/5 shadow-xs'>
                    <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                      <div className='flex items-center gap-2'>
                        <span className='text-body'>⚡</span>
                        <span className='font-medium text-foreground text-small'>
                          {openBinding?.recordingDraftId
                            ? `场景「${openBinding.scenarioName}」有已上传的录制，待预览回填。`
                            : '检测到可导入当前场景的录制草稿，可一键转换为操作步骤。'}
                        </span>
                      </div>
                      <span className='flex flex-wrap items-center gap-2'>
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
                            variant='default'
                            className='shadow-xs'
                            onClick={() => setImportSearch(pendingImportDraftId)}
                          >
                            预览导入草稿
                          </Button>
                        ) : null}
                        {canWrite && openBinding ? (
                          <Button size='sm' variant='ghost' onClick={() => void cancelRecording()}>
                            关闭绑定
                          </Button>
                        ) : null}
                        <Button
                          size='icon'
                          variant='ghost'
                          className='size-7 shrink-0 text-muted-foreground hover:text-foreground'
                          onClick={() => dismissRecordingBanner()}
                          aria-label='关闭提示'
                          title='关闭提示'
                        >
                          <X className='size-4' />
                        </Button>
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
                const step = authoringSteps(draft.v2Document).find((s) => s.id === stepId)
                if (step && !step.outputKey) {
                  draft.updateStep({ ...step, outputKey })
                }
              }}
              onApplyTarget={(target, extras) => {
                const picked = withPickedSemantic(target)
                const previewText = extras?.previewText?.trim()
                if (extras?.outcomePick) {
                  draft.updateOutcomeTarget({
                    stepId: extras.outcomePick.stepId,
                    contractId: extras.outcomePick.contractId,
                    target: picked,
                    scenario: extras.outcomePick.scope === 'scenario',
                  })
                  return
                }
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
            <ResolutionSourceProvider targetId={scenario.targetId} scenarioPlan={draft.v2Document?.locatorPlan} scenarioPolicy={draft.v2Document?.resolution} locatorProtocol={draft.v2Document?.locatorProtocol}>
            <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
              {flowgram ? (
                <div className='flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row overflow-hidden'>
                  <section
                    aria-label='执行步骤'
                    className={cn(
                      'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card',
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
                        <DropdownMenuLabel>基础操作</DropdownMenuLabel>
                        {editableTypes
                          .filter((type) =>
                            ['navigate', 'click', 'fill', 'select'].includes(type),
                          )
                          .map((type) => (
                            <DropdownMenuItem key={type} className='flex items-center gap-2' onClick={() => addStep(type)}>
                              <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                              <span>{stepTypeLabel(type)}</span>
                            </DropdownMenuItem>
                          ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>辅助与提取</DropdownMenuLabel>
                        {editableTypes
                          .filter((type) =>
                            ['keyboard', 'wait', 'extract'].includes(type),
                          )
                          .map((type) => (
                            <DropdownMenuItem key={type} className='flex items-center gap-2' onClick={() => addStep(type)}>
                              <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                              <span>{stepTypeLabel(type)}</span>
                            </DropdownMenuItem>
                          ))}
                        {editableTypes.some((type) => type === 'download' || type === 'upload') && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>文件操作</DropdownMenuLabel>
                            {editableTypes
                              .filter((type) => type === 'download' || type === 'upload')
                              .map((type) => (
                                <DropdownMenuItem key={type} className='flex items-center gap-2' onClick={() => addStep(type)}>
                                  <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                                  <span>{stepTypeLabel(type)}</span>
                                </DropdownMenuItem>
                              ))}
                          </>
                        )}
                        {editableTypes.some((type) => type.startsWith('ai_')) ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel className='text-ai-foreground'>AI 智能</DropdownMenuLabel>
                            {editableTypes
                              .filter((type) => type.startsWith('ai_'))
                              .map((type) => (
                                <DropdownMenuItem key={type} className='flex items-center gap-2 text-ai-foreground' onClick={() => addStep(type)}>
                                  <StepTypeIcon type={type} className='size-3.5 text-ai-foreground' />
                                  <span>{stepTypeLabel(type)}</span>
                                </DropdownMenuItem>
                              ))}
                          </>
                        ) : null}
                        {unavailableStudioTypes(capabilitiesQuery.data)
                          .filter((item) => item.type !== 'assert' && item.type !== 'ai_assert')
                          .map((item) => (
                            <DropdownMenuItem key={item.type} disabled className='flex items-center gap-2'>
                              <StepTypeIcon type={item.type} className='size-3.5 text-muted-foreground opacity-50' />
                              <span>{stepTypeLabel(item.type)}（{item.message}）</span>
                            </DropdownMenuItem>
                          ))}
                        {fixtureTypes.length > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>调试夹具</DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {fixtureTypes.map((type) => (
                                  <DropdownMenuItem key={type} className='flex items-center gap-2' onClick={() => addStep(type)}>
                                    <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                                    <span>{stepTypeLabel(type)}</span>
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
                          search: (prev: any) => ({ ...prev, editor: undefined }),
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
                          search: (prev: any) => ({ ...prev, editor: 'flowgram' }),
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
                            {String(index + 1).padStart(2, '0')} · {node.kind === 'module' ? (node.name || '动作模块') : node.kind === 'block' ? (node.name || '条件分支') : node.step.name}
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
                              onStartTrial={() => {
                                setTrialPauseBeforeStepId(undefined)
                                setTrialOpen(true)
                              }}
                              selectedStepId={draft.selected?.id ?? (draft.selectedNode ? nodeId(draft.selectedNode) : undefined)}
                              selectedStepName={draft.selected?.name}
                              selectedIsFirst={
                                draft.selected || draft.selectedNode ? draft.selectedIndex === 0 : undefined
                              }
                              stepOrder={draft.nodes.map(nodeId)}
                              onRunToStep={handleRunToStep}
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
                ) : null}
                  </section>
                  <div
                    ref={rightPanelRef}
                    className={cn(
                      'w-full lg:w-[360px] xl:w-[400px] 2xl:w-[440px] shrink-0 border-l border-border-divider bg-card flex flex-col min-h-0 overflow-hidden',
                      mobilePane !== 'properties' && 'max-lg:hidden',
                    )}
                  >
                    {renderInspectorHost()}
                  </div>
                </div>
              ) : (
                <StudioSplitterLayout
                  preset={viewPreset}
                  onPresetChange={setViewPreset}
                  mobilePane={mobilePane}
                  left={
                    <StepPipelineRail
                      document={document}
                      selectedId={draft.selectedId}
                      selectedIndex={draft.selectedIndex}
                      holdingDraftStepId={holdingDraftStepId}
                      importedStepIds={importedStepIds}
                      compileDiagnostics={compile?.diagnostics ?? []}
                      canWrite={canWrite}
                      disabled={disabled}
                      nodeLimit={nodeLimit}
                      editableTypes={editableTypes}
                      fixtureTypes={fixtureTypes}
                      actionModulesEnabled={actionModulesEnabled}
                      supportsAuthoringV2={supportsAuthoringV2}
                      extractIds={extractIds}
                      pendingImportDraftId={pendingImportDraftId}
                      canRecord={canRecord}
                      capabilitiesData={capabilitiesQuery.data}
                      flowgram={flowgram}
                      locatorHealthMap={locatorHealth.healthMap}
                      onToggleFlowgram={(f) => {
                        void navigate({
                          to: '/scenarios/$scenarioId',
                          params: { scenarioId },
                          search: (prev: any) => ({ ...prev, editor: f ? 'flowgram' : undefined }),
                          replace: true,
                        })
                      }}
                      onLocateStep={locateStep}
                      onSelect={(id) => {
                        draft.setSelectedId(id)
                        setRightTab('step')
                        setMobilePane('properties')
                      }}
                      onAddStep={addStep}
                      onAddBlock={addBlock}
                      onWrapSelection={wrapSelection}
                      onUnwrapBlock={unwrapSelectedBlock}
                      onAddProbeAndBlock={addProbeAndBlock}
                      onAddSnippet={addSnippet}
                      canExtract={canExtract}
                      onExtractIdsChange={setExtractIds}
                      onImportSearch={(id) => setImportSearch(id)}
                      onInsertModuleOpen={() => setInsertModuleOpen(true)}
                      onExtractOpen={() => setExtractOpen(true)}
                      onReplaceOpen={() => setReplaceOpen(true)}
                    />
                  }
                  center={
                    <ManagedStageScreen
                      preset={viewPreset}
                      onPresetChange={setViewPreset}
                      runId={runId}
                      scenarioId={scenarioId}
                      targetId={scenario.targetId}
                      targetAccountId={studioAccountId}
                      onStartTrial={() => {
                        setTrialPauseBeforeStepId(undefined)
                        setTrialOpen(true)
                      }}
                      selectedStepId={draft.selected?.id ?? (draft.selectedNode ? nodeId(draft.selectedNode) : undefined)}
                      selectedStepName={draft.selected?.name}
                      selectedIsFirst={
                        draft.selected || draft.selectedNode ? draft.selectedIndex === 0 : undefined
                      }
                      stepOrder={draft.nodes.map(nodeId)}
                      onRunToStep={handleRunToStep}
                      trialDisabledReason={canTrial ? undefined : trialDisabledReason}
                    />
                  }
                  right={renderInspectorHost()}
                />
              )}
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
      <AlertDialog open={retryConfirm === 'side_effect'} onOpenChange={(open) => !open && setRetryConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>再试有副作用的步骤？</AlertDialogTitle>
            <AlertDialogDescription>这一步可能对目标系统重复提交或改写数据。确认后才会发起新的尝试，历史证据会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRetryConfirm(null); void handleRetryCurrentStep() }}>确认再试</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={retryConfirm === 'page_changed'} onOpenChange={(open) => !open && setRetryConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>页面已变化，仍要再试？</AlertDialogTitle>
            <AlertDialogDescription>当前页面与挂起时不同。确认后会发起新的尝试，并保留先前的运行证据。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRetryConfirm(null); void handleRetryCurrentStep(true) }}>确认再试</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(typeChange)}
        onOpenChange={(open) => {
          if (open) return
          setTypeChange(null)
          setKeepTypeChangeName(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              将「{draft.selected ? stepTypeLabel(draft.selected.type) : '当前类型'}」更换为「{typeChange ? stepTypeLabel(typeChange) : '新类型'}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              “添加步骤”只设置初始类型。确认后按新类型执行，专有输入和输出会重置；AI 意图不会自动转换。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {draft.selected && typeChange && (
            <div className='space-y-2 rounded-md border border-border-default bg-surface-subtle p-3 text-small'>
              <p className='text-foreground'>
                更换后步骤名称：「{keepTypeChangeName ? draft.selected.name : stepTypeLabel(typeChange)}」
              </p>
              {draft.selected.name && draft.selected.name !== stepTypeLabel(draft.selected.type) && (
                <label className='flex cursor-pointer items-start gap-2 text-muted-foreground'>
                  <Checkbox
                    checked={keepTypeChangeName}
                    onCheckedChange={(checked) => setKeepTypeChangeName(checked === true)}
                    aria-label='保留原步骤名称'
                  />
                  <span>保留原名称「{draft.selected.name}」（请确认它仍准确描述新动作）</span>
                </label>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => typeChange && changeType(typeChange, keepTypeChangeName)}>
              更换类型
            </AlertDialogAction>
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
          independentSteps={document ? authoringSteps(document).map((step) => ({ id: step.id, name: step.name })) : []}
          initialPlaceholderStepId={document && (draft.baseline?.revision ?? scenario.draft?.revision) === 1 && authoringSteps(document).length === 1 && isDemonstrationHandoffPlaceholder(authoringSteps(document)[0]!) ? authoringSteps(document)[0]!.id : undefined}
          initialPlacement={initialImportPlacement}
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
          onOpenChange={(open) => {
            setTrialOpen(open)
            if (!open) setTrialPauseBeforeStepId(undefined)
          }}
          scenarioId={scenario.id}
          targetId={scenario.targetId}
          revision={draft.baseline?.revision ?? 1}
          inputs={document?.inputs ?? []}
          needsAccount={document ? documentUsesBrowser(document) : false}
          pauseBeforeStepId={trialPauseBeforeStepId}
          onCreated={(run) => {
            setTrialPauseBeforeStepId(undefined)
            attachRun(run)
          }}
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
      <PublishDiffDrawer
        open={publishDiffOpen}
        scenarioName={scenario?.name ?? ''}
        currentVersionNo={scenario?.published?.versionNo}
        baselineDoc={scenario?.published?.authoringDocument ?? scenario?.published?.definition}
        draftDoc={(draft.v2Document ?? document) ?? { schemaVersion: 1, inputs: [], steps: [] }}
        publishing={publishing}
        onClose={() => setPublishDiffOpen(false)}
        onConfirmPublish={() => void publish()}
      />
      {draft.v2Document && scenario ? (
        <ScenarioSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          scenarioId={scenario.id}
          targetId={scenario.targetId}
          document={draft.v2Document}
          platform={platformConfigQuery.data?.document}
          target={target?.resolutionPolicy}
          disabled={disabled}
          onChange={(next) => draft.applyStructure(next, draft.selectedId)}
        />
      ) : null}
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
  const setQuote = useAssistantStore((s) => s.setQuote)
  if (diagnostics.length === 0) {
    return <p className='text-small text-muted-foreground'>当前没有编译诊断。</p>
  }
  return (
    <ul className='space-y-2' aria-label='编译诊断'>
      {diagnostics.map((item) => (
        <li
          key={`${item.code}-${item.stepId ?? item.inputKey ?? 'global'}-${item.message}`}
          className='flex items-stretch gap-1.5'
        >
          <button
            type='button'
            className={
              item.severity === 'error'
                ? 'flex-1 rounded-md bg-status-error-background p-3 text-left text-small text-status-error-foreground'
                : 'flex-1 rounded-md bg-status-warning-background p-3 text-left text-small text-status-warning-foreground'
            }
            onClick={() => onSelect(item)}
          >
            {item.message}
          </button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='self-center h-8 px-2 text-label text-muted-foreground hover:text-foreground shrink-0'
            title='引用此诊断至识途助手'
            onClick={(e) => {
              e.stopPropagation()
              setQuote(
                buildDiagnosticQuote(
                  item.stepId ?? 'diagnostic',
                  `诊断 [${item.code}]`,
                  item.message,
                  { code: item.code, severity: item.severity, stepId: item.stepId }
                )
              )
            }}
          >
            求助
          </Button>
        </li>
      ))}
    </ul>
  )
}
