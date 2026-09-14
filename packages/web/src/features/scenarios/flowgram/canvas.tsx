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
  type CompileDiagnostic,
  type RunDetailDto,
  type ScenarioDocument,
} from '@cairn/shared'
import {
  EditorRenderer,
  FlowLayoutDefault,
  FlowRendererKey,
  type FlowNodeEntity,
  FixedLayoutEditorProvider,
  useNodeRender,
  type FixedLayoutPluginContext,
  type FixedLayoutProps,
  type FlowDocumentJSON,
} from '@flowgram.ai/fixed-layout-editor'
import '@flowgram.ai/fixed-layout-editor/index.css'
import { Expand, GripVertical, Minus, Plus, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import {
  STEP_RUN_STATUS_LABELS,
  stepRunStatusTone,
} from '@/features/runs/labels'
import { STEP_TYPE_HINTS, stepTypeLabel } from '../step-registry'
import { applyFlowgramOrder, toFlowgram } from './adapter'
import './canvas.css'

type CanvasProps = {
  document: ScenarioDocument
  selectedId: string | null
  disabled: boolean
  trialRun?: RunDetailDto
  diagnostics: readonly CompileDiagnostic[]
  onSelect: (id: string) => void
  onInsertAfter: (id: string) => void
  onReorder: (document: ScenarioDocument, selectedId: string | null) => void
}
const CanvasContext = createContext<CanvasProps | null>(null)

function StepNode() {
  const model = useContext(CanvasContext)!
  const { id, startDrag, onMouseEnter, onMouseLeave, dragging } =
    useNodeRender()
  const step = model.document.steps.find((item) => item.id === id)
  if (!step) return null
  const index = model.document.steps.indexOf(step)
  const errors = model.diagnostics.filter(
    (item) => item.stepId === id && item.severity === 'error'
  )
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
        errors.length > 0 && 'has-error',
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
          <StatusBadge tone={isAiStepType(step.type) ? 'ai' : 'neutral'}>
            {stepTypeLabel(step.type)}
          </StatusBadge>
          {result && matchesSnapshot ? (
            <StatusBadge tone={stepRunStatusTone(result.status)}>
              试跑 {STEP_RUN_STATUS_LABELS[result.status]}
            </StatusBadge>
          ) : null}
          {result && !matchesSnapshot ? <span>草稿已修改</span> : null}
          {errors.length > 0 ? (
            <StatusBadge tone='error'>引用 / 字段异常</StatusBadge>
          ) : null}
        </span>
        <span className='mt-2 block text-body font-semibold break-words'>
          {step.name}
        </span>
        <span className='mt-1 block text-label break-words text-muted-foreground'>
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
      disabled={model.disabled}
      aria-label={`在${model.document.steps.find((step) => step.id === from.id)?.name ?? '此处'}后插入步骤`}
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
    <div className='flowgram-drag-preview'>
      {model.document.steps.find((step) => step.id === dragStart?.id)?.name ??
        '移动步骤'}
    </div>
  )
}
function DropTarget() {
  return <div className='flowgram-drop-target' />
}
function DropHighlight() {
  return <div className='flowgram-drop-highlight' />
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
        },
      ],
      materials: {
        renderDefaultNode: StepNode,
        components: {
          [FlowRendererKey.ADDER]: InsertPoint,
          [FlowRendererKey.DRAG_NODE]: DragPreview,
          [FlowRendererKey.DRAGGABLE_ADDER]: DropTarget,
          [FlowRendererKey.DRAG_HIGHLIGHT_ADDER]: DropHighlight,
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
                next.steps.some(
                  (step, index) => step.id !== current.document.steps[index]?.id
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
          latest.current.selectedId ?? latest.current.document.steps[0]!.id
        const first = ctx.document.getNode(selected)
        const atStart = selected === latest.current.document.steps[0]?.id
        if (first) {
          const config = ctx.playground.config
          void config.scrollToView({
            bounds: first.bounds,
            zoom: config.zoom,
            scrollToCenter: true,
            scrollDelta: {
              x: 0,
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
    const nextIds = props.document.steps.map((step) => step.id)
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
      })
  }, [props.selectedId, ready])

  return (
    <CanvasContext.Provider value={props}>
      <div className='flowgram-sequence' aria-label='FlowGram 顺序画布'>
        <div className='flex items-center justify-between gap-2 border-b border-border-divider bg-surface-header px-4 py-2'>
          <span className='flex items-center gap-2 text-label text-muted-foreground'>
            <Workflow className='size-4' />
            顺序编排 · {props.document.steps.length} 步
          </span>
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
        <div className='flowgram-surface'>
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
