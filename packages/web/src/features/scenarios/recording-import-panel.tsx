import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchRecording } from '@/lib/recordings-api'
import { DemonstrationImportPanel } from './demonstration-import-panel'
import {
  RECORDING_NORMALIZER_VERSION,
  targetDescriptorSchema,
  type DemonstrationPlacement,
  type RecordingDisposition,
  type RecordingImportPreview,
  type RecordingImportPreviewItem,
  type RecordingInsertAnchor,
  type ScenarioDetailDto,
  type ScenarioInputDecl,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  applyRecordingImport,
  fetchRecordingImports,
  previewRecordingImport,
} from '@/lib/scenarios-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { StatusBadge } from '@/components/status-badge'

const DEFAULT_DISCARD_REASON = '用户在回填时选择忽略'

type LocalDisposition =
  | { disposition: 'accept' }
  | { disposition: 'discard'; reason: string }
  | { disposition: 'replace'; step: Step }

export type RecordingImportPanelProps = {
  open: boolean
  scenarioId: string
  recordingDraftId: string | null
  revision: number
  insertAnchor: RecordingInsertAnchor
  stepCount: number
  inputs: readonly ScenarioInputDecl[]
  independentSteps?: { id: string; name: string }[]
  initialPlaceholderStepId?: string
  initialPlacement?: DemonstrationPlacement
  canApply: boolean
  hasLocalChanges?: boolean
  onOpenChange: (open: boolean) => void
  onSelectDraft: (recordingDraftId: string) => void
  onConflict: () => void
  onApplied: (scenario: ScenarioDetailDto, insertedIds: string[]) => void
}

export function RecordingImportPanel(props: RecordingImportPanelProps) {
  const source = useQuery({ queryKey: ['recordings', props.recordingDraftId], queryFn: () => fetchRecording(props.recordingDraftId!), enabled: props.open && Boolean(props.recordingDraftId) })
  if (props.open && props.recordingDraftId && !source.data) return <Sheet open onOpenChange={props.onOpenChange}><SheetContent><SheetHeader><SheetTitle>录制回填预览</SheetTitle><SheetDescription>{source.isError ? '无法读取来源，请重试。' : '正在读取来源…'}</SheetDescription></SheetHeader>{source.isError && <Button onClick={() => void source.refetch()}>重试</Button>}</SheetContent></Sheet>
  if (source.data?.sourceProtocol === 'demonstration@1') return <DemonstrationImportPanel key={`${props.recordingDraftId}:${props.initialPlaceholderStepId ?? ''}:${props.initialPlacement?.kind ?? ''}`} {...props} />
  return <LegacyRecordingImportPanel {...props} />
}

function LegacyRecordingImportPanel({
  open,
  scenarioId,
  recordingDraftId,
  revision,
  insertAnchor,
  stepCount,
  inputs,
  canApply,
  onOpenChange,
  onSelectDraft,
  onConflict,
  onApplied,
}: RecordingImportPanelProps) {
  const [preview, setPreview] = useState<RecordingImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [choices, setChoices] = useState<Record<string, LocalDisposition>>({})
  const [available, setAvailable] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    if (!open) return
    void fetchRecordingImports(scenarioId)
      .then((list) => setAvailable(list.drafts.map((item) => ({ id: item.id, name: item.name }))))
      .catch(() => setAvailable([]))
  }, [open, scenarioId])

  useEffect(() => {
    if (!open || !recordingDraftId) {
      setPreview(null)
      return
    }
    setLoading(true)
    void previewRecordingImport(scenarioId, {
      recordingDraftId,
      baseRevision: revision,
      insertAnchor,
    })
      .then((next) => {
        setPreview(next)
        setChoices(
          Object.fromEntries(
            next.items.map((item) => [
              item.sourceIndexes.join(','),
              item.outcomeCandidate
                ? { disposition: 'discard' as const, reason: '未确认为成功条件' }
                : item.ready
                  ? { disposition: 'accept' as const }
                  : { disposition: 'discard' as const, reason: DEFAULT_DISCARD_REASON },
            ]),
          ),
        )
      })
      .catch((error) => {
        toast.error(error instanceof ApiRequestError ? error.message : '无法生成导入预览')
        setPreview(null)
      })
      .finally(() => setLoading(false))
  }, [insertAnchor, open, recordingDraftId, revision, scenarioId])

  const pending = useMemo(() => {
    if (!preview) return 0
    return preview.items.filter((item) => {
      const choice = choices[item.sourceIndexes.join(',')]
      if (!choice) return true
      if (choice.disposition === 'discard') return false
      if (choice.disposition === 'accept') return !item.ready
      return false
    }).length
  }, [choices, preview])

  const insertCount = useMemo(() => {
    if (!preview) return 0
    return preview.items.filter((item) => {
      const choice = choices[item.sourceIndexes.join(',')]
      return choice && choice.disposition !== 'discard'
    }).length
  }, [choices, preview])

  const handleAcceptAllReady = () => {
    if (!preview) return
    setChoices((prev) => {
      const next = { ...prev }
      for (const item of preview.items) {
        if (item.ready && !item.outcomeCandidate) {
          next[item.sourceIndexes.join(',')] = { disposition: 'accept' }
        }
      }
      return next
    })
  }

  const handleDiscardAllUnresolved = () => {
    if (!preview) return
    setChoices((prev) => {
      const next = { ...prev }
      for (const item of preview.items) {
        if (!item.ready) {
          next[item.sourceIndexes.join(',')] = {
            disposition: 'discard',
            reason: DEFAULT_DISCARD_REASON,
          }
        }
      }
      return next
    })
  }

  async function apply() {
    if (!preview || !recordingDraftId || pending > 0) return
    const dispositions: RecordingDisposition[] = preview.items.map((item) => {
      const choice = choices[item.sourceIndexes.join(',')]!
      if (choice.disposition === 'accept') {
        return { sourceIndexes: item.sourceIndexes, disposition: 'accept' }
      }
      if (choice.disposition === 'replace') {
        return { sourceIndexes: item.sourceIndexes, disposition: 'replace', step: choice.step }
      }
      const reason = choice.reason.trim() || DEFAULT_DISCARD_REASON
      return { sourceIndexes: item.sourceIndexes, disposition: 'discard', reason }
    })
    if (insertCount === 0) {
      toast.message('已放弃导入，草稿未改动')
      onOpenChange(false)
      return
    }
    if (!canApply) {
      toast.error('没有编写权限，不能回填')
      return
    }
    setApplying(true)
    try {
      const result = await applyRecordingImport(scenarioId, {
        idempotencyKey: `import-${recordingDraftId}`,
        baseRevision: revision,
        recordingDraftId,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        sourceDigest: preview.sourceDigest,
        insertAnchor,
        dispositions,
      })
      onApplied(result.scenario, result.receipt.insertedStepIds)
      toast.success(
        result.receipt.insertedStepIds.length > 0
          ? `已插入 ${result.receipt.insertedStepIds.length} 个步骤`
          : '已确认成功条件',
      )
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        onConflict()
        toast.error('草稿基线已变化。预览选择仍保留，请重新加载后再回填')
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '回填失败')
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='flex w-full flex-col gap-4 sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>录制回填预览</SheetTitle>
          <SheetDescription>
            将源操作写入当前草稿。判定类事件只会变成成功条件候选，确认后才进入定义。
          </SheetDescription>
        </SheetHeader>
        {!recordingDraftId ? (
          <div className='space-y-2 text-body'>
            <p className='text-muted-foreground'>选择一个同目标系统的录制批次进行预览。</p>
            {available.length === 0 ? (
              <p className='text-label text-muted-foreground'>没有可导入的录制批次。</p>
            ) : (
              <ul className='space-y-2'>
                {available.map((item) => (
                  <li key={item.id}>
                    <Button variant='outline' size='sm' onClick={() => onSelectDraft(item.id)}>
                      {item.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : loading || !preview ? (
          <p className='text-body text-muted-foreground'>正在生成预览…</p>
        ) : (
          <>
            <p className='text-label text-muted-foreground'>
              {preview.recordingName} · 将插入 {insertCount} 步，保留原 {stepCount} 步，还可再加{' '}
              {preview.remainingStepCapacity} 步
            </p>
            {preview.metrics && (
              <div className='flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-2 text-label'>
                <span>总计 <strong>{preview.metrics.totalCount}</strong> 步</span>
                <span className='text-muted-foreground'>·</span>
                <span className='text-status-success-foreground'>已就绪 <strong>{preview.metrics.mappedCount}</strong></span>
                {preview.metrics.parameterizedCount > 0 && (
                  <>
                    <span className='text-muted-foreground'>·</span>
                    <span className='text-status-warning-foreground'>待补参 <strong>{preview.metrics.parameterizedCount}</strong></span>
                  </>
                )}
                {preview.metrics.unresolvedCount > 0 && (
                  <>
                    <span className='text-muted-foreground'>·</span>
                    <span className='text-status-error-foreground'>待处理 <strong>{preview.metrics.unresolvedCount}</strong></span>
                  </>
                )}
              </div>
            )}
            {preview.metrics && !preview.metrics.hasAssertions && (
              <div className='rounded-md border border-status-warning-foreground/30 bg-status-warning-background p-2.5 text-label text-status-warning-foreground'>
                ⚠️ <strong>流程缺少业务检查点</strong>：当前录制仅包含操作动作，未捕获断言。建议回填后在流程末尾补充检查点（如校验“提交成功”提示）。
              </div>
            )}
            {/* 批量决策工具栏 */}
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-card bg-muted/20 px-3 py-2 text-label'>
              <span className='text-label text-muted-foreground'>批量决策：</span>
              <div className='flex items-center gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-7 text-label'
                  onClick={handleAcceptAllReady}
                >
                  一键采纳所有就绪项
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-7 text-label text-muted-foreground hover:text-foreground'
                  onClick={handleDiscardAllUnresolved}
                >
                  一键舍弃所有待处理项
                </Button>
              </div>
            </div>
            <ol className='min-h-0 flex-1 space-y-3 overflow-y-auto pr-1'>
              {preview.items.map((item) => (
                <PreviewItem
                  key={item.sourceIndexes.join(',')}
                  item={item}
                  choice={choices[item.sourceIndexes.join(',')]}
                  inputs={inputs}
                  onChange={(next) =>
                    setChoices((current) => ({ ...current, [item.sourceIndexes.join(',')]: next }))
                  }
                />
              ))}
            </ol>
            <SheetFooter>
              <Button variant='outline' onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={pending > 0 || applying || (!canApply && insertCount > 0)}
                loading={applying}
                onClick={() => void apply()}
              >
                {insertCount === 0 ? '放弃导入' : `回填 ${insertCount} 项`}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function PreviewItem({
  item,
  choice,
  inputs,
  onChange,
}: {
  item: RecordingImportPreviewItem
  choice?: LocalDisposition
  inputs: readonly ScenarioInputDecl[]
  onChange: (next: LocalDisposition) => void
}) {
  const accepted = choice?.disposition === 'accept'
  const discarded = choice?.disposition === 'discard'
  const replaced = choice?.disposition === 'replace'
  const fillTarget = parameterizedFillTarget(item)
  const selectedFrom = replaced && choice.step.type === 'fill' ? choice.step.input.from : undefined
  return (
    <li className='rounded-lg border border-border-card bg-card p-3 shadow-card'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <p className='text-body font-medium'>
            {item.outcomeCandidate ? item.outcomeCandidate.meaning : item.name}
          </p>
          <p className='text-label text-muted-foreground'>
            {item.outcomeCandidate ? '成功条件候选' : item.sourceAction}
            {item.outcomeCandidate
              ? ''
              : item.candidateStep
                ? ` → ${item.candidateStep.type}`
                : ''}
          </p>
        </div>
        <StatusBadge tone={item.ready ? 'success' : item.sensitive ? 'warning' : 'neutral'}>
          {item.outcomeCandidate ? (item.ready ? '待确认' : '不能确认') : item.ready ? '可接受' : item.sensitive ? '需绑定参数' : '待处理'}
        </StatusBadge>
      </div>
      {item.outcomeCandidate?.reasons.map((line) => (
        <p key={line} className='mt-1 text-label text-muted-foreground'>
          {line}
        </p>
      ))}
      {item.diagnostics.map((line) => (
        <p key={line} className='mt-1 text-label text-status-warning-foreground'>
          {line}
        </p>
      ))}
      <div className='mt-3 flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant={accepted ? 'default' : 'outline'}
          disabled={!item.ready}
          onClick={() => onChange({ disposition: 'accept' })}
        >
          <CircleCheck className='size-3.5' />
          {item.outcomeCandidate ? '确认为成功条件' : '接受'}
        </Button>
        <Button
          size='sm'
          variant={discarded ? 'default' : 'outline'}
          onClick={() =>
            onChange({
              disposition: 'discard',
              reason: discarded && choice.reason ? choice.reason : DEFAULT_DISCARD_REASON,
            })
          }
        >
          <CircleX className='size-3.5' />
          舍弃
        </Button>
      </div>
      {fillTarget ? (
        <FillParameterBinding
          item={item}
          fillTarget={fillTarget}
          inputs={inputs}
          selectedFrom={selectedFrom}
          onChange={onChange}
        />
      ) : null}
      {discarded ? (
        <Textarea
          className='mt-2'
          rows={2}
          placeholder='说明舍弃原因（可选，默认为回填时忽略）'
          value={choice.reason === DEFAULT_DISCARD_REASON ? '' : choice.reason}
          onChange={(event) =>
            onChange({
              disposition: 'discard',
              reason: event.target.value.trim() ? event.target.value : DEFAULT_DISCARD_REASON,
            })
          }
        />
      ) : null}
      {!item.ready && !fillTarget ? (
        <p className='mt-2 flex items-center gap-1 text-label text-muted-foreground'>
          <CircleHelp className='size-3.5' />
          不能自动接受。舍弃或回到步骤编辑器手工重建。
        </p>
      ) : null}
    </li>
  )
}

function FillParameterBinding({
  item,
  fillTarget,
  inputs,
  selectedFrom,
  onChange,
}: {
  item: RecordingImportPreviewItem
  fillTarget: TargetDescriptor
  inputs: readonly ScenarioInputDecl[]
  selectedFrom?: string
  onChange: (next: LocalDisposition) => void
}) {
  const [customMode, setCustomMode] = useState(inputs.length === 0)
  const [customKey, setCustomKey] = useState('')

  return (
    <div className='mt-3 space-y-2 rounded-md border border-border-card bg-muted/20 p-2.5'>
      <div className='flex items-center justify-between'>
        <Label className='text-label font-medium'>绑定参数</Label>
        {inputs.length > 0 && (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5 text-label text-primary'
            onClick={() => setCustomMode(!customMode)}
          >
            {customMode ? '选择已有参数' : '＋ 自定义参数名'}
          </Button>
        )}
      </div>

      {!customMode && inputs.length > 0 ? (
        <Select
          value={selectedFrom ?? ''}
          onValueChange={(key) => onChange(replaceFill(item, fillTarget, key))}
        >
          <SelectTrigger className='w-full bg-card' aria-label={`${item.name} 绑定参数`}>
            <SelectValue placeholder='选择参数' />
          </SelectTrigger>
          <SelectContent>
            {inputs.map((input) => (
              <SelectItem key={input.key} value={input.key}>
                {input.label || input.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className='space-y-1.5'>
          <div className='flex items-center gap-2'>
            <Input
              value={customKey}
              onChange={(e) => {
                setCustomKey(e.target.value)
                const trimmed = e.target.value.trim()
                if (trimmed) {
                  onChange(replaceFill(item, fillTarget, trimmed))
                }
              }}
              placeholder={item.sensitive ? '如: password' : '输入参数名，如: username'}
              className='h-8 bg-card text-label font-mono'
              aria-label={`${item.name} 输入参数键名`}
            />
          </div>
          <p className='text-label text-muted-foreground'>
            输入参数键名后将自动生成带参填充步骤，回填后在场景中可用。
          </p>
        </div>
      )}
      {selectedFrom && (
        <p className='text-label font-mono text-status-success-foreground'>
          ✓ 已绑定参数: {selectedFrom}
        </p>
      )}
    </div>
  )
}

function parameterizedFillTarget(item: RecordingImportPreviewItem): TargetDescriptor | undefined {
  if (item.candidateStepType !== 'fill' || item.ready) return undefined
  if (!item.input || typeof item.input !== 'object' || Array.isArray(item.input) || !('target' in item.input)) {
    return undefined
  }
  const parsed = targetDescriptorSchema.safeParse(item.input.target)
  return parsed.success ? parsed.data : undefined
}

function replaceFill(
  item: RecordingImportPreviewItem,
  target: TargetDescriptor,
  from: string,
): LocalDisposition {
  return {
    disposition: 'replace',
    step: {
      id: newStepId(),
      name: item.name,
      type: 'fill',
      effectType: 'SIDE_EFFECT',
      input: { target, from, sensitive: item.sensitive },
    },
  }
}

function newStepId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
