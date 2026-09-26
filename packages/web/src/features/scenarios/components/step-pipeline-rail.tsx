import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitFork,
  Layers,
  Link2,
  ListOrdered,
  Plus,
  Sparkles,
  Split,
} from 'lucide-react'
import {
  authoringHasControlBlocks,
  formatExpressionReadable,
  isAiStepType,
  isAuthoringDocumentV2,
  walkAuthoringNodes,
  type AuthoringBlockNode,
  type CompileDiagnostic,
  type ExecutableStepType,
  type ScenarioAuthoringDocument,
  type ScenarioDocument,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { stepTypeLabel } from '../labels'
import { StepTypeIcon } from '../step-type-icon'
import { outputConsumersAny } from '../studio-document'
import { STEP_TYPE_HINTS, unavailableStudioTypes } from '../step-registry'
import { STEP_SNIPPET_TEMPLATES } from '../snippets/step-snippets'
import type { StepLocatorHealth } from '../use-scenario-locator-health'

export interface StepPipelineRailProps {
  document?: ScenarioDocument | ScenarioAuthoringDocument | null
  selectedId: string | null
  selectedIndex?: number
  holdingDraftStepId?: string | null
  importedStepIds?: string[]
  compileDiagnostics?: CompileDiagnostic[]
  canWrite: boolean
  disabled: boolean
  nodeLimit?: number
  editableTypes: readonly ExecutableStepType[]
  fixtureTypes?: readonly ExecutableStepType[]
  actionModulesEnabled?: boolean
  supportsAuthoringV2?: boolean
  extractIds?: string[]
  pendingImportDraftId?: string | null
  canRecord?: boolean
  capabilitiesData?: any
  flowgram?: boolean
  locatorHealthMap?: Map<string, StepLocatorHealth>
  onToggleFlowgram?: (flowgram: boolean) => void
  onLocateStep?: (id: string) => void
  onSelect: (id: string) => void
  onAddStep: (type: ExecutableStepType) => void
  onAddBlock?: (name?: string) => void
  /** 把勾选的连续步骤包进一个新的条件块 */
  onWrapSelection?: () => void
  /** 解除块，把块内步骤放回原位置 */
  onUnwrapBlock?: (blockId: string) => void
  onAddProbeAndBlock?: () => void
  onAddSnippet?: (templateId: string) => void
  canExtract?: boolean
  onExtractIdsChange?: (updater: (ids: string[]) => string[]) => void
  onImportSearch?: (id: string) => void
  onInsertModuleOpen?: () => void
  onExtractOpen?: () => void
  onReplaceOpen?: () => void
  className?: string
}

export function StepPipelineRail({
  document,
  selectedId,
  selectedIndex,
  holdingDraftStepId,
  importedStepIds = [],
  compileDiagnostics = [],
  canWrite,
  disabled,
  nodeLimit = 100,
  editableTypes,
  fixtureTypes = [],
  actionModulesEnabled,
  supportsAuthoringV2,
  extractIds = [],
  pendingImportDraftId,
  canRecord,
  capabilitiesData,
  flowgram = false,
  locatorHealthMap,
  onToggleFlowgram,
  onLocateStep,
  onSelect,
  onAddStep,
  onAddBlock,
  onWrapSelection,
  onUnwrapBlock,
  onAddProbeAndBlock,
  onAddSnippet,
  canExtract,
  onExtractIdsChange,
  onImportSearch,
  onInsertModuleOpen,
  onExtractOpen,
  onReplaceOpen,
  className,
}: StepPipelineRailProps) {
  const stepListRef = useRef<HTMLOListElement>(null)
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set())

  const hasControlBlocks = Boolean(
    document && isAuthoringDocumentV2(document) && authoringHasControlBlocks(document)
  )

  const items = useMemo(() => {
    if (!document) return []
    if (!isAuthoringDocumentV2(document)) {
      return document.steps.map((step, index) => ({
        node: { kind: 'step' as const, step },
        id: step.id,
        displayNumber: String(index + 1).padStart(2, '0'),
        depth: 0,
        isFirstInBranch: false,
        branchKey: undefined as 'then' | 'else' | undefined,
        ancestry: [] as Array<{ blockId: string; branchKey: 'then' | 'else' }>,
      }))
    }

    const walked = walkAuthoringNodes(document)
    const numberMap = new Map<string, string>()
    let topOrdinal = 0

    return walked.map((entry) => {
      let displayNumber = ''
      if (entry.depth === 0) {
        topOrdinal++
        displayNumber = String(topOrdinal).padStart(2, '0')
        numberMap.set(entry.id, displayNumber)
      } else {
        const parentNum = entry.parentId ? numberMap.get(entry.parentId) ?? '00' : '00'
        if (entry.branchKey === 'then') {
          displayNumber = `${parentNum}.${entry.index + 1}`
        } else {
          displayNumber = `${parentNum}.E${entry.index + 1}`
        }
        numberMap.set(entry.id, displayNumber)
      }

      return {
        ...entry,
        displayNumber,
        isFirstInBranch: Boolean(entry.branchKey && entry.index === 0),
      }
    })
  }, [document])

  const blockDescendantIds = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const item of items) {
      for (const anc of item.ancestry) {
        if (!map.has(anc.blockId)) map.set(anc.blockId, new Set())
        map.get(anc.blockId)!.add(item.id)
      }
    }
    return map
  }, [items])

  const visibleItems = useMemo(() => {
    return items.filter((item) => {
      if (item.ancestry.length === 0) return true
      return !item.ancestry.some((anc) => collapsedBlocks.has(anc.blockId))
    })
  }, [items, collapsedBlocks])

  const nodeCount = items.length

  useEffect(() => {
    if (selectedId) {
      const selected = stepListRef.current?.querySelector('[aria-pressed="true"]')
      if (selected?.getClientRects().length) selected.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedId])

  return (
    <section
      aria-label='步骤管线'
      data-testid='step-pipeline-rail'
      className={cn('flex flex-1 min-h-0 flex-col overflow-hidden bg-card', className)}
    >
      {/* 顶栏：标题与添加步骤 */}
      <div className='flex items-center justify-between gap-1.5 border-b border-border-divider px-3 py-2 shrink-0 bg-surface-header'>
        <h2 className='flex shrink-0 items-center gap-1.5 text-body font-semibold text-foreground'>
          <ListOrdered className='size-4 text-primary' />
          <span>步骤管线</span>
          <span className='font-mono text-label text-muted-foreground font-normal'>
            ({nodeCount})
          </span>
        </h2>
        {canWrite ? (
          <div className='flex items-center gap-1 shrink-0'>
            <DropdownMenu>
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
              <DropdownMenuContent align='end' className='w-48'>
                <DropdownMenuLabel>基础操作</DropdownMenuLabel>
                {editableTypes
                  .filter((type) => ['navigate', 'click', 'fill', 'select'].includes(type))
                  .map((type) => (
                    <DropdownMenuItem
                      key={type}
                      className='flex items-center gap-2'
                      onClick={() => onAddStep(type)}
                    >
                      <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                      <span>{stepTypeLabel(type)}</span>
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>辅助与提取</DropdownMenuLabel>
                {editableTypes
                  .filter((type) => ['keyboard', 'wait', 'extract'].includes(type))
                  .map((type) => (
                    <DropdownMenuItem
                      key={type}
                      className='flex items-center gap-2'
                      onClick={() => onAddStep(type)}
                    >
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
                        <DropdownMenuItem
                          key={type}
                          className='flex items-center gap-2'
                          onClick={() => onAddStep(type)}
                        >
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
                        <DropdownMenuItem
                          key={type}
                          className='flex items-center gap-2 text-ai-foreground'
                          onClick={() => onAddStep(type)}
                        >
                          <StepTypeIcon type={type} className='size-3.5 text-ai-foreground' />
                          <span>{stepTypeLabel(type)}</span>
                        </DropdownMenuItem>
                      ))}
                  </>
                ) : null}
                {unavailableStudioTypes(capabilitiesData)
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
                          <DropdownMenuItem
                            key={type}
                            className='flex items-center gap-2'
                            onClick={() => onAddStep(type)}
                          >
                            <StepTypeIcon type={type} className='size-3.5 text-muted-foreground' />
                            <span>{stepTypeLabel(type)}</span>
                            <span className='text-label text-muted-foreground'> · {STEP_TYPE_HINTS[type]}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
                {supportsAuthoringV2 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className='flex items-center gap-2'>
                        <GitFork className='size-3.5 text-primary' />
                        <span>流程控制</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className='w-60'>
                        {onAddBlock && (
                          <DropdownMenuItem
                            className='flex items-center gap-2 cursor-pointer'
                            onClick={() => onAddBlock()}
                          >
                            <GitFork className='size-3.5 text-primary shrink-0' />
                            <div>
                              <div className='font-medium text-small'>满足条件时执行 (If-Else)</div>
                              <div className='text-2xs text-muted-foreground'>条件分支判断与多路径执行</div>
                            </div>
                          </DropdownMenuItem>
                        )}
                        {onAddProbeAndBlock && (
                          <DropdownMenuItem
                            className='flex items-center gap-2 cursor-pointer'
                            onClick={() => onAddProbeAndBlock()}
                          >
                            <Split className='size-3.5 text-primary shrink-0' />
                            <div>
                              <div className='font-medium text-small'>出现就处理 (Probe + If)</div>
                              <div className='text-2xs text-muted-foreground'>检查页面后就地分支处理</div>
                            </div>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className='flex items-center gap-2 cursor-pointer'
                          onClick={() => onAddStep('probe')}
                        >
                          <StepTypeIcon type='probe' className='size-3.5 text-muted-foreground shrink-0' />
                          <div>
                            <div className='font-medium text-small'>页面检查 (Probe)</div>
                            <div className='text-2xs text-muted-foreground'>检查元素、文本或 URL 存在性</div>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className='flex items-center gap-2 cursor-pointer'
                          onClick={() => onAddStep('compute')}
                        >
                          <StepTypeIcon type='compute' className='size-3.5 text-muted-foreground shrink-0' />
                          <div>
                            <div className='font-medium text-small'>计算值 (Compute)</div>
                            <div className='text-2xs text-muted-foreground'>表达式计算、文本截取或数字转换</div>
                          </div>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
                {actionModulesEnabled && supportsAuthoringV2 && onInsertModuleOpen && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className='flex items-center gap-2' onClick={onInsertModuleOpen}>
                      <Layers className='size-3.5 text-primary' />
                      <span>调用动作模块…</span>
                    </DropdownMenuItem>
                  </>
                )}
                {onAddSnippet && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className='flex items-center gap-2'>
                        <Sparkles className='size-3.5 text-primary' />
                        <span>常用业务模版…</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className='w-56'>
                        {STEP_SNIPPET_TEMPLATES.map((tmpl) => (
                          <DropdownMenuItem
                            key={tmpl.id}
                            className='flex flex-col items-start gap-0.5'
                            onClick={() => onAddSnippet(tmpl.id)}
                          >
                            <span className='font-medium text-small'>{tmpl.name}</span>
                            <span className='text-2xs text-muted-foreground'>{tmpl.description}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {canExtract ? (
              <>
                {onExtractOpen && (
                  <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onExtractOpen}>
                    提炼模块
                  </Button>
                )}
                {onReplaceOpen && (
                  <Button size='sm' variant='outline' className='h-7 px-2 text-label' onClick={onReplaceOpen}>
                    替换模块
                  </Button>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 视图切换与步骤定位次级栏 */}
      {(onToggleFlowgram || onLocateStep) && (
        <div className='flex flex-wrap items-center gap-1.5 border-b border-border-divider px-3 py-1.5 shrink-0 bg-surface-header'>
          {onToggleFlowgram && (
            <div role='group' aria-label='步骤视图' className='flex gap-1'>
              <Button
                size='sm'
                variant={!flowgram ? 'secondary' : 'ghost'}
                className='h-7 px-2 text-label'
                aria-pressed={!flowgram}
                onClick={() => onToggleFlowgram(false)}
              >
                管线
              </Button>
              <Button
                size='sm'
                variant={flowgram ? 'secondary' : 'ghost'}
                className='h-7 px-2 text-label'
                aria-pressed={flowgram}
                disabled={hasControlBlocks}
                title={hasControlBlocks ? '含流程控制块的场景暂只支持列表视图' : undefined}
                onClick={() => {
                  if (!hasControlBlocks) onToggleFlowgram?.(true)
                }}
              >
                画布
              </Button>
            </div>
          )}
          {onLocateStep && (
            <div className='flex min-w-0 flex-1 basis-36 items-center gap-0.5'>
              <Button
                size='icon'
                variant='ghost'
                className='size-7 shrink-0'
                aria-label='定位上一步'
                title='定位上一步'
                disabled={selectedIndex === undefined || selectedIndex <= 0}
                onClick={() => {
                  if (selectedIndex !== undefined && selectedIndex > 0) {
                    const prev = items[selectedIndex - 1]
                    if (prev) onLocateStep(prev.id)
                  }
                }}
              >
                <ArrowLeft className='size-3.5' />
              </Button>
              <Select value={selectedId ?? ''} onValueChange={onLocateStep}>
                <SelectTrigger aria-label='定位步骤' className='h-7 min-w-0 flex-1 text-label'>
                  <SelectValue placeholder='定位步骤' />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.displayNumber} ·{' '}
                      {item.node.kind === 'module'
                        ? item.node.name || '动作模块'
                        : item.node.kind === 'block'
                          ? item.node.name || '条件分支'
                          : item.node.step.name}
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
                disabled={selectedIndex === undefined || selectedIndex >= nodeCount - 1}
                onClick={() => {
                  if (selectedIndex !== undefined && selectedIndex < items.length - 1) {
                    const next = items[selectedIndex + 1]
                    if (next) onLocateStep(next.id)
                  }
                }}
              >
                <ArrowRight className='size-3.5' />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 提炼模块批处理工具栏（若勾选） */}
      {supportsAuthoringV2 && extractIds.length > 0 && (onWrapSelection || (actionModulesEnabled && onExtractOpen)) && (
        <div className='flex items-center justify-between gap-2 border-b border-border-divider bg-primary/5 px-3 py-1.5 text-label'>
          <span>已选 {extractIds.length} 个步骤</span>
          <div className='flex items-center gap-1.5'>
            {onWrapSelection && canWrite ? (
              <Button size='sm' variant='outline' className='h-6 px-2 text-label' onClick={onWrapSelection}>
                包裹为条件块
              </Button>
            ) : null}
            {actionModulesEnabled && onExtractOpen ? (
              <Button size='sm' className='h-6 px-2 text-label' onClick={onExtractOpen}>
                提炼为模块
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {/* 步骤列表或空态 */}
      {nodeCount === 0 ? (
        <div className='flex-1 p-3.5 flex flex-col items-center justify-center text-center space-y-3.5 bg-muted/5 overflow-y-auto'>
          <div className='size-10 rounded-full bg-primary/10 flex items-center justify-center text-primary text-title'>
            ⚡
          </div>
          <div className='space-y-1 max-w-[200px]'>
            <h3 className='text-body font-semibold text-foreground'>开始构建场景</h3>
            <p className='text-label text-muted-foreground leading-relaxed'>
              {pendingImportDraftId
                ? '已检测到录制草稿，推荐一键转为操作步骤：'
                : '你可以导入录制草稿，或添加首个步骤：'}
            </p>
          </div>
          {pendingImportDraftId && canRecord && onImportSearch ? (
            <Button
              size='sm'
              variant='default'
              className='w-full text-label font-medium shadow-xs'
              onClick={() => onImportSearch(pendingImportDraftId)}
            >
              ⚡ 预览并导入录制草稿
            </Button>
          ) : null}
          <div className='flex flex-col gap-1.5 w-full pt-1'>
            <Button
              size='sm'
              variant='outline'
              className='w-full text-label justify-start text-muted-foreground hover:text-foreground'
              onClick={() => onAddStep('navigate')}
              disabled={disabled}
            >
              <Plus className='size-3.5 mr-1.5 text-primary' />
              第 1 步：打开页面 (导航)
            </Button>
            <Button
              size='sm'
              variant='outline'
              className='w-full text-label justify-start text-muted-foreground hover:text-foreground'
              onClick={() => onAddStep('ai_action')}
              disabled={disabled}
            >
              <Plus className='size-3.5 mr-1.5 text-ai-foreground' />
              第 1 步：视觉操作
            </Button>
          </div>
        </div>
      ) : (
        <ol
          ref={stepListRef}
          aria-label='有序步骤列表'
          className='relative flex-1 min-h-0 space-y-2 overflow-y-auto p-2.5'
        >
          {visibleItems.map((item, index) => {
            const key = item.id
            const isSelected = selectedId === key
            const isLast = index === visibleItems.length - 1
            const isModule = item.node.kind === 'module'
            const isBlock = item.node.kind === 'block'

            const depthClass =
              item.depth === 1 ? 'ml-4' : item.depth >= 2 ? 'ml-7' : ''

            const branchDivider = item.isFirstInBranch ? (
              <div
                key={`branch-divider-${key}`}
                className={cn(
                  'flex items-center gap-1.5 py-1 text-3xs font-medium',
                  item.depth === 1 ? 'ml-4' : 'ml-7',
                  item.branchKey === 'then'
                    ? 'text-status-success-foreground'
                    : 'text-status-warning-foreground border-t border-dashed border-border-divider mt-1 pt-1.5',
                )}
              >
                {item.branchKey === 'then' ? (
                  <>
                    <CheckCircle2 className='size-3 shrink-0 text-status-success-foreground' />
                    <span>满足条件时执行 (then)</span>
                  </>
                ) : (
                  <>
                    <Split className='size-3 shrink-0 text-status-warning-foreground' />
                    <span>否则执行 (else)</span>
                  </>
                )}
              </div>
            ) : null

            if (isBlock) {
              const blockNode = item.node as AuthoringBlockNode
              const isCollapsed = collapsedBlocks.has(key)
              const descendantSet = blockDescendantIds.get(key) ?? new Set()
              const blockDiagnostics = compileDiagnostics.filter(
                (d) => d.stepId === key || (d.stepId ? descendantSet.has(d.stepId) : false),
              )
              const errorCount = blockDiagnostics.filter((d) => d.severity === 'error').length
              const warningCount = blockDiagnostics.filter((d) => d.severity === 'warning').length
              const condSummary =
                blockNode.control.type === 'if'
                  ? formatExpressionReadable(blockNode.control.condition)
                  : blockNode.control.type === 'repeat'
                    ? formatExpressionReadable(blockNode.control.until)
                    : `${blockNode.control.as} in ${blockNode.control.over.from}${blockNode.control.over.fromField ? '.' + blockNode.control.over.fromField : ''}`
              const isDisabled = Boolean(blockNode.disabled)

              return (
                <div key={key} className='space-y-1'>
                  {branchDivider}
                  <li
                    data-list-step={key}
                    className={cn(
                      'relative flex min-w-0 items-start gap-2 pl-1',
                      depthClass,
                      'before:absolute before:left-[19px] before:top-3 before:w-0.5 before:bg-border-divider',
                      isLast ? 'before:h-3' : 'before:bottom-0',
                    )}
                  >
                    <span
                      className={cn(
                        'relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border text-3xs font-mono font-medium transition-colors mt-2',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground shadow-control-focus'
                          : 'border-primary/40 bg-primary/5 text-primary',
                      )}
                    >
                      {item.displayNumber}
                    </span>

                    <div
                      role='button'
                      tabIndex={0}
                      aria-pressed={isSelected}
                      onClick={() => onSelect(key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(key)
                        }
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 flex-col rounded-lg border p-2 text-left transition-colors cursor-pointer',
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-control-focus'
                          : isDisabled
                            ? 'border-dashed border-border-default bg-muted/20 opacity-60 hover:opacity-80'
                            : 'border-border-card bg-card hover:bg-primary/5',
                      )}
                    >
                      <div className='flex items-center justify-between gap-1.5 min-w-0'>
                        <div className='flex items-center gap-1.5 min-w-0 flex-1'>
                          <button
                            type='button'
                            className='size-4 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0 -ml-0.5'
                            title={isCollapsed ? '展开分支步骤' : '折叠分支步骤'}
                            onClick={(e) => {
                              e.stopPropagation()
                              setCollapsedBlocks((prev) => {
                                const next = new Set(prev)
                                if (next.has(key)) next.delete(key)
                                else next.add(key)
                                return next
                              })
                            }}
                          >
                            {isCollapsed ? <ChevronRight className='size-3.5' /> : <ChevronDown className='size-3.5' />}
                          </button>
                          <GitFork className='size-3.5 text-primary shrink-0' />
                          <span className='truncate text-body font-medium text-foreground leading-tight'>
                            {blockNode.name || (blockNode.control.type === 'if' ? '满足条件时执行' : blockNode.control.type === 'for_each' ? '逐项处理' : '重复执行')}
                          </span>
                        </div>

                        {onUnwrapBlock && canWrite && !disabled ? (
                          <button
                            type='button'
                            className='shrink-0 rounded px-1 text-2xs text-muted-foreground hover:text-foreground'
                            title='解除包裹：把块内步骤放回原位置'
                            onClick={(e) => {
                              e.stopPropagation()
                              onUnwrapBlock(key)
                            }}
                          >
                            解除包裹
                          </button>
                        ) : null}
                        {errorCount > 0 ? (
                          <span
                            className='size-2 rounded-full bg-status-error shrink-0'
                            title={`${errorCount} 项错误（含子步骤）`}
                          />
                        ) : warningCount > 0 ? (
                          <span
                            className='size-2 rounded-full bg-status-warning shrink-0'
                            title={`${warningCount} 项提醒（含子步骤）`}
                          />
                        ) : (
                          <ChevronRight className='size-3 text-muted-foreground/60 shrink-0' />
                        )}
                      </div>

                      <div className='mt-1 flex flex-wrap items-center gap-1.5 text-label'>
                        {isDisabled && <StatusBadge tone='neutral'>已跳过</StatusBadge>}
                        <span
                          className='rounded bg-primary/10 px-1.5 py-0.5 text-3xs font-mono font-medium text-primary truncate max-w-[170px]'
                          title={condSummary}
                        >
                          {blockNode.control.type === 'if'
                            ? `if ${condSummary}`
                            : blockNode.control.type === 'repeat'
                              ? `until ${condSummary}`
                              : `for ${condSummary}`}
                        </span>
                        <span className='text-2xs text-muted-foreground'>
                          {'then' in blockNode
                            ? `${blockNode.then.length} 步${blockNode.else ? ` · 否则 ${blockNode.else.length} 步` : ''}`
                            : `${blockNode.body.length} 步`}
                          {isCollapsed ? ' (已折叠)' : ''}
                        </span>
                      </div>
                    </div>
                  </li>
                </div>
              )
            }

            const nodeDiagnostics = compileDiagnostics.filter((d) => d.stepId === key)
            const errorCount = nodeDiagnostics.filter((d) => d.severity === 'error').length
            const warningCount = nodeDiagnostics.filter((d) => d.severity === 'warning').length

            const step = item.node.kind === 'step' ? item.node.step : null
            const moduleNode = item.node.kind === 'module' ? item.node : null
            const imported = Boolean(step && importedStepIds.includes(step.id))
            const isHolding = Boolean(step && holdingDraftStepId === step.id)
            const isDisabled = moduleNode
              ? Boolean(moduleNode.disabled)
              : Boolean(step?.disabled)
            const isOptional = Boolean(step?.optional)
            const outputKey = step?.outputKey
            const listOutput = Boolean(
              step &&
              ((step.type === 'extract' && Boolean(step.input.many)) ||
                (step.type === 'ai_extract' &&
                  step.input.outputSchema.kind === 'list'))
            )
            const consumers = outputKey && document ? outputConsumersAny(document, outputKey) : []

            return (
              <div key={key} className='space-y-1'>
                {branchDivider}
                <li
                  data-list-step={key}
                  className={cn(
                    'relative flex min-w-0 items-start gap-2 pl-1',
                    depthClass,
                    'before:absolute before:left-[19px] before:top-3 before:w-0.5 before:bg-border-divider',
                    isLast ? 'before:h-3' : 'before:bottom-0',
                  )}
                >
                  {(actionModulesEnabled || (onWrapSelection && canWrite)) &&
                    supportsAuthoringV2 &&
                    document &&
                    isAuthoringDocumentV2(document) &&
                    step &&
                    onExtractIdsChange && (
                      <Checkbox
                        aria-label={`选择提炼 ${step.name}`}
                        checked={extractIds.includes(step.id)}
                        className='mt-2.5'
                        onCheckedChange={(val) => {
                          const id = step.id
                          onExtractIdsChange((cur) =>
                            val === true ? [...cur, id] : cur.filter((i) => i !== id),
                          )
                        }}
                      />
                    )}

                  <span
                    className={cn(
                      'relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border text-3xs font-mono font-medium transition-colors mt-2',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground shadow-control-focus'
                        : isHolding
                          ? 'border-status-warning bg-status-warning text-white'
                          : isDisabled
                            ? 'border-dashed border-border-default bg-muted/40 text-muted-foreground/60'
                            : 'border-border-default bg-surface-subtle text-muted-foreground',
                    )}
                  >
                    {item.displayNumber}
                  </span>

                  <button
                    type='button'
                    aria-pressed={isSelected}
                    onClick={() => onSelect(key)}
                    className={cn(
                      'flex min-w-0 flex-1 flex-col rounded-lg border p-2 text-left transition-colors',
                      isSelected
                        ? 'border-selection-border bg-selection-background shadow-control-focus'
                        : isDisabled
                          ? 'border-dashed border-border-default bg-muted/20 opacity-60 hover:opacity-80'
                          : 'border-border-default bg-card hover:bg-action-hover',
                    )}
                  >
                    <div className='flex items-center justify-between gap-1.5 min-w-0'>
                      <div className='flex items-center gap-1.5 min-w-0 flex-1'>
                        {isModule ? (
                          <Layers className='size-3.5 text-primary shrink-0' />
                        ) : step ? (
                          <StepTypeIcon
                            type={step.type}
                            className={cn(
                              'size-3.5 shrink-0',
                              isAiStepType(step.type)
                                ? 'text-ai-foreground'
                                : 'text-muted-foreground',
                            )}
                          />
                        ) : null}
                        <span className='truncate text-body font-medium text-foreground leading-tight'>
                          {moduleNode ? moduleNode.name || '动作模块' : step?.name}
                        </span>
                      </div>

                      {errorCount > 0 ? (
                        <span
                          className='size-2 rounded-full bg-status-error shrink-0'
                          title={`${errorCount} 项错误`}
                        />
                      ) : warningCount > 0 ? (
                        <span
                          className='size-2 rounded-full bg-status-warning shrink-0'
                          title={`${warningCount} 项提醒`}
                        />
                      ) : (
                        <ChevronRight className='size-3 text-muted-foreground/60 shrink-0' />
                      )}
                    </div>

                    <div className='mt-1 flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
                      {isDisabled && <StatusBadge tone='neutral'>已跳过</StatusBadge>}
                      {isHolding && <StatusBadge tone='warning'>挂起</StatusBadge>}
                      {imported && <StatusBadge tone='info'>刚导入</StatusBadge>}
                      {step && locatorHealthMap?.get(step.id) && (
                        <div
                          data-testid={`step-locator-health-${step.id}`}
                          className='inline-flex items-center gap-1'
                        >
                          {locatorHealthMap.get(step.id)?.activeCandidate ? (
                            <span
                              className='inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1 py-0.2 text-3xs font-medium'
                              title='AI 已自动反向生成全新确定性定位规则，可点击前往采纳'
                            >
                              <Sparkles className='size-2.5' />
                              <span>自愈就绪 ({Math.round((locatorHealthMap.get(step.id)?.ruleHitRate ?? 0) * 100)}%)</span>
                            </span>
                          ) : locatorHealthMap.get(step.id)?.status === 'fallback_warning' ? (
                            <span
                              className='rounded bg-status-warning-background text-status-warning-foreground px-1 py-0.2 text-3xs font-medium'
                              title={`原有选择器已衰减！近期规则命中率 ${Math.round((locatorHealthMap.get(step.id)?.ruleHitRate ?? 0) * 100)}% · 曾靠 AI 兜底挽回 ${locatorHealthMap.get(step.id)?.ai} 次`}
                            >
                              ⚠️ 需维护 ({Math.round((locatorHealthMap.get(step.id)?.ruleHitRate ?? 0) * 100)}%)
                            </span>
                          ) : locatorHealthMap.get(step.id)?.status === 'failing' ? (
                            <span
                              className='rounded bg-status-error-background text-status-error-foreground px-1 py-0.2 text-3xs font-medium'
                              title={`目标未能定位，近期定位失败 ${locatorHealthMap.get(step.id)?.failed} 次`}
                            >
                              ❌ 定位失败
                            </span>
                          ) : null}
                        </div>
                      )}
                      {isOptional && (
                        <span className='rounded bg-status-info-background text-status-info-foreground px-1 py-0.5 text-3xs font-medium'>
                          可选
                        </span>
                      )}
                      {step && 'origin' in item.node && item.node.origin?.kind === 'ai_solidification' && (
                        <span
                          className='inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 px-1 py-0.2 text-3xs font-medium'
                          title={`固化自 Attempt: ${item.node.origin.attemptId}\n原指令: ${item.node.origin.instruction}`}
                        >
                          <Sparkles className='size-2.5 text-amber-600 dark:text-amber-400' />
                          <span>固化</span>
                        </span>
                      )}
                      {isModule ? (
                        <StatusBadge tone='neutral'>动作模块</StatusBadge>
                      ) : step && isAiStepType(step.type) ? (
                        <span className='rounded bg-ai-light px-1 py-0.2 text-3xs font-medium text-ai-foreground'>
                          {stepTypeLabel(step.type)}
                        </span>
                      ) : step ? (
                        <span className='text-2xs text-muted-foreground'>
                          {stepTypeLabel(step.type)}
                        </span>
                      ) : null}

                      {step?.outputKey && (
                        <span className='font-mono text-3xs text-muted-foreground/90 truncate max-w-[120px]'>
                          {listOutput ? `→ ${step.outputKey}（列表）` : `输出 ${step.outputKey}`}
                        </span>
                      )}

                      {consumers.length > 0 && (
                        <span
                          className='inline-flex items-center gap-1 rounded bg-primary/10 px-1 py-0.2 text-3xs text-primary font-medium'
                          title={`已被后续 ${consumers.length} 处步骤引用`}
                        >
                          <Link2 className='size-2.5 text-primary' />
                          <span>引用 ({consumers.length})</span>
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              </div>
            )
          })}
        </ol>
      )}

      {/* 底部提示 */}
      <div className='border-t border-border-divider bg-surface-header px-3 py-1.5 text-label text-muted-foreground shrink-0'>
        {selectedId ? '新步骤插入在选定项之后' : '新步骤追加在流程末尾'}
      </div>
    </section>
  )
}
