import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  EMPTY_SUITE_DOCUMENT,
  canExecuteRun,
  hasPermission,
  allSuiteMembers,
  type SuiteDocument,
  type SuiteMember,
  type SuiteStage,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createSuiteRun,
  previewSuiteRun,
  publishSuite,
  saveSuiteDraft,
  updateSuiteEnabled,
  validateSuite,
  fetchSuite,
} from '@/lib/suites-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTarget, fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Main } from '@/components/layout/main'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { suiteIssueMessage } from './labels'
import { MemberInputDialog } from './member-input-dialog'
import { SuiteHeader } from './components/suite-header'
import { PipelineWorkspace } from './components/pipeline-workspace'
import { SuiteInspector } from './components/suite-inspector'

function nextMemberId(members: SuiteMember[]) {
  let index = members.length + 1
  const used = new Set(members.map((item) => item.memberId))
  while (used.has(`m${index}`)) index += 1
  return `m${index}`
}

function newIdempotencyKey() {
  return `suite-${crypto.randomUUID()}`
}

const EMPTY_PERMISSIONS: string[] = []

export function SuiteDetailPage() {
  const { suiteId } = useParams({ from: '/_authenticated/suites/$suiteId/' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canWrite = useCan('suite:write')
  const permissions = useAuthStore((state) => state.auth.user?.permissions ?? EMPTY_PERMISSIONS)
  const canExecute = canExecuteRun(permissions) && hasPermission(permissions, 'suite:read')
  const query = useQuery({ queryKey: ['suite', suiteId], queryFn: () => fetchSuite(suiteId) })
  const target = useQuery({
    queryKey: ['target', query.data?.targetId],
    queryFn: () => fetchTarget(query.data!.targetId),
    enabled: Boolean(query.data?.targetId),
  })
  const scenarios = useQuery({
    queryKey: ['scenarios', { targetId: query.data?.targetId, limit: 100 }],
    queryFn: () => fetchScenarios({ targetId: query.data!.targetId, status: 'active', limit: 100 }),
    enabled: Boolean(query.data?.targetId),
  })
  const targetAccounts = useQuery({
    queryKey: ['target-accounts', query.data?.targetId],
    queryFn: () => fetchTargetAccounts(query.data!.targetId, { limit: 100 }),
    enabled: Boolean(query.data?.targetId),
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [document, setDocument] = useState<SuiteDocument>(EMPTY_SUITE_DOCUMENT)
  const [editingMember, setEditingMember] = useState<SuiteMember | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!query.data) return
    setName(query.data.name)
    setDescription(query.data.description ?? '')
    setDocument(query.data.draft.document)
  }, [query.data])

  const scenarioNames = useMemo(
    () => new Map((scenarios.data?.items ?? []).map((item) => [item.id, item.name])),
    [scenarios.data],
  )

  const isDirty = useMemo(() => {
    if (!query.data) return false
    if (name !== query.data.name) return true
    if ((description || null) !== (query.data.description || null)) return true
    return JSON.stringify(document) !== JSON.stringify(query.data.draft.document)
  }, [name, description, document, query.data])

  async function save() {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      await queryClient.setQueryData(['suite', suiteId], saved)
      toast.success('草稿已保存')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function publish() {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      const checked = await validateSuite(suiteId)
      if (!checked.ok) {
        const blockingIssue = checked.issues.find((item) => item.severity === 'error')
        toast.error(blockingIssue ? suiteIssueMessage(blockingIssue) : '校验未通过')
        await queryClient.setQueryData(['suite', suiteId], saved)
        return
      }
      const published = await publishSuite(suiteId, {
        expectedRevision: saved.draft.revision,
        idempotencyKey: newIdempotencyKey(),
      })
      await queryClient.setQueryData(['suite', suiteId], published)
      toast.success(`已发布 v${published.published?.versionNo ?? ''}`)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
    } finally {
      setBusy(false)
    }
  }

  async function startRun() {
    if (!query.data?.published) {
      toast.error('发布后才能启动')
      return
    }
    setBusy(true)
    try {
      const preview = await previewSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      const blocking = preview.issues.filter((item) => item.severity === 'error')
      if (blocking.length) {
        toast.error(suiteIssueMessage(blocking[0]!))
        return
      }
      const created = await createSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      toast.success('已启动场景集运行')
      void navigate({ to: '/suite-runs/$suiteRunId', params: { suiteRunId: created.observation.id } })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '启动失败')
    } finally {
      setBusy(false)
    }
  }

  const isStageMode = Boolean(document.stages && document.stages.length > 0)

  // Flat mode member handlers
  function addMemberFlat(scenarioId: string) {
    const scenario = scenarios.data?.items.find((item) => item.id === scenarioId)
    if (!scenario) return
    const allMembers = allSuiteMembers(document)
    const member: SuiteMember = {
      memberId: nextMemberId(allMembers),
      ordinal: document.members.length,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      displayName: scenario.name,
      input: {},
    }
    setDocument({ ...document, members: [...document.members, member] })
  }

  function moveMemberFlat(index: number, delta: number) {
    const next = [...document.members]
    const targetIdx = index + delta
    if (targetIdx < 0 || targetIdx >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(targetIdx, 0, item!)
    setDocument({ ...document, members: next.map((member, ordinal) => ({ ...member, ordinal })) })
  }

  function removeMemberFlat(index: number) {
    setDocument({
      ...document,
      members: document.members
        .filter((_, idx) => idx !== index)
        .map((item, ordinal) => ({ ...item, ordinal })),
    })
  }

  function updateMemberFlat(index: number, updater: (m: SuiteMember) => SuiteMember) {
    setDocument({
      ...document,
      members: document.members.map((item, idx) => (idx === index ? updater(item) : item)),
    })
  }

  // Stage mode handlers
  function addMemberToStage(stageIndex: number, scenarioId: string) {
    const scenario = scenarios.data?.items.find((item) => item.id === scenarioId)
    if (!scenario || !document.stages) return
    const allMembers = allSuiteMembers(document)
    const stage = document.stages[stageIndex]
    if (!stage) return
    const member: SuiteMember = {
      memberId: nextMemberId(allMembers),
      ordinal: stage.members.length,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      displayName: scenario.name,
      input: {},
    }
    const nextStages = document.stages.map((s, idx) =>
      idx === stageIndex ? { ...s, members: [...s.members, member] } : s,
    )
    setDocument({ ...document, stages: nextStages })
  }

  function moveMemberInStage(stageIndex: number, memberIndex: number, delta: number) {
    if (!document.stages) return
    const stage = document.stages[stageIndex]
    if (!stage) return
    const nextMembers = [...stage.members]
    const targetIdx = memberIndex + delta
    if (targetIdx < 0 || targetIdx >= nextMembers.length) return
    const [item] = nextMembers.splice(memberIndex, 1)
    nextMembers.splice(targetIdx, 0, item!)
    const nextStages = document.stages.map((s, idx) =>
      idx === stageIndex
        ? { ...s, members: nextMembers.map((m, ordinal) => ({ ...m, ordinal })) }
        : s,
    )
    setDocument({ ...document, stages: nextStages })
  }

  function removeMemberFromStage(stageIndex: number, memberIndex: number) {
    if (!document.stages) return
    const stage = document.stages[stageIndex]
    if (!stage) return
    const nextMembers = stage.members
      .filter((_, idx) => idx !== memberIndex)
      .map((m, ordinal) => ({ ...m, ordinal }))
    const nextStages = document.stages.map((s, idx) =>
      idx === stageIndex ? { ...s, members: nextMembers } : s,
    )
    setDocument({ ...document, stages: nextStages })
  }

  function updateMemberInStage(
    stageIndex: number,
    memberIndex: number,
    updater: (m: SuiteMember) => SuiteMember,
  ) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, sIdx) => {
      if (sIdx !== stageIndex) return s
      const nextMembers = s.members.map((m, mIdx) => (mIdx === memberIndex ? updater(m) : m))
      return { ...s, members: nextMembers }
    })
    setDocument({ ...document, stages: nextStages })
  }

  function addStage() {
    const currentStages = document.stages ?? []
    const newOrdinal = currentStages.length
    const stageId = `stage-${newOrdinal + 1}`
    const newStage: SuiteStage = {
      id: stageId,
      name: `阶段 ${newOrdinal + 1}`,
      ordinal: newOrdinal,
      executionMode: 'parallel',
      maxConcurrency: 3,
      failurePolicy: 'continue',
      members: [],
    }
    setDocument({ ...document, stages: [...currentStages, newStage] })
  }

  function removeStage(stageIndex: number) {
    if (!document.stages) return
    const nextStages = document.stages
      .filter((_, idx) => idx !== stageIndex)
      .map((s, ordinal) => ({ ...s, ordinal }))
    setDocument({ ...document, stages: nextStages })
  }

  function moveStage(index: number, delta: number) {
    if (!document.stages) return
    const next = [...document.stages]
    const targetIdx = index + delta
    if (targetIdx < 0 || targetIdx >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(targetIdx, 0, item!)
    setDocument({ ...document, stages: next.map((stage, ordinal) => ({ ...stage, ordinal })) })
  }

  function updateStageName(stageIndex: number, newName: string) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, name: newName } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageMode(stageIndex: number, mode: 'parallel' | 'sequential') {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, executionMode: mode } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageConcurrency(stageIndex: number, val: number) {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, maxConcurrency: val } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function updateStageFailurePolicy(stageIndex: number, policy: 'continue' | 'stop') {
    if (!document.stages) return
    const nextStages = document.stages.map((s, idx) => (idx === stageIndex ? { ...s, failurePolicy: policy } : s))
    setDocument({ ...document, stages: nextStages })
  }

  function toggleStageMode() {
    if (isStageMode) {
      const flat = allSuiteMembers(document).map((m, ordinal) => ({ ...m, ordinal }))
      setDocument({ ...document, stages: [], members: flat })
      toast.info('已转换为平铺模式')
    } else {
      const initialStage: SuiteStage = {
        id: 'stage-1',
        name: '阶段 1 (准备与核心)',
        ordinal: 0,
        executionMode: document.executionMode ?? 'parallel',
        maxConcurrency: document.maxConcurrency ?? 3,
        failurePolicy: document.failurePolicy ?? 'continue',
        members: [...document.members],
      }
      setDocument({ ...document, stages: [initialStage], members: [] })
      toast.success('已开启多阶段依赖编排模式')
    }
  }

  if (query.isPending) {
    return (
      <Main>
        <PageSkeleton />
      </Main>
    )
  }
  if (query.isError || !query.data) {
    return (
      <Main>
        <QueryErrorState title='无法加载场景集' onRetry={() => void query.refetch()} />
      </Main>
    )
  }

  const suite = query.data

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      {/* Top Header */}
      <SuiteHeader
        suite={suite}
        targetName={target.data?.name}
        canExecute={Boolean(canExecute)}
        busy={busy}
        isDirty={isDirty}
        onSave={() => void save()}
        onPublish={() => void publish()}
        onStartRun={() => void startRun()}
        onToggleStatus={() => {
          void updateSuiteEnabled(suiteId, { status: suite.status === 'active' ? 'disabled' : 'active' })
            .then((next) => {
              queryClient.setQueryData(['suite', suiteId], next)
              toast.success(next.status === 'active' ? '已启用' : '已停用')
            })
            .catch((error) => toast.error(error instanceof ApiRequestError ? error.message : '更新失败'))
        }}
      />

      {/* Split Workspace Layout */}
      <div className='grid grid-cols-1 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] gap-6 items-start'>
        {/* Left: Pipeline Workspace (Primary) */}
        <div className='min-w-0'>
          <PipelineWorkspace
            document={document}
            isStageMode={isStageMode}
            canWrite={canWrite}
            scenarioNames={scenarioNames}
            availableScenarios={scenarios.data?.items ?? []}
            targetAccounts={targetAccounts.data?.items ?? []}
            targetId={suite.targetId}
            onToggleStageMode={toggleStageMode}
            onAddStage={addStage}
            onMoveStage={moveStage}
            onRemoveStage={removeStage}
            onUpdateStageName={updateStageName}
            onUpdateStageMode={updateStageMode}
            onUpdateStageConcurrency={updateStageConcurrency}
            onUpdateStageFailurePolicy={updateStageFailurePolicy}
            onAddMemberToStage={addMemberToStage}
            onUpdateMemberInStage={updateMemberInStage}
            onMoveMemberInStage={moveMemberInStage}
            onRemoveMemberFromStage={removeMemberFromStage}
            onAddMemberFlat={addMemberFlat}
            onUpdateMemberFlat={updateMemberFlat}
            onMoveMemberFlat={moveMemberFlat}
            onRemoveMemberFlat={removeMemberFlat}
            onOpenInputEditor={(member) => setEditingMember(member)}
          />
        </div>

        {/* Right: Inspector Properties & Execution Config (Secondary) */}
        <div className='min-w-0 lg:sticky lg:top-6'>
          <SuiteInspector
            name={name}
            description={description}
            document={document}
            canWrite={canWrite}
            targetAccounts={targetAccounts.data?.items ?? []}
            targetId={suite.targetId}
            onUpdateName={setName}
            onUpdateDescription={setDescription}
            onUpdateDocument={(updater) => setDocument(updater(document))}
          />
        </div>
      </div>

      {/* Member Input Override Dialog */}
      <MemberInputDialog
        open={editingMember !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMember(null)
        }}
        member={editingMember}
        scenarioName={editingMember ? scenarioNames.get(editingMember.scenarioId) : undefined}
        disabled={!canWrite}
        onSave={(memberId, input) => {
          if (isStageMode && document.stages) {
            const nextStages = document.stages.map((stage) => ({
              ...stage,
              members: stage.members.map((item) =>
                item.memberId === memberId ? { ...item, input } : item,
              ),
            }))
            setDocument({ ...document, stages: nextStages })
          } else {
            const members = document.members.map((item) =>
              item.memberId === memberId ? { ...item, input } : item,
            )
            setDocument({ ...document, members })
          }
        }}
      />
    </Main>
  )
}
