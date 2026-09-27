import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  DEMONSTRATION_HANDOFF_PLACEHOLDER_NAME,
  RECORDING_NORMALIZER_VERSION,
  type ApplyDemonstrationBody,
  type RecordingDisposition,
  type RecordingInsertAnchor,
  type DemonstrationPlacement,
} from '@cairn/shared'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  ListTree,
  Plus,
} from 'lucide-react'
import { ApiRequestError } from '@/lib/api-client'
import {
  applyRecordingImport,
  createScenario,
  fetchScenario,
  fetchScenarios,
  previewRecordingImport,
} from '@/lib/scenarios-api'
import {
  applyDemonstrationImport,
  newDemonstrationId,
  previewDemonstrationImport,
} from '@/lib/demonstrations-api'
import { fetchRecording, handoffCreateScenario } from '@/lib/recordings-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createBlankStep } from '@/features/authoring'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordingId: string
  recordingName: string
  targetId: string
  targetName: string
  sourceProtocol?: 'recording@1' | 'demonstration@1'
  generalizationRevision?: number
  candidateDigest?: string
}

export function RecordingHandoffDialog({
  open,
  onOpenChange,
  recordingId,
  recordingName,
  targetId,
  targetName,
  sourceProtocol,
  generalizationRevision,
  candidateDigest,
}: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'existing' | 'new'>('existing')
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('')
  const [newScenarioName, setNewScenarioName] = useState(recordingName)
  const [creating, setCreating] = useState(false)
  const [applyingDirectly, setApplyingDirectly] = useState(false)
  const directAttempt = useRef<{ fingerprint: string; key: string } | null>(null)

  // 插入位置与锚点决策
  const [anchorMode, setAnchorMode] = useState<'end' | 'after_step' | 'start' | 'replace'>('end')
  const [selectedAfterStepId, setSelectedAfterStepId] = useState<string>('')
  const [selectedReplaceStepId, setSelectedReplaceStepId] = useState<string>('')

  // 获取同目标系统下的已有场景列表
  const scenariosQuery = useQuery({
    queryKey: ['scenarios', { targetId, limit: 100 }],
    queryFn: () => fetchScenarios({ targetId, limit: 100 }),
    enabled: open,
  })

  const scenarios = useMemo(
    () => scenariosQuery.data?.items ?? [],
    [scenariosQuery.data?.items]
  )

  // 默认选中第一个已有场景
  const effectiveScenarioId =
    selectedScenarioId || (scenarios.length > 0 ? scenarios[0].id : '')

  // 预取当前草稿的步骤详情（供 Mini-Diff 与就绪度检查）
  const draftQuery = useQuery({
    queryKey: ['recording-for-handoff', recordingId],
    queryFn: () => fetchRecording(recordingId),
    enabled: open && Boolean(recordingId),
  })
  const draftItems = draftQuery.data?.items ?? []
  const unresolvedCount = draftQuery.data?.unresolvedCount ?? 0

  // 预取选中目标场景的现有步骤与版本
  const targetScenarioQuery = useQuery({
    queryKey: ['scenario-detail-for-handoff', effectiveScenarioId],
    queryFn: () => fetchScenario(effectiveScenarioId),
    enabled: open && Boolean(effectiveScenarioId),
  })

  const targetScenario = targetScenarioQuery.data
  const existingSteps = targetScenario?.steps ?? []
  const lastStep = existingSteps[existingSteps.length - 1]
  const firstStep = existingSteps[0]
  const currentRevision = targetScenario?.draft?.revision ?? 1

  // 计算当前选择的插入锚点
  const currentAnchor: RecordingInsertAnchor = useMemo(() => {
    if (anchorMode === 'start') return { kind: 'start' }
    if (anchorMode === 'after_step' && selectedAfterStepId) {
      return { kind: 'after', stepId: selectedAfterStepId }
    }
    if (anchorMode === 'replace' && selectedReplaceStepId) {
      return { kind: 'after', stepId: selectedReplaceStepId }
    }
    // 默认末尾追加
    return lastStep ? { kind: 'after', stepId: lastStep.id } : { kind: 'start' }
  }, [anchorMode, selectedAfterStepId, selectedReplaceStepId, lastStep])

  const currentPlacement: DemonstrationPlacement = useMemo(() => {
    if (anchorMode === 'start') return { kind: 'start' }
    if (anchorMode === 'after_step' && selectedAfterStepId) {
      return { kind: 'after', nodeId: selectedAfterStepId }
    }
    if (anchorMode === 'replace' && selectedReplaceStepId) {
      return { kind: 'replace', nodeId: selectedReplaceStepId }
    }
    // 默认末尾追加
    return lastStep ? { kind: 'after', nodeId: lastStep.id } : { kind: 'start' }
  }, [anchorMode, selectedAfterStepId, selectedReplaceStepId, lastStep])

  // 通道 B：前往 Studio 深度微调（带齐确定的锚点与放置参数）
  const handleGoExistingStudio = () => {
    if (!effectiveScenarioId) {
      toast.error('请选择一个目标场景')
      return
    }
    onOpenChange(false)
    const placementParam = currentPlacement.kind
    const nodeIdParam =
      'nodeId' in currentPlacement ? currentPlacement.nodeId : undefined

    void navigate({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: effectiveScenarioId },
      search: {
        import: recordingId,
        importPlacement: placementParam,
        importNodeId: nodeIdParam,
      },
    })
  }

  // 通道 A：直接就地回填（就绪度 100% 时无须跳出页面）
  const handleDirectApply = async () => {
    if (!effectiveScenarioId) {
      toast.error('请选择目标场景')
      return
    }
    setApplyingDirectly(true)
    try {
      if (sourceProtocol === 'demonstration@1') {
        // 示教协议回填
        const preview = await previewDemonstrationImport(effectiveScenarioId, {
          protocolVersion: 'demonstration@1',
          recordingDraftId: recordingId,
          baseRevision: currentRevision,
          placement: currentPlacement,
        })
        if (preview.suggestions.length === 0) throw new Error('没有可回填的步骤')
        const decisions: ApplyDemonstrationBody['decisions'] = preview.suggestions.map((suggestion) =>
          suggestion.status === 'mapped'
            ? { id: suggestion.id, disposition: 'accept' }
            : { id: suggestion.id, disposition: 'discard', reason: '待处理项已在就地回填中忽略' },
        )
        const fingerprint = JSON.stringify({ effectiveScenarioId, recordingId, preview, decisions })
        if (directAttempt.current?.fingerprint !== fingerprint)
          directAttempt.current = { fingerprint, key: newDemonstrationId() }
        const result = await applyDemonstrationImport(effectiveScenarioId, {
          protocolVersion: 'demonstration@1',
          recordingDraftId: recordingId,
          baseRevision: preview.baseRevision,
          placement: currentPlacement,
          factDigest: preview.factDigest,
          suggestionDigest: preview.suggestionDigest,
          adapterVersion: preview.adapterVersion,
          ruleVersion: preview.ruleVersion,
          decisions,
          idempotencyKey: directAttempt.current.key,
        })
        directAttempt.current = null
        toast.success(
          `已成功将 ${result.receipt.insertedStepIds.length} 个步骤回填至「${targetScenario?.name ?? '目标场景'}」`
        )
      } else {
        // 普通脚本录制回填
        const preview = await previewRecordingImport(effectiveScenarioId, {
          recordingDraftId: recordingId,
          baseRevision: currentRevision,
          insertAnchor: currentAnchor,
        })
        if (preview.items.length === 0) throw new Error('没有可回填的步骤')
        const dispositions: RecordingDisposition[] = preview.items.map((item) =>
          item.outcomeCandidate
            ? { sourceIndexes: item.sourceIndexes, disposition: 'discard', reason: '未确认为成功条件' }
            : item.ready
              ? { sourceIndexes: item.sourceIndexes, disposition: 'accept' }
              : { sourceIndexes: item.sourceIndexes, disposition: 'discard', reason: '待处理项已在就地回填中忽略' },
        )
        const fingerprint = JSON.stringify({ effectiveScenarioId, recordingId, preview, dispositions })
        if (directAttempt.current?.fingerprint !== fingerprint)
          directAttempt.current = { fingerprint, key: newDemonstrationId() }
        const result = await applyRecordingImport(effectiveScenarioId, {
          idempotencyKey: directAttempt.current.key,
          baseRevision: preview.currentRevision,
          recordingDraftId: recordingId,
          normalizerVersion: RECORDING_NORMALIZER_VERSION,
          sourceDigest: preview.sourceDigest,
          insertAnchor: currentAnchor,
          dispositions,
        })
        directAttempt.current = null
        toast.success(
          `已成功将 ${result.receipt.insertedStepIds.length} 个步骤追加至「${targetScenario?.name ?? '目标场景'}」`
        )
      }
      onOpenChange(false)
      // 刷新列表与详情
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      void queryClient.invalidateQueries({ queryKey: ['recordings', recordingId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '就地回填失败，可尝试进入 Studio 手动合入')
    } finally {
      setApplyingDirectly(false)
    }
  }

  const handleCreateAndHandoff = async () => {
    if (!newScenarioName.trim()) {
      toast.error('请输入新场景名称')
      return
    }
    setCreating(true)
    if (sourceProtocol === 'demonstration@1' && candidateDigest && generalizationRevision) {
      try {
        const res = await handoffCreateScenario(recordingId, {
          name: newScenarioName.trim(),
          revision: generalizationRevision,
          candidateDigest,
        })
        toast.success(`新场景「${res.scenario.name}」已由泛化候选原子创建并回填`)
        onOpenChange(false)
        void navigate({
          to: '/scenarios/$scenarioId',
          params: { scenarioId: res.scenario.id },
        })
      } catch (error) {
        toast.error(
          error instanceof ApiRequestError ? error.message : '创建场景失败'
        )
      } finally {
        setCreating(false)
      }
      return
    }

    try {
      const created = await createScenario({
        targetId,
        name: newScenarioName.trim(),
        steps: [
          {
            ...createBlankStep('navigate'),
            ...(sourceProtocol === 'demonstration@1'
              ? { name: DEMONSTRATION_HANDOFF_PLACEHOLDER_NAME }
              : {}),
          },
        ],
      })
      toast.success(`新场景「${created.name}」已创建`)
      onOpenChange(false)
      void navigate({
        to: '/scenarios/$scenarioId',
        params: { scenarioId: created.id },
        search: { import: recordingId },
      })
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError ? error.message : '创建场景失败'
      )
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle>回填录制草稿到场景</DialogTitle>
          <DialogDescription>
            将操作序列导入至目标系统「{targetName}」下的场景，进行结构化编排与调试。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as 'existing' | 'new')}
          className='w-full'
        >
          <TabsList className='grid w-full grid-cols-2'>
            <TabsTrigger
              value='existing'
              disabled={scenarios.length === 0 && !scenariosQuery.isLoading}
            >
              回填到已有场景 {scenarios.length > 0 ? `(${scenarios.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value='new'>以草稿新建场景</TabsTrigger>
          </TabsList>

          {/* Tab 1: 回填到已有场景 (就地向导) */}
          <TabsContent value='existing' className='mt-4 space-y-4'>
            {scenariosQuery.isLoading ? (
              <p className='py-6 text-center text-label text-muted-foreground'>
                正在加载场景列表…
              </p>
            ) : scenarios.length === 0 ? (
              <div className='rounded-md border border-dashed border-border-card p-6 text-center text-label text-muted-foreground'>
                当前目标系统下尚无可用场景，请切换到「以草稿新建场景」创建首个场景。
              </div>
            ) : (
              <div className='space-y-4'>
                {/* 1. 目标场景选择 */}
                <div className='space-y-1.5'>
                  <Label htmlFor='scenario-select' className='text-label font-medium'>
                    1. 选择目标场景
                  </Label>
                  <Select
                    value={effectiveScenarioId}
                    onValueChange={setSelectedScenarioId}
                  >
                    <SelectTrigger id='scenario-select' className='w-full'>
                      <SelectValue placeholder='请选择场景' />
                    </SelectTrigger>
                    <SelectContent>
                      {scenarios.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} ({s.stepCount} 步)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* 2. 插入位置选择器 (消除默认插开头的隐患) */}
                <div className='space-y-2'>
                  <Label className='text-label font-medium'>
                    2. 确定插入位置 (Insertion Anchor)
                  </Label>
                  <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                    {/* 选项 A: 追加到末尾 (默认) */}
                    <button
                      type='button'
                      onClick={() => setAnchorMode('end')}
                      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-[background-color,border-color,color,box-shadow] ${
                        anchorMode === 'end'
                          ? 'border-primary bg-primary/5 text-primary shadow-xs'
                          : 'border-border bg-card hover:bg-surface-subtle text-foreground'
                      }`}
                    >
                      <div className='flex items-center gap-1.5 font-medium text-body'>
                        <span className={`size-3.5 rounded-full border flex items-center justify-center ${anchorMode === 'end' ? 'border-primary bg-primary' : 'border-muted-foreground'}`}>
                          {anchorMode === 'end' && <Check className='size-2.5 text-primary-foreground' />}
                        </span>
                        追加到流程末尾 (推荐)
                      </div>
                      <p className='text-label text-muted-foreground'>
                        {lastStep
                          ? `紧接在第 ${existingSteps.length} 步「${lastStep.name}」之后`
                          : '当前场景为空，作为首组步骤载入'}
                      </p>
                    </button>

                    {/* 选项 B: 插入到指定步骤后 */}
                    <button
                      type='button'
                      onClick={() => {
                        setAnchorMode('after_step')
                        if (!selectedAfterStepId && lastStep) {
                          setSelectedAfterStepId(lastStep.id)
                        }
                      }}
                      disabled={existingSteps.length === 0}
                      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-[background-color,border-color,color,box-shadow] ${
                        anchorMode === 'after_step'
                          ? 'border-primary bg-primary/5 text-primary shadow-xs'
                          : 'border-border bg-card hover:bg-surface-subtle text-foreground disabled:opacity-50'
                      }`}
                    >
                      <div className='flex items-center gap-1.5 font-medium text-body'>
                        <span className={`size-3.5 rounded-full border flex items-center justify-center ${anchorMode === 'after_step' ? 'border-primary bg-primary' : 'border-muted-foreground'}`}>
                          {anchorMode === 'after_step' && <Check className='size-2.5 text-primary-foreground' />}
                        </span>
                        插入到指定步骤后
                      </div>
                      <p className='text-label text-muted-foreground'>
                        在特定流程节点后加入新交互序列
                      </p>
                    </button>

                    {/* 选项 C: 作为流程前置准备 (开头) */}
                    <button
                      type='button'
                      onClick={() => setAnchorMode('start')}
                      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-[background-color,border-color,color,box-shadow] ${
                        anchorMode === 'start'
                          ? 'border-primary bg-primary/5 text-primary shadow-xs'
                          : 'border-border bg-card hover:bg-surface-subtle text-foreground'
                      }`}
                    >
                      <div className='flex items-center gap-1.5 font-medium text-body'>
                        <span className={`size-3.5 rounded-full border flex items-center justify-center ${anchorMode === 'start' ? 'border-primary bg-primary' : 'border-muted-foreground'}`}>
                          {anchorMode === 'start' && <Check className='size-2.5 text-primary-foreground' />}
                        </span>
                        作为前置步骤 (流程最前)
                      </div>
                      <p className='text-label text-muted-foreground'>
                        {firstStep
                          ? `插在第 1 步「${firstStep.name}」之前`
                          : '作为流程初始化首组步骤'}
                      </p>
                    </button>

                    {/* 选项 D: 替换已有步骤 */}
                    <button
                      type='button'
                      onClick={() => {
                        setAnchorMode('replace')
                        if (!selectedReplaceStepId && existingSteps[0]) {
                          setSelectedReplaceStepId(existingSteps[0].id)
                        }
                      }}
                      disabled={existingSteps.length === 0 || sourceProtocol !== 'demonstration@1'}
                      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-[background-color,border-color,color,box-shadow] ${
                        anchorMode === 'replace'
                          ? 'border-primary bg-primary/5 text-primary shadow-xs'
                          : 'border-border bg-card hover:bg-surface-subtle text-foreground disabled:opacity-50'
                      }`}
                    >
                      <div className='flex items-center gap-1.5 font-medium text-body'>
                        <span className={`size-3.5 rounded-full border flex items-center justify-center ${anchorMode === 'replace' ? 'border-primary bg-primary' : 'border-muted-foreground'}`}>
                          {anchorMode === 'replace' && <Check className='size-2.5 text-primary-foreground' />}
                        </span>
                        替换已有特定步骤
                      </div>
                      <p className='text-label text-muted-foreground'>
                        {sourceProtocol === 'demonstration@1' ? '用于修正失效步骤或重放覆盖' : '仅示教草稿支持替换已有步骤'}
                      </p>
                    </button>
                  </div>

                  {/* 细分下拉框：当选中 after_step 或 replace 时展示 */}
                  {anchorMode === 'after_step' && existingSteps.length > 0 && (
                    <div className='mt-2 space-y-1 rounded-md border border-border-card bg-surface-subtle p-2.5'>
                      <Label htmlFor='after-step-select' className='text-label text-muted-foreground'>
                        选择前置步骤：
                      </Label>
                      <Select
                        value={selectedAfterStepId || lastStep?.id || ''}
                        onValueChange={setSelectedAfterStepId}
                      >
                        <SelectTrigger id='after-step-select' className='h-8 bg-card text-label'>
                          <SelectValue placeholder='选择步骤' />
                        </SelectTrigger>
                        <SelectContent>
                          {existingSteps.map((step, idx) => (
                            <SelectItem key={step.id} value={step.id}>
                              第 {idx + 1} 步: {step.name} ({step.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {anchorMode === 'replace' && existingSteps.length > 0 && (
                    <div className='mt-2 space-y-1 rounded-md border border-border-card bg-surface-subtle p-2.5'>
                      <Label htmlFor='replace-step-select' className='text-label text-muted-foreground'>
                        选择要替换的目标步骤：
                      </Label>
                      <Select
                        value={selectedReplaceStepId || existingSteps[0]?.id || ''}
                        onValueChange={setSelectedReplaceStepId}
                      >
                        <SelectTrigger id='replace-step-select' className='h-8 bg-card text-label'>
                          <SelectValue placeholder='选择步骤' />
                        </SelectTrigger>
                        <SelectContent>
                          {existingSteps.map((step, idx) => (
                            <SelectItem key={step.id} value={step.id}>
                              第 {idx + 1} 步: {step.name} ({step.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* 3. 流程变更对比 (Pipeline Mini-Diff Preview) */}
                <div className='space-y-2 rounded-lg border border-border bg-surface-subtle/50 p-3'>
                  <div className='flex items-center justify-between text-label font-medium text-foreground'>
                    <span className='inline-flex items-center gap-1.5'>
                      <ListTree className='size-4 text-primary' />
                      3. 回填后流程结构对比 (Mini-Diff)
                    </span>
                    <span className='text-muted-foreground font-normal'>
                      原 {existingSteps.length} 步 + 本次 {draftItems.length} 步 = 变更后 {existingSteps.length + draftItems.length} 步
                    </span>
                  </div>

                  {/* 微缩步骤流水线时间轴展示 */}
                  <div className='flex flex-wrap items-center gap-1.5 py-1 text-label overflow-x-auto'>
                    {/* 开头插入标记 */}
                    {anchorMode === 'start' && draftItems.map((item, idx) => (
                      <span
                        key={`ins-start-${idx}`}
                        className='inline-flex items-center gap-1 rounded bg-status-success-background border border-status-success-accent/40 px-2 py-1 font-medium text-status-success-foreground'
                        title={item.name}
                      >
                        <Plus className='size-3 text-status-success-foreground' />
                        +{idx + 1}. {item.name.slice(0, 10)}
                      </span>
                    ))}

                    {/* 折叠视窗：若前序步骤过多，折叠非锚点前序 */}
                    {existingSteps.length > 4 && anchorMode === 'end' ? (
                      <>
                        <span className='rounded bg-muted px-2 py-1 text-muted-foreground text-label font-mono'>
                          … 前序 {existingSteps.length - 2} 步 (已折叠)
                        </span>
                        <ChevronRight className='size-3 text-muted-foreground shrink-0' />
                        {existingSteps.slice(-2).map((s, i) => (
                          <div key={s.id} className='inline-flex items-center gap-1.5'>
                            <span className='rounded border border-border bg-card px-2 py-1 text-muted-foreground'>
                              {existingSteps.length - 2 + i + 1}. {s.name.slice(0, 10)}
                            </span>
                            <ChevronRight className='size-3 text-muted-foreground shrink-0' />
                          </div>
                        ))}
                      </>
                    ) : (
                      existingSteps.map((s, idx) => {
                        const isReplaced = anchorMode === 'replace' && (selectedReplaceStepId || existingSteps[0]?.id) === s.id
                        const isAfterAnchor = anchorMode === 'after_step' && (selectedAfterStepId || lastStep?.id) === s.id
                        return (
                          <div key={s.id} className='inline-flex items-center gap-1.5'>
                            <span
                              className={`rounded border px-2 py-1 text-label ${
                                isReplaced
                                  ? 'border-status-warning-foreground/40 bg-status-warning-background line-through text-status-warning-foreground'
                                  : 'border-border bg-card text-muted-foreground'
                              }`}
                            >
                              {idx + 1}. {s.name.slice(0, 10)}
                            </span>
                            {/* 在指定步骤后插入的预览 */}
                            {isAfterAnchor && draftItems.map((item, dIdx) => (
                              <span
                                key={`ins-after-${dIdx}`}
                                className='inline-flex items-center gap-1 rounded bg-status-success-background border border-status-success-accent/40 px-2 py-1 font-medium text-status-success-foreground'
                                title={item.name}
                              >
                                <Plus className='size-3 text-status-success-foreground' />
                                +{idx + dIdx + 2}. {item.name.slice(0, 10)}
                              </span>
                            ))}
                            <ChevronRight className='size-3 text-muted-foreground shrink-0' />
                          </div>
                        )
                      })
                    )}

                    {/* 末尾追加标记 */}
                    {anchorMode === 'end' && draftItems.map((item, idx) => (
                      <span
                        key={`ins-end-${idx}`}
                        className='inline-flex items-center gap-1 rounded bg-status-success-background border border-status-success-accent/40 px-2 py-1 font-medium text-status-success-foreground'
                        title={item.name}
                      >
                        <Plus className='size-3 text-status-success-foreground' />
                        +{existingSteps.length + idx + 1}. {item.name.slice(0, 10)}
                      </span>
                    ))}
                  </div>

                  {unresolvedCount > 0 ? (
                    <p className='text-label text-status-warning-foreground pt-0.5'>
                      ⚠️ 注意：草稿中包含 {unresolvedCount} 个待处理项，回填时未就绪动作将被自动舍弃；若需逐个替换，请选择「在 Studio 中深度微调」。
                    </p>
                  ) : (
                    <p className='text-label text-status-success-foreground pt-0.5'>
                      ✓ 本草稿步骤均已就绪，回填后直接作为正式步骤生效。
                    </p>
                  )}
                </div>
              </div>
            )}

            <DialogFooter className='flex-wrap gap-2 pt-2'>
              <Button variant='outline' onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                variant='secondary'
                disabled={!effectiveScenarioId || scenariosQuery.isLoading || applyingDirectly}
                onClick={handleGoExistingStudio}
                className='gap-1.5'
              >
                在 Studio 中深度微调
                <ExternalLink className='size-3.5' />
              </Button>
              <Button
                disabled={!effectiveScenarioId || scenariosQuery.isLoading || applyingDirectly}
                loading={applyingDirectly}
                onClick={() => void handleDirectApply()}
                className='gap-1.5'
              >
                直接回填至场景
                <CheckCircle2 className='size-3.5' />
              </Button>
            </DialogFooter>
          </TabsContent>

          {/* Tab 2: 以草稿新建场景 */}
          <TabsContent value='new' className='mt-4 space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='new-scenario-name' className='text-label font-medium'>
                新场景名称
              </Label>
              <Input
                id='new-scenario-name'
                value={newScenarioName}
                onChange={(e) => setNewScenarioName(e.target.value)}
                placeholder='输入新场景名称'
                maxLength={128}
              />
              <p className='text-label text-muted-foreground'>
                将基于目标系统「{targetName}」创建新场景，并在创建后自动合入本草稿全部操作。
              </p>
            </div>
            <DialogFooter>
              <Button variant='outline' onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={!newScenarioName.trim() || creating}
                loading={creating}
                onClick={() => void handleCreateAndHandoff()}
                className='gap-1.5'
              >
                创建并合入
                <ArrowRight className='size-3.5' />
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
