import {
  Component,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  isAiStepType,
  isAuthoringDocumentV2,
  MAX_AUTHORING_NODES,
  MAX_SCENARIO_STEPS,
  type CompileDiagnostic,
  type RunDetailDto,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDocument,
} from '@cairn/shared'
import {
  EditorRenderer,
  FlowLayoutDefault,
  FlowRendererKey,
  FlowTransitionLineEnum,
  type FlowNodeEntity,
  FixedLayoutEditorProvider,
  useNodeRender,
  type FixedLayoutPluginContext,
  type FixedLayoutProps,
  type FlowDocumentJSON,
} from '@flowgram.ai/fixed-layout-editor'
import '@flowgram.ai/fixed-layout-editor/index.css'
import { Expand, GripVertical, Layers, Minus, Plus, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import {
  STEP_RUN_STATUS_LABELS,
  stepRunStatusTone,
} from '@/features/runs/labels'
import { STEP_TYPE_HINTS, stepTypeLabel } from '../step-registry'
import {
  authoringNodeLabel,
  authoringNodes,
  documentNodeCount,
  firstAuthoringNodeId,
  nodeId,
} from '../studio-document'
import { applyFlowgramOrder, toFlowgram } from './adapter'
import './canvas.css'
import {
  snakeColumns,
  snakePort,
  snakePosition,
  SNAKE_NODE_HEIGHT,
  SNAKE_NODE_WIDTH,
} from './snake-layout'

type StudioDocument = ScenarioDocument | ScenarioAuthoringDocumentV2

type CanvasProps = {
  document: StudioDocument
  layout: 'vertical' | 'snake'
  onLayoutChange: (layout: 'vertical' | 'snake') => void
  selectedId: string | null
  navigation?: { id: string; sequence: number } | null
  disabled: boolean
  trialRun?: RunDetailDto
  diagnostics: readonly CompileDiagnostic[]
  onSelect: (id: string) => void
  onInsertAfter: (id: string) => void
  onReorder: (document: StudioDocument, selectedId: string | null) => void
}

function canvasLimit(document: StudioDocument): number {
  return isAuthoringDocumentV2(document) ? MAX_AUTHORING_NODES : MAX_SCENARIO_STEPS
}

function canvasNodeIds(document: StudioDocument): string[] {
  return authoringNodes(document).map(nodeId)
}

function canvasNodeName(document: StudioDocument, id: string | undefined): string | undefined {
  if (!id) return undefined
  const node = authoringNodes(document).find((item) => nodeId(item) === id)
  return node ? authoringNodeLabel(node) : undefined
}
const CanvasContext = createContext<
  (CanvasProps & { compact: boolean }) | null
>(null)

function StepNode() {
  const model = useContext(CanvasContext)!
  const { id, node, startDrag, onMouseEnter, onMouseLeave, dragging } =
    useNodeRender()
  useLayoutEffect(() => {
    const renderData = node.renderData
    // FlowGram 1.0.15 leaves this delayed hover update alive after disposal.
    // Switching views while hovering a node must not touch its removed parent.
    return () => clearTimeout(renderData.mouseLeaveTimeout)
  }, [node])
  const nodes = authoringNodes(model.document)
  const current = nodes.find((item) => nodeId(item) === id)
  if (!current) return null
  const index = nodes.findIndex((item) => nodeId(item) === id)
  const label = authoringNodeLabel(current)
  const errors = model.diagnostics.filter(
    (item) => item.stepId === id && item.severity === 'error'
  )
  const moduleEntry = model.trialRun?.snapshot.moduleManifest?.entries.find(
    (entry) => entry.invocationId === id
  )
  const moduleRuns = moduleEntry
    ? model.trialRun?.stepRuns.filter((item) =>
        moduleEntry.expandedStepIds.includes(item.stepId)
      ) ?? []
    : []
  const moduleFailed = moduleRuns.some((item) => item.status === 'FAILED')
  const moduleSucceeded =
    moduleRuns.length > 0 && moduleRuns.every((item) => item.status === 'SUCCEEDED')
  if (current.kind === 'module') {
    const boundCount = Object.keys(current.inputBindings).length
    const exposedCount = Object.values(current.outputBindings).filter(Boolean).length
    return (
      <div
        data-flow-step={id}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className={cn(
          'flowgram-step is-module',
          model.selectedId === id && 'is-selected',
          dragging && 'is-dragging'
        )}
      >
        <button
          type='button'
          className='flowgram-drag'
          aria-label={`拖动模块 ${index + 1} ${label}`}
          title='拖动重排；也可使用属性面板中的上移和下移'
          disabled={model.disabled}
          onMouseDown={(event) => {
            if (model.disabled || event.button !== 0) return
            event.stopPropagation()
            model.onSelect(id)
            startDrag(event)
          }}
        >
          <GripVertical className='size-4' />
        </button>
        <button
          type='button'
          className='flowgram-step-body'
          aria-label={`模块 ${index + 1} ${label}`}
          aria-pressed={model.selectedId === id}
          onClick={() => model.onSelect(id)}
        >
          <span className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
            <span className='font-mono'>{String(index + 1).padStart(2, '0')}</span>
            <StatusBadge tone='neutral' hideIcon={model.compact}>
              <span className='inline-flex items-center gap-1'>
                <Layers className='size-3' />
                动作模块
              </span>
            </StatusBadge>
            {errors.length > 0 ? (
              <StatusBadge tone='error' hideIcon={model.compact}>
                {model.compact ? '字段异常' : '引用 / 字段异常'}
              </StatusBadge>
            ) : moduleFailed ? (
              <StatusBadge tone='error' hideIcon={model.compact}>
                试跑失败
              </StatusBadge>
            ) : moduleSucceeded ? (
              <StatusBadge tone='success' hideIcon={model.compact}>
                试跑成功
              </StatusBadge>
            ) : null}
          </span>
          <span className='flowgram-step-name mt-2 block break-words text-body font-semibold' title={label}>
            {label}
          </span>
          <span className='flowgram-step-hint mt-1 block break-words text-label text-muted-foreground'>
            {boundCount} 个输入绑定 · 暴露 {exposedCount} 个输出
          </span>
        </button>
      </div>
    )
  }
  const step = current.step
  const historic = model.trialRun?.snapshot.steps.find((item) => item.id === id)
  const result = model.trialRun?.stepRuns.find((item) => item.stepId === id)
  const matchesSnapshot =
    historic && JSON.stringify(historic) === JSON.stringify(step)
  const source =
    'from' in step.input && step.input.from ? String(step.input.from) : null
  const field =
    'fromField' in step.input && step.input.fromField
      ? `.${step.input.fromField}`
      : ''
  return (
    <div
      data-flow-step={id}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        'flowgram-step',
        model.selectedId === id && 'is-selected',
        dragging && 'is-dragging'
      )}
    >
      <button
        type='button'
        className='flowgram-drag'
        aria-label={`拖动步骤 ${index + 1} ${step.name}`}
        title='拖动重排；也可使用属性面板中的上移和下移'
        disabled={model.disabled}
        onMouseDown={(event) => {
          if (model.disabled || event.button !== 0) return
          event.stopPropagation()
          model.onSelect(id)
          startDrag(event)
        }}
      >
        <GripVertical className='size-4' />
      </button>
      <button
        type='button'
        className='flowgram-step-body'
        aria-label={`步骤 ${index + 1} ${step.name}`}
        aria-pressed={model.selectedId === id}
        onClick={() => model.onSelect(id)}
      >
        <span className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
          <span className='font-mono'>
            {String(index + 1).padStart(2, '0')}
          </span>
          <StatusBadge
            tone={isAiStepType(step.type) ? 'ai' : 'neutral'}
            hideIcon={model.compact}
          >
            {stepTypeLabel(step.type)}
          </StatusBadge>
          {errors.length > 0 ? (
            <span title='引用 / 字段异常'>
              <StatusBadge tone='error' hideIcon={model.compact}>
                {model.compact ? '字段异常' : '引用 / 字段异常'}
              </StatusBadge>
            </span>
          ) : result && matchesSnapshot ? (
            <StatusBadge
              tone={stepRunStatusTone(result.status)}
              hideIcon={model.compact}
            >
              试跑 {STEP_RUN_STATUS_LABELS[result.status]}
            </StatusBadge>
          ) : result ? (
            <span>草稿已修改</span>
          ) : null}
        </span>
        <span
          className='flowgram-step-name mt-2 block text-body font-semibold break-words'
          title={step.name}
        >
          {step.name}
        </span>
        <span
          className='flowgram-step-hint mt-1 block text-label break-words text-muted-foreground'
          title={
            source
              ? `读取 ${source}${field}`
              : step.outputKey
                ? `输出 ${step.outputKey}`
                : STEP_TYPE_HINTS[step.type]
          }
        >
          {source
            ? `读取 ${source}${field}`
            : step.outputKey
              ? `输出 ${step.outputKey}`
              : STEP_TYPE_HINTS[step.type]}
        </span>
      </button>
    </div>
  )
}

function InsertPoint({ from }: { from: FlowNodeEntity }) {
  const model = useContext(CanvasContext)!
  return (
    <button
      type='button'
      className='flowgram-insert'
      disabled={
        model.disabled || documentNodeCount(model.document) >= canvasLimit(model.document)
      }
      aria-label={`在${canvasNodeName(model.document, from.id) ?? '此处'}后插入步骤`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => model.onInsertAfter(from.id)}
    >
      <Plus className='size-3' />
    </button>
  )
}
function DragPreview({ dragStart }: { dragStart?: FlowNodeEntity }) {
  const model = useContext(CanvasContext)!
  return (
    <div className={cn('flowgram-drag-preview', model.compact && 'is-compact')}>
      {canvasNodeName(model.document, dragStart?.id) ?? '移动步骤'}
    </div>
  )
}
function DropTarget() {
  return <div className='flowgram-drop-target' />
}
function DropHighlight() {
  return <div className='flowgram-drop-highlight' />
}

function SequenceArrow({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={id}
        data-sequence-arrow
        markerWidth='7'
        markerHeight='8'
        refX='6'
        refY='4'
        orient='auto'
        markerUnits='userSpaceOnUse'
      >
        <path
          d='M1 1 L6 4 L1 7'
          fill='none'
          stroke='var(--text-muted)'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </marker>
    </defs>
  )
}

class CanvasErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <p role='alert' className='p-6 text-small text-status-error-foreground'>
        画布加载失败。可切换到步骤列表继续编辑。
      </p>
    ) : (
      this.props.children
    )
  }
}

/** Spike: FlowGram owns layout/dragging; useStudioDraft owns edits, undo and OCC. */
function FlowgramCanvas(props: CanvasProps) {
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  }, [props])
  const editor = useRef<FixedLayoutPluginContext | null>(null)
  const syncing = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const { layout, onLayoutChange } = props
  const [columns, setColumns] = useState(1)
  const surface = useRef<HTMLDivElement>(null)
  const folded = layout === 'snake' && columns > 1
  const arrangement = useRef({ folded, columns })
  useLayoutEffect(() => {
    arrangement.current = { folded, columns }
  }, [folded, columns])
  useLayoutEffect(() => {
    const element = surface.current
    if (!element) return
    const update = () => {
      if (element.clientWidth > 0)
        setColumns(
          snakeColumns(
            element.clientWidth,
            documentNodeCount(latest.current.document)
          )
        )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.document])
  const [initial] = useState(() => toFlowgram(props.document))
  const options = useMemo<FixedLayoutProps>(
    () => ({
      initialData: initial,
      defaultLayout: FlowLayoutDefault.VERTICAL_FIXED_LAYOUT,
      background: false,
      nodeEngine: { enable: false },
      variableEngine: { enable: false },
      history: { enable: false },
      selectBox: { enable: false },
      scroll: { enableScrollLimit: true },
      nodeRegistries: [
        {
          type: 'cairn-step',
          extend: 'default',
          meta: { deleteDisable: true, copyDisable: true },
          onAfterUpdateLocalTransform(transform) {
            const current = arrangement.current
            if (current.folded)
              transform.position = snakePosition(
                transform.entity.index,
                current.columns
              )
          },
          getInputPoint(transform) {
            const current = arrangement.current
            return current.folded
              ? transform.bounds[
                  snakePort(transform.entity.index, current.columns, 'input')
                ]
              : transform.defaultInputPoint
          },
          getOutputPoint(transform) {
            const current = arrangement.current
            return current.folded
              ? transform.bounds[
                  snakePort(transform.entity.index, current.columns, 'output')
                ]
              : transform.defaultOutputPoint
          },
        },
      ],
      formatNodeLines(_node, lines) {
        return arrangement.current.folded
          ? lines.map((line) => ({
              ...line,
              type: FlowTransitionLineEnum.ROUNDED_LINE,
              vertices: [],
              arrow: true,
              style: { ...line.style, stroke: 'var(--text-muted)' },
            }))
          : lines
      },
      materials: {
        renderDefaultNode: StepNode,
        components: {
          [FlowRendererKey.ADDER]: InsertPoint,
          [FlowRendererKey.DRAG_NODE]: DragPreview,
          [FlowRendererKey.DRAGGABLE_ADDER]: DropTarget,
          [FlowRendererKey.DRAG_HIGHLIGHT_ADDER]: DropHighlight,
          [FlowRendererKey.MARKER_ARROW]: SequenceArrow,
          [FlowRendererKey.MARKER_ACTIVATE_ARROW]: SequenceArrow,
        },
      },
      dragdrop: {
        canDrop: () => !latest.current.disabled,
        onDrop(ctx) {
          queueMicrotask(() => {
            if (syncing.current) return
            const current = latest.current
            try {
              if (current.disabled) {
                ctx.document.fromJSON(toFlowgram(current.document))
                return
              }
              const next = applyFlowgramOrder(
                current.document,
                ctx.document.toJSON()
              )
              if (
                canvasNodeIds(next).some(
                  (id, index) => id !== canvasNodeIds(current.document)[index]
                )
              ) {
                current.onReorder(next, current.selectedId)
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : '重排失败')
              ctx.document.fromJSON(toFlowgram(current.document))
            }
          })
        },
      },
      onInit(ctx) {
        editor.current = ctx
      },
      onAllLayersRendered(ctx) {
        editor.current = ctx
        setReady(true)
        const selected =
          latest.current.selectedId ?? firstAuthoringNodeId(latest.current.document)
        const first = selected ? ctx.document.getNode(selected) : undefined
        const atStart = selected === firstAuthoringNodeId(latest.current.document)
        if (first) {
          const config = ctx.playground.config
          void config.scrollToView({
            bounds: first.bounds,
            zoom: config.zoom,
            scrollToCenter: true,
            scrollDelta: {
              x: arrangement.current.folded
                ? ctx.document.root.bounds.center.x - first.bounds.center.x
                : 0,
              y: atStart
                ? (config.getClientBounds().height / 2 -
                    first.bounds.height / 2 -
                    32) /
                  config.zoom
                : 0,
            },
            easing: false,
          })
        }
      },
      onDispose() {
        editor.current = null
      },
    }),
    [initial]
  )

  useEffect(() => {
    const ctx = editor.current
    if (!ctx || !ready) return
    ctx.playground.config.readonly = props.disabled
    const ids = (ctx.document.toJSON() as FlowDocumentJSON).nodes.map(
      (node) => node.id
    )
    const nextIds = canvasNodeIds(props.document)
    if (ids.join('|') === nextIds.join('|')) return
    syncing.current = true
    ctx.document.fromJSON(toFlowgram(props.document))
    syncing.current = false
  }, [props.document, props.disabled, ready])

  useEffect(() => {
    const ctx = editor.current
    const node = props.selectedId
      ? ctx?.document.getNode(props.selectedId)
      : null
    if (node && ready && ctx)
      void ctx.playground.config.scrollToView({
        bounds: node.bounds,
        zoom: ctx.playground.config.zoom,
        scrollDelta: arrangement.current.folded
          ? {
              x: ctx.document.root.bounds.center.x - node.bounds.center.x,
              y: 0,
            }
          : undefined,
      })
  }, [props.selectedId, ready])

  useEffect(() => {
    const ctx = editor.current
    const request = props.navigation
    if (!ctx || !ready || !request || request.id !== latest.current.selectedId)
      return
    const node = ctx.document.getNode(request.id)
    if (node) {
      // FlowGram's scroll limits read the current zoom, so update it before
      // calculating the destination when leaving the full-flow overview.
      const config = ctx.playground.config
      config.updateZoom(1, false)
      void config.scrollToView({
        bounds: node.bounds,
        zoom: 1,
        scrollToCenter: true,
        scrollDelta: arrangement.current.folded
          ? {
              x: ctx.document.root.bounds.center.x - node.bounds.center.x,
              y: 0,
            }
          : undefined,
        easing: false,
      })
    }
  }, [props.navigation, ready])

  useEffect(() => {
    const ctx = editor.current
    if (!ctx || !ready) return
    ctx.document.traverse((node) => {
      node.transform.localDirty = true
    })
    ctx.document.transformer.clear()
    ctx.document.fireRender()
    const frame = requestAnimationFrame(() => {
      ctx.document.transformer.refresh()
      const selected =
        latest.current.selectedId ?? firstAuthoringNodeId(latest.current.document)
      const node = selected ? ctx.document.getNode(selected) : undefined
      if (!node) return
      const config = ctx.playground.config
      config.updateZoom(1, false)
      void config.scrollToView({
        bounds: node.bounds,
        zoom: 1,
        scrollToCenter: true,
        easing: false,
        scrollDelta: {
          x: folded
            ? ctx.document.root.bounds.center.x - node.bounds.center.x
            : 0,
          y:
            selected === firstAuthoringNodeId(latest.current.document)
              ? config.getClientBounds().height / 2 -
                node.bounds.height / 2 -
                24
              : 0,
        },
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [folded, columns, ready])

  return (
    <CanvasContext.Provider value={{ ...props, compact: folded }}>
      <div
        className={cn('flowgram-sequence', folded && 'is-folded')}
        aria-label='FlowGram 顺序画布'
        data-arrangement={folded ? 'snake' : 'vertical'}
        style={
          {
            '--snake-node-width': `${SNAKE_NODE_WIDTH}px`,
            '--snake-node-height': `${SNAKE_NODE_HEIGHT}px`,
          } as React.CSSProperties
        }
      >
        <div className='flex flex-wrap items-center justify-between gap-2 border-b border-border-divider bg-surface-header px-4 py-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='flex items-center gap-2 text-label text-muted-foreground'>
              <Workflow className='size-4' />
              {documentNodeCount(props.document)} 个节点
              {folded ? ` · 每行 ${columns} 步` : ''}
            </span>
            <div role='group' aria-label='画布排布' className='flex gap-1'>
              <Button
                size='sm'
                variant={layout === 'vertical' ? 'secondary' : 'ghost'}
                aria-pressed={layout === 'vertical'}
                onClick={() => onLayoutChange('vertical')}
              >
                纵向
              </Button>
              <Button
                size='sm'
                variant={layout === 'snake' ? 'secondary' : 'ghost'}
                aria-pressed={layout === 'snake'}
                onClick={() => onLayoutChange('snake')}
              >
                折行
              </Button>
            </div>
          </div>
          <div className='flex gap-1'>
            <Button
              size='icon'
              variant='ghost'
              aria-label='缩小画布'
              onClick={() => {
                const config = editor.current?.playground.config
                if (config) config.updateZoom(config.zoom * 0.8)
              }}
            >
              <Minus />
            </Button>
            <Button
              size='icon'
              variant='ghost'
              aria-label='放大画布'
              onClick={() => {
                const config = editor.current?.playground.config
                if (config) config.updateZoom(config.zoom * 1.25)
              }}
            >
              <Plus />
            </Button>
            <Button
              size='icon'
              variant='ghost'
              aria-label='查看全流程'
              onClick={() => void editor.current?.tools.fitView()}
            >
              <Expand />
            </Button>
          </div>
        </div>
        {error ? (
          <p
            role='alert'
            className='p-3 text-small text-status-error-foreground'
          >
            {error}
          </p>
        ) : null}
        <div ref={surface} className='flowgram-surface'>
          <FixedLayoutEditorProvider {...options} readonly={props.disabled}>
            <EditorRenderer className='flowgram-renderer' />
          </FixedLayoutEditorProvider>
        </div>
      </div>
    </CanvasContext.Provider>
  )
}

/**
 * FlowGram 1.0.15 registers services during render and fails under StrictMode's
 * repeated initialization (FlowRendererRegistry). A local root isolates the
 * third-party lifecycle; Cairn keeps StrictMode, data ownership and all forms.
 */
export default function FlowgramCanvasBridge(props: CanvasProps) {
  const host = useRef<HTMLDivElement>(null)
  const root = useRef<Root | null>(null)
  useEffect(() => {
    const element = document.createElement('div')
    host.current!.appendChild(element)
    const mounted = createRoot(element)
    root.current = mounted
    return () => {
      root.current = null
      element.remove()
      // The parent can be committing; defer disposal of the independent root.
      queueMicrotask(() => mounted.unmount())
    }
  }, [])
  useEffect(() => {
    root.current?.render(
      <CanvasErrorBoundary>
        <FlowgramCanvas {...props} />
      </CanvasErrorBoundary>
    )
  }, [props])
  return <div ref={host} className='min-w-0' />
}
