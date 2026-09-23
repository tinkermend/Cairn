import { useEffect, useMemo, useRef, useState } from 'react'
import {
  stepSchema,
  type ApplyDemonstrationBody,
  type DemonstrationPlacement,
  type DemonstrationPreview,
  type DemonstrationSuggestion,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, CheckCheck } from 'lucide-react'
import { ApiRequestError } from '@/lib/api-client'
import {
  applyDemonstrationImport,
  newDemonstrationId,
  previewDemonstrationImport,
} from '@/lib/demonstrations-api'
import { fetchScenario } from '@/lib/scenarios-api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { StepEditor } from '@/features/authoring/step-editor'
import {
  createBlankStep,
  DETERMINISTIC_STUDIO_TYPES,
} from '@/features/authoring/step-registry'
import { SavedDemonstrationFacts } from '@/features/recordings/demonstration-facts'
import type { RecordingImportPanelProps } from './recording-import-panel'

type Decision = ApplyDemonstrationBody['decisions'][number]
const editable = [
  ...DETERMINISTIC_STUDIO_TYPES,
  'ai_action',
  'ai_extract',
  'ai_assert',
] as const

export interface SuggestionGroupVM {
  groupId: string
  title: string
  description?: string
  effectType: 'read' | 'idempotent_write' | 'write' | 'unknown'
  items: Array<{ item: DemonstrationSuggestion; originalIndex: number }>
}

export function buildSuggestionGroups(suggestions: DemonstrationSuggestion[]): SuggestionGroupVM[] {
  if (!suggestions.length) return []
  const groups: SuggestionGroupVM[] = []
  let currentGroup: SuggestionGroupVM | null = null

  for (let i = 0; i < suggestions.length; i++) {
    const item = suggestions[i]!
    let targetType: SuggestionGroupVM['effectType'] = 'unknown'
    let defaultTitle = '页面交互'

    if (item.action === 'navigate' || item.step?.type === 'navigate') {
      targetType = 'read'
      defaultTitle = '页面导航与进入'
    } else if (item.outcome || item.step?.type === 'assert' || item.action === 'aiWaitFor') {
      targetType = 'read'
      defaultTitle = '成功条件与断言'
    } else if (item.step?.type === 'fill' || item.action === 'aiInput') {
      targetType = 'idempotent_write'
      defaultTitle = '表单与数据填写'
    } else if (item.step?.type === 'click' || item.action === 'aiTap') {
      targetType = 'write'
      defaultTitle = '按钮与触发动作'
    } else if (item.status === 'observation') {
      targetType = 'read'
      defaultTitle = '页面观察事实'
    }

    if (!currentGroup || currentGroup.title !== defaultTitle) {
      currentGroup = {
        groupId: `grp-${groups.length + 1}`,
        title: defaultTitle,
        effectType: targetType,
        items: [],
      }
      groups.push(currentGroup)
    }

    currentGroup.items.push({ item, originalIndex: i })
  }

  return groups
}

export function DemonstrationImportPanel(props: RecordingImportPanelProps) {
  const {
    open,
    scenarioId,
    recordingDraftId,
    revision,
    insertAnchor,
    onOpenChange,
  } = props
  const [placement, setPlacement] = useState<DemonstrationPlacement>(() =>
    insertAnchor.kind === 'start'
      ? { kind: 'start' }
      : { kind: 'after', nodeId: insertAnchor.stepId }
  )
  const [preview, setPreview] = useState<DemonstrationPreview>()
  const [choices, setChoices] = useState<Record<string, Decision>>({})
  const [openGroups, setOpenGroups] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)
  const baseline = useRef(revision)
  const request = useRef(0)

  const groups = useMemo(
    () => buildSuggestionGroups(preview?.suggestions ?? []),
    [preview?.suggestions]
  )
  useEffect(() => {
    if (groups.length > 0) {
      setOpenGroups(groups.map((g) => g.groupId))
    }
  }, [groups])

  async function refresh(nextRevision = revision) {
    if (!recordingDraftId) return
    const ticket = ++request.current
    setLoading(true)
    setError('')
    try {
      const next = await previewDemonstrationImport(scenarioId, {
        protocolVersion: 'demonstration@1',
        recordingDraftId,
        baseRevision: nextRevision,
        placement,
      })
      if (ticket !== request.current) return
      baseline.current = nextRevision
      setPreview(next)
      setConflict(false)
      // Source IDs are immutable: an OCC refresh preserves the user's edits and reasons.
      setChoices((previous) =>
        Object.fromEntries(
          next.suggestions.flatMap((item) =>
            previous[item.id] ? [[item.id, previous[item.id]]] : []
          )
        )
      )
    } catch (e) {
      if (ticket === request.current)
        setError(e instanceof Error ? e.message : '预览失败')
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }
  useEffect(() => {
    if (open) void refresh()
    return () => {
      request.current++
    }
  }, [open, recordingDraftId, scenarioId, revision, placement])
  const pending =
    preview?.suggestions.filter((item) => {
      const choice = choices[item.id]
      return (
        !choice ||
        (choice.disposition === 'discard' && !choice.reason.trim()) ||
        (choice.disposition === 'replace' &&
          !stepSchema.safeParse(choice.step).success)
      )
    }).length ?? 0
  const kept =
    preview?.suggestions.filter(
      (item) => choices[item.id] && choices[item.id].disposition !== 'discard'
    ).length ?? 0
  async function apply() {
    if (
      !preview ||
      !recordingDraftId ||
      pending ||
      loading ||
      !props.canApply ||
      props.hasLocalChanges
    )
      return
    setApplying(true)
    setError('')
    const payload = {
      protocolVersion: 'demonstration@1' as const,
      recordingDraftId,
      baseRevision: preview.baseRevision,
      placement,
      factDigest: preview.factDigest,
      suggestionDigest: preview.suggestionDigest,
      adapterVersion: preview.adapterVersion,
      ruleVersion: preview.ruleVersion,
      decisions: preview.suggestions.map((item) => choices[item.id]),
    }
    const fingerprint = JSON.stringify(payload)
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newDemonstrationId() }
    try {
      const result = await applyDemonstrationImport(scenarioId, {
        ...payload,
        idempotencyKey: attempt.current.key,
      })
      props.onApplied(result.scenario, result.receipt.insertedStepIds)
      onOpenChange(false)
      toast.success(
        placement.kind === 'replace'
          ? '已替换所选步骤，原有引用与成功条件已保留'
          : '已回填到当前草稿'
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '回填失败')
      if (
        e instanceof ApiRequestError &&
        e.payload.code === 'SCENARIO_DRAFT_CONFLICT'
      ) {
        setConflict(true)
        props.onConflict()
      }
    } finally {
      setApplying(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!applying) onOpenChange(next)
      }}
    >
      <SheetContent
        side='right'
        className='flex w-full flex-col gap-4 sm:max-w-2xl'
      >
        <SheetHeader>
          <SheetTitle>示教回填预览</SheetTitle>
          <SheetDescription>
            逐项接受、修正或舍弃。参数声明与步骤一起保存，成功条件需要明确确认。
          </SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto px-6'>
          {props.hasLocalChanges && (
            <p
              role='alert'
              className='text-label text-status-warning-foreground'
            >
              请先保存当前场景的修改，再确认回填。
            </p>
          )}
          <div className='space-y-2'>
            <Label>回填位置</Label>
            <Select
              value={
                placement.kind === 'replace'
                  ? `replace:${placement.nodeId}`
                  : placement.kind === 'after'
                    ? `after:${placement.nodeId}`
                    : 'start'
              }
              disabled={applying}
              onValueChange={(v) =>
                setPlacement(
                  v === 'start'
                    ? { kind: 'start' }
                    : {
                        kind: v.startsWith('replace:') ? 'replace' : 'after',
                        nodeId: v.slice(v.indexOf(':') + 1),
                      }
                )
              }
            >
              <SelectTrigger className='w-full' aria-label='回填位置'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='start'>插入到开头</SelectItem>
                {props.independentSteps?.map((s) => (
                  <SelectItem key={`a-${s.id}`} value={`after:${s.id}`}>
                    插入到「{s.name}」之后
                  </SelectItem>
                ))}
                {insertAnchor.kind === 'after' &&
                  !props.independentSteps?.some(
                    (s) => s.id === insertAnchor.stepId
                  ) && (
                    <SelectItem value={`after:${insertAnchor.stepId}`}>
                      插入到当前节点之后
                    </SelectItem>
                  )}
                {props.independentSteps?.map((s) => (
                  <SelectItem key={`r-${s.id}`} value={`replace:${s.id}`}>
                    重新示教「{s.name}」
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {placement.kind === 'replace' && (
              <p className='text-label text-muted-foreground'>
                保留原步骤身份、输出引用与成功条件；本次须恰好保留一个动作。模块内部步骤不在此处替换。
              </p>
            )}
          </div>
          {loading && (
            <p role='status' className='text-body text-muted-foreground'>
              正在生成预览…
            </p>
          )}
          {preview && (
            <>
              <p className='text-label text-muted-foreground'>
                {preview.suggestions.length} 项来源 · 已处理{' '}
                {preview.suggestions.length - pending} 项 · 尚需处理 {pending}{' '}
                项
              </p>
              <div className='space-y-4'>
                {groups.map((group) => {
                  const isExpanded = openGroups.includes(group.groupId)
                  const toggleExpand = () => {
                    setOpenGroups((prev) =>
                      prev.includes(group.groupId)
                        ? prev.filter((id) => id !== group.groupId)
                        : [...prev, group.groupId]
                    )
                  }

                  const groupItems = group.items
                  const canBatchAccept = groupItems.some(
                    ({ item }) =>
                      item.status === 'mapped' &&
                      choices[item.id]?.disposition !== 'accept'
                  )

                  const handleBatchAccept = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    setChoices((prev) => {
                      const next = { ...prev }
                      for (const { item } of groupItems) {
                        if (item.status === 'mapped') {
                          next[item.id] = { id: item.id, disposition: 'accept' }
                        }
                      }
                      return next
                    })
                    toast.success(`已整组采纳「${group.title}」`)
                  }

                  return (
                    <Collapsible
                      key={group.groupId}
                      open={isExpanded}
                      onOpenChange={toggleExpand}
                      className='rounded-lg border border-border-card bg-card overflow-hidden'
                    >
                      <div className='flex items-center justify-between p-3 bg-muted/20 border-b border-border/40'>
                        <CollapsibleTrigger asChild>
                          <button
                            type='button'
                            className='flex items-center gap-2 cursor-pointer select-none text-left flex-1 min-w-0 mr-2'
                          >
                            {isExpanded ? (
                              <ChevronDown className='h-4 w-4 text-muted-foreground shrink-0' />
                            ) : (
                              <ChevronRight className='h-4 w-4 text-muted-foreground shrink-0' />
                            )}
                            <span className='text-sm font-semibold truncate'>
                              {group.title}
                            </span>
                            <Badge variant='outline' className='text-[10px] font-mono shrink-0'>
                              {group.items.length} 个动作
                            </Badge>
                            <Badge
                              variant={
                                group.effectType === 'write'
                                  ? 'destructive'
                                  : group.effectType === 'idempotent_write'
                                    ? 'secondary'
                                    : 'outline'
                              }
                              className='text-[10px] shrink-0'
                            >
                              {group.effectType === 'write'
                                ? '副作用 (WRITE)'
                                : group.effectType === 'idempotent_write'
                                  ? '幂等 (IDEMPOTENT)'
                                  : '只读 (READ)'}
                            </Badge>
                          </button>
                        </CollapsibleTrigger>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          className='h-7 text-xs gap-1 shrink-0'
                          disabled={applying || !canBatchAccept}
                          onClick={handleBatchAccept}
                        >
                          <CheckCheck className='h-3.5 w-3.5' />
                          整组采纳
                        </Button>
                      </div>
                      <CollapsibleContent className='p-3'>
                        <ol className='space-y-3'>
                          {group.items.map(({ item, originalIndex }) => (
                            <li
                              key={item.id}
                              className='space-y-3 rounded-lg border border-border/60 bg-background/50 p-3.5'
                            >
                              <SuggestionEditor
                                item={item}
                                index={originalIndex}
                                choice={choices[item.id]}
                                inputs={props.inputs}
                                disabled={applying}
                                onChange={(next) =>
                                  setChoices((old) => ({
                                    ...old,
                                    [item.id]: next,
                                  }))
                                }
                              />
                            </li>
                          ))}
                        </ol>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            </>
          )}
          {recordingDraftId && (
            <details className='text-label'>
              <summary className='cursor-pointer py-3'>
                检查原始来源与前后观察
              </summary>
              <SavedDemonstrationFacts id={recordingDraftId} />
            </details>
          )}
          {error && (
            <p role='alert' className='text-body text-destructive'>
              {error}
            </p>
          )}
          {conflict && (
            <div className='space-y-2'>
              <p className='text-label'>
                你的决定和编辑仍保留。读取最新版本后重新检查回填位置。
              </p>
              <Button
                variant='outline'
                disabled={loading}
                onClick={() =>
                  void fetchScenario(scenarioId)
                    .then((next) =>
                      refresh(next.draft?.revision ?? baseline.current)
                    )
                    .catch((e) => setError(e.message))
                }
              >
                保留决定并重新预览
              </Button>
            </div>
          )}
          {error && !conflict && (
            <Button variant='outline' onClick={() => void refresh()}>
              重新生成预览
            </Button>
          )}
        </div>
        <SheetFooter>
          <Button
            variant='outline'
            disabled={applying}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button
            disabled={
              !preview ||
              pending > 0 ||
              kept === 0 ||
              loading ||
              applying ||
              conflict ||
              !props.canApply
            }
            loading={applying}
            onClick={() => void apply()}
          >
            {placement.kind === 'replace'
              ? '替换所选步骤'
              : `确认回填 ${kept} 项`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function SuggestionEditor({
  item,
  index,
  choice,
  inputs,
  disabled,
  onChange,
}: {
  item: DemonstrationSuggestion
  index: number
  choice?: Decision
  inputs: RecordingImportPanelProps['inputs']
  disabled: boolean
  onChange: (choice: Decision) => void
}) {
  const [param, setParam] = useState(item.parameter?.key ?? '')
  const [label, setLabel] = useState(item.parameter?.label ?? '')
  const editing = choice?.disposition === 'replace' ? choice.step : undefined
  function beginEdit() {
    const step =
      item.step ??
      createBlankStep(item.action === 'aiQuery' ? 'ai_extract' : 'ai_action')
    onChange({
      id: item.id,
      disposition: 'replace',
      step: { ...step, id: newDemonstrationId() },
    })
  }
  return (
    <>
      <div>
        <p className='text-body font-semibold'>
          {index + 1}. {item.outcome?.meaning || item.step?.name || item.action}
        </p>
        <p className='text-label text-muted-foreground'>
          {item.outcome
            ? '成功条件 · 必須满足 · 原位置执行'
            : item.status === 'observation'
              ? '仅观察 · 不作为业务动作执行'
              : item.status === 'mapped'
                ? '已生成可编辑步骤'
                : '无法自动转换，需要处理'}
        </p>
      </div>
      {item.step?.type === 'assert' &&
      item.step.input.expect.kind === 'aria_snapshot' ? (
        <div className='rounded border border-border/40 bg-muted/20 p-2 font-mono text-label'>
          <div className='mb-1 flex items-center justify-between text-muted-foreground'>
            <span>Aria 快照模板预览</span>
            <span className='rounded bg-primary/10 px-1.5 py-0.5 text-label text-primary'>已脱敏</span>
          </div>
          <pre className='max-h-36 overflow-auto whitespace-pre leading-relaxed text-foreground'>
            {item.step.input.expect.template}
          </pre>
        </div>
      ) : null}
      {item.diagnostics.map((message) => (
        <p key={message} className='text-label text-status-warning-foreground'>
          {message}
        </p>
      ))}
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant={choice?.disposition === 'accept' ? 'default' : 'outline'}
          disabled={disabled || item.status !== 'mapped'}
          onClick={() => onChange({ id: item.id, disposition: 'accept' })}
        >
          {item.outcome ? '确认为成功条件' : '接受'}
        </Button>
        {!item.outcome && item.status !== 'observation' && (
          <Button
            size='sm'
            variant={editing ? 'default' : 'outline'}
            disabled={disabled}
            onClick={beginEdit}
          >
            修正步骤
          </Button>
        )}
        <Button
          size='sm'
          disabled={disabled}
          variant={choice?.disposition === 'discard' ? 'default' : 'outline'}
          onClick={() =>
            onChange({ id: item.id, disposition: 'discard', reason: '' })
          }
        >
          舍弃
        </Button>
      </div>
      {choice?.disposition === 'discard' && (
        <div className='space-y-2'>
          <Label htmlFor={`discard-${item.id}`}>舍弃原因</Label>
          <Textarea
            id={`discard-${item.id}`}
            value={choice.reason}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ ...choice, reason: e.target.value })}
          />
        </div>
      )}
      {item.parameter && choice?.disposition === 'accept' && (
        <details>
          <summary className='cursor-pointer py-2 text-label'>
            将输入作为参数
            {choice.parameter ? ` · ${choice.parameter.key}` : '（可选）'}
          </summary>
          <div className='space-y-2'>
            <Label htmlFor={`param-${item.id}`}>参数键</Label>
            <Input
              id={`param-${item.id}`}
              value={param}
              onChange={(e) => setParam(e.target.value)}
            />
            <Label htmlFor={`param-label-${item.id}`}>参数名称</Label>
            <Input
              id={`param-label-${item.id}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button
              size='sm'
              variant='outline'
              disabled={!param || !label}
              onClick={() =>
                onChange({
                  ...choice,
                  parameter: inputs.find((i) => i.key === param) ?? {
                    key: param,
                    label,
                  },
                })
              }
            >
              确认参数绑定
            </Button>
            {choice.parameter && (
              <Button
                size='sm'
                variant='ghost'
                onClick={() => onChange({ id: item.id, disposition: 'accept' })}
              >
                恢复固定值
              </Button>
            )}
            <p className='text-label text-muted-foreground'>
              同名已有参数将复用声明；试跑时再填写参数值，不保存默认秘密值。
            </p>
          </div>
        </details>
      )}
      {editing && (
        <StepEditor
          step={editing}
          index={index}
          bindings={inputs.map((i) => ({ key: i.key, label: i.label }))}
          shapes={new Map()}
          editableTypes={editable}
          diagnostics={[]}
          disabled={disabled}
          onChange={(step) =>
            onChange({ id: item.id, disposition: 'replace', step })
          }
          onRequestTypeChange={(type) =>
            onChange({
              id: item.id,
              disposition: 'replace',
              step: { ...createBlankStep(type), id: editing.id },
            })
          }
        />
      )}
    </>
  )
}
