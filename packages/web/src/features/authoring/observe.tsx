import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { resolveOutcomeWriteback } from '@cairn/authoring'
import {
  observationShowsFragileCss,
  type AuthoringCapabilities,
  type RunDetailDto,
  type TargetDescriptor,
  type TargetObservation,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { observeRun } from '@/lib/runs-api'
import { observeSession } from '@/lib/sessions-api'
import { useRunObservation } from '@/features/runs/use-run-observation'
import {
  type ApplyPickedExtras,
  observationPreviewText,
  targetFromPickedLabel,
} from './pick-apply'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

export type ScreenAlignmentStatus =
  | 'aligned'
  | 'ahead'
  | 'behind'
  | 'session_initial'
  | 'offline_snapshot'
  | 'disconnected'

export function computeScreenAlignment(input: {
  sessionOpen: boolean
  liveRun?: {
    status: string
    checkpoint?: {
      stepId: string
      reason: string
    } | null
    stepRuns: Array<{ stepId: string; status: string }>
  } | null
  selectedStepId?: string | null
  stepOrder: string[]
  hasOfflineScreenshot?: boolean
}): ScreenAlignmentStatus {
  const { sessionOpen, liveRun, selectedStepId, stepOrder, hasOfflineScreenshot } = input
  if (!selectedStepId) return 'disconnected'

  const selIdx = stepOrder.indexOf(selectedStepId)
  if (selIdx < 0) return 'disconnected'

  if (!liveRun) {
    if (sessionOpen) {
      return selIdx === 0 ? 'aligned' : 'session_initial'
    }
    return hasOfflineScreenshot ? 'offline_snapshot' : 'disconnected'
  }

  const checkpoint = liveRun.checkpoint
  if (liveRun.status === 'HOLDING' && checkpoint) {
    const chkIdx = stepOrder.indexOf(checkpoint.stepId)
    if (chkIdx < 0) return 'disconnected'

    if (checkpoint.reason === 'author_pause') {
      if (selIdx === chkIdx) return 'aligned'
      return chkIdx < selIdx ? 'behind' : 'ahead'
    }

    if (checkpoint.reason === 'step_succeeded') {
      if (selIdx === chkIdx + 1) return 'aligned'
      return chkIdx + 1 < selIdx ? 'behind' : 'ahead'
    }

    if (selIdx === chkIdx) return 'aligned'
    return chkIdx < selIdx ? 'behind' : 'ahead'
  }

  return 'disconnected'
}

type AuthoringObserveValue = {
  runId?: string
  sessionId?: string
  run?: RunDetailDto
  refresh?: () => Promise<unknown>
  holding: boolean
  livePage: boolean
  checkpointStepId?: string
  overlayStepId?: string
  highlight?: TargetObservation
  lastPicked?: TargetDescriptor
  pickMode: boolean
  canIndicate: boolean
  canHighlight: boolean
  canDebugHold: boolean
  setPickMode: (next: boolean) => void
  highlightTarget: (target: TargetDescriptor, options?: { silent?: boolean }) => Promise<TargetObservation | undefined>
  pickAt: (x: number, y: number) => void
  applyForTrial: (target?: TargetDescriptor) => void
  clearOverlay: (stepId: string) => void
  writeBack: () => void
  applyPickedToStep: () => void
  adoptAlternative: (label: string) => void
  applyAsOutcome: () => void
  ensureStepOutputKey?: (stepId: string, outputKey: string) => void
}

const closedObserve: AuthoringObserveValue = {
  holding: false,
  livePage: false,
  pickMode: false,
  canIndicate: false,
  canHighlight: false,
  canDebugHold: false,
  setPickMode: () => undefined,
  highlightTarget: async () => undefined,
  pickAt: () => undefined,
  applyForTrial: () => undefined,
  clearOverlay: () => undefined,
  writeBack: () => undefined,
  applyPickedToStep: () => undefined,
  adoptAlternative: () => undefined,
  applyAsOutcome: () => undefined,
}

export function overlayStepIdForSelection(
  run: {
    checkpoint?: Pick<NonNullable<RunDetailDto['checkpoint']>, 'stepId'> | null
    debugOverlay?: Pick<NonNullable<RunDetailDto['debugOverlay']>, 'stepOverrides'> | null
    snapshot?: Pick<RunDetailDto['snapshot'], 'outcomeManifest'>
  } | undefined,
  selectedStepId?: string | null,
): string | undefined {
  const overrides = run?.debugOverlay?.stepOverrides
  if (!overrides) return undefined
  if (selectedStepId && overrides[selectedStepId]) return selectedStepId
  const checkpointId = run?.checkpoint?.stepId
  if (!checkpointId || !overrides[checkpointId]) return undefined
  const writeback = resolveOutcomeWriteback(run.snapshot?.outcomeManifest, checkpointId)
  if (!writeback) return undefined
  if (writeback.scope === 'scenario' && !selectedStepId) return checkpointId
  if (writeback.sourceStepId && writeback.sourceStepId === selectedStepId) return checkpointId
  return undefined
}

const AuthoringObserveContext =
  createContext<AuthoringObserveValue>(closedObserve)

export function useAuthoringObserve() {
  return useContext(AuthoringObserveContext)
}

export function AuthoringObserveProvider({
  runId,
  sessionId,
  selectedStepId,
  enabled,
  authoring,
  onApplyTarget,
  onWriteBack,
  onEnsureStepOutputKey,
  children,
}: {
  runId?: string
  sessionId?: string
  selectedStepId?: string | null
  enabled: boolean
  authoring?: AuthoringCapabilities
  onApplyTarget: (target: TargetDescriptor, extras?: ApplyPickedExtras) => void
  onWriteBack?: () => Promise<boolean>
  onEnsureStepOutputKey?: (stepId: string, outputKey: string) => void
  children: ReactNode
}) {
  const { run, refresh } = useRunObservation(
    runId ?? '',
    Boolean(runId && enabled)
  )
  const [pickMode, setPickModeState] = useState(false)
  const [highlight, setHighlight] = useState<TargetObservation | undefined>()
  const [lastPicked, setLastPicked] = useState<TargetDescriptor | undefined>()
  const holding = Boolean(
    run && run.status === 'HOLDING' && run.debugMode !== 'runThrough'
  )
  const livePage = holding || Boolean(sessionId)
  const canIndicate = authoring?.indicate !== 'closed'
  const canHighlight = authoring?.highlight !== 'closed'
  const canDebugHold = authoring?.debugHold !== 'closed'

  const [disambiguationModal, setDisambiguationModal] = useState<{
    visibleText: string
    accessibleName: string
    observation: TargetObservation
  } | null>(null)
  const [disambiguationChoice, setDisambiguationChoice] = useState<'visible_text' | 'accessible_name'>('visible_text')

  const confirmDisambiguation = (choice: 'visible_text' | 'accessible_name') => {
    if (!disambiguationModal) return
    const { visibleText, accessibleName, observation } = disambiguationModal
    let target = observation.target!
    let previewText = visibleText

    if (choice === 'visible_text') {
      const rest = target.candidates.filter(
        (c) => !(c.by === 'text' && c.value === visibleText),
      )
      target = {
        ...target,
        candidates: [{ by: 'text' as const, value: visibleText }, ...rest].slice(0, 5),
      }
      previewText = visibleText
    } else {
      previewText = observationPreviewText(observation) || accessibleName
    }

    setLastPicked(target)
    setPickModeState(false)
    setDisambiguationModal(null)

    if (!holding) {
      onApplyTarget(target, { previewText })
      toast.success(`已用「${previewText}」写入当前步骤`)
    } else {
      toast.success('已点到元素，可写入本次验证或写回草稿')
    }

    if (canHighlight) {
      void observePage({ op: 'highlight', target }).then(setHighlight).catch(() => undefined)
    }
  }

  const observePage = (body: Parameters<typeof observeRun>[1]) => {
    if (holding && runId) return observeRun(runId, body)
    if (sessionId) return observeSession(sessionId, body)
    return Promise.reject(new Error('没有可观察的受管页面'))
  }

  const value = useMemo<AuthoringObserveValue>(
    () => ({
      runId,
      sessionId,
      run,
      refresh,
      holding,
      livePage,
      checkpointStepId: holding ? run?.checkpoint?.stepId : undefined,
      overlayStepId: overlayStepIdForSelection(run, selectedStepId),
      highlight,
      lastPicked,
      pickMode,
      canIndicate,
      canHighlight,
      canDebugHold,
      ensureStepOutputKey: onEnsureStepOutputKey,
      setPickMode: (next) => {
        if (next && (!canIndicate || !livePage)) {
          toast.message('没有可点选的受管画面。请先连接目标账号会话，或开试跑并等到步骤挂起。')
          return
        }
        setPickModeState(next)
        if (next && livePage) {
          void observePage({ op: 'highlight' }).catch(() => undefined)
        }
      },
      highlightTarget: async (target, options) => {
        if (!canHighlight) return undefined
        if (!livePage) {
          if (!options?.silent) {
            toast.message('没有可点选的受管画面。请先连接目标账号会话，或开试跑并等到步骤挂起。')
          }
          return undefined
        }
        try {
          const observation = await observePage({ op: 'highlight', target })
          setHighlight(observation)
          if (options?.silent) return observation
          if (observation.outcome === 'AMBIGUOUS') {
            toast.message(
              observation.alternatives?.[0]?.reason ??
                '找到多个匹配，请改候选或再点一次'
            )
            return observation
          }
          if (observation.outcome !== 'FOUND') {
            toast.message('没有找到唯一匹配')
            return observation
          }
          if (observationShowsFragileCss(observation)) {
            toast.message(
              '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
            )
          }
          return observation
        } catch (error) {
          toast.error(
            error instanceof ApiRequestError ? error.message : '校验失败'
          )
          return undefined
        }
      },
      pickAt: (x, y) => {
        if (!canIndicate || !livePage) return
        void observePage({ op: 'pick', x, y })
          .then((observation) => {
            setHighlight(observation)
            if (observation.outcome === 'AMBIGUOUS') {
              setLastPicked(undefined)
              toast.message(
                observation.alternatives?.[0]?.reason ??
                  '找到多个匹配，请再点一次或改候选'
              )
              return
            }
            if (observation.target && observation.outcome === 'FOUND') {
              if (observation.disambiguation) {
                setDisambiguationModal({
                  visibleText: observation.disambiguation.visibleText,
                  accessibleName: observation.disambiguation.accessibleName,
                  observation,
                })
                setDisambiguationChoice('visible_text')
                return
              }
              setLastPicked(observation.target)
              setPickModeState(false)
              const previewText = observationPreviewText(observation)
              if (!holding) {
                onApplyTarget(observation.target, { previewText })
                toast.success(
                  previewText
                    ? `已写入当前步骤。画面上读到「${previewText}」`
                    : '已写入当前步骤',
                )
              } else {
                toast.success('已点到元素，可写入本次验证或写回草稿')
              }
              if (observationShowsFragileCss(observation)) {
                toast.message(
                  '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
                )
              }
              if (canHighlight) {
                void observePage({ op: 'highlight', target: observation.target })
                  .then(setHighlight)
                  .catch(() => undefined)
              }
            } else {
              setLastPicked(undefined)
              toast.message('没有点到可识别的元素')
            }
          })
          .catch((error) => {
            if (
              error instanceof ApiRequestError &&
              error.payload.code === 'OBSERVE_GRANT_EXPIRED'
            ) {
              toast.error('观察授权已过期，请再点一次「在页面上指认」')
              setPickModeState(false)
              return
            }
            toast.error(
              error instanceof ApiRequestError ? error.message : '指认失败'
            )
          })
      },
      applyForTrial: (target) => {
        const next = target ?? lastPicked ?? highlight?.target
        if (!runId || !holding || !next) {
          toast.message('请先在页面上指认或校验一个目标')
          return
        }
        void observePage({
          op: 'highlight',
          target: next,
          applyOverlay: true,
        })
          .then((observation) => {
            setHighlight(observation)
            void refresh()
            if (observation.outcome === 'FOUND')
              toast.success('已写入本次试跑覆盖，不影响草稿')
            else
              toast.message(
                observation.outcome === 'AMBIGUOUS'
                  ? '覆盖已记下，但页面上仍有多个匹配'
                  : '覆盖已记下，但页面上没有唯一匹配'
              )
          })
          .catch((error) => {
            toast.error(
              error instanceof ApiRequestError
                ? error.message
                : '无法写入本次验证'
            )
          })
      },
      clearOverlay: (stepId) => {
        if (!runId) return
        void observePage({ op: 'highlight', clearOverlayStepId: stepId })
          .then(() => {
            setHighlight(undefined)
            void refresh()
          })
          .catch((error) => {
            toast.error(
              error instanceof ApiRequestError
                ? error.message
                : '无法恢复原始目标'
            )
          })
      },
      writeBack: () => {
        if (lastPicked) {
          onApplyTarget(lastPicked, { previewText: observationPreviewText(highlight) })
        }
        void onWriteBack?.().then((ok) => {
          if (ok) {
            setLastPicked(undefined)
            void refresh()
          }
        })
      },
      applyPickedToStep: () => {
        const next = lastPicked ?? highlight?.target
        if (!next) {
          toast.message('请先在画面上点到一个元素')
          return
        }
        onApplyTarget(next, { previewText: observationPreviewText(highlight) })
        setPickModeState(false)
        toast.success('已写入当前步骤')
      },
      adoptAlternative: (label) => {
        const next = targetFromPickedLabel(label, highlight?.target ?? lastPicked)
        setLastPicked(next)
        setPickModeState(false)
        if (!holding) onApplyTarget(next, { previewText: label })
        toast.success(`已用「${label}」写入当前步骤`)
        void observePage({ op: 'highlight', target: next })
          .then((observation) => {
            setHighlight(observation)
            if (observation.outcome === 'AMBIGUOUS') {
              toast.message('这个内容在页面上不止一处，执行时可能对不上。请再点更具体的一格。')
            }
          })
          .catch(() => undefined)
      },
      applyAsOutcome: () => {
        const next = lastPicked ?? highlight?.target
        const previewText = observationPreviewText(highlight)
        if (!next && !previewText) {
          toast.message('请先在画面上点到要判断的内容')
          return
        }
        if (next) setLastPicked(next)
        onApplyTarget(next ?? { framePath: [], semantic: previewText, candidates: [{ by: 'text', value: previewText }] }, {
          previewText,
          addOutcome: true,
        })
        setPickModeState(false)
        toast.success(previewText ? `已添加成功条件：${previewText}` : '已添加成功条件')
      },
    }),
    [
      authoring,
      canDebugHold,
      canHighlight,
      canIndicate,
      highlight,
      holding,
      lastPicked,
      livePage,
      observePage,
      onApplyTarget,
      onWriteBack,
      pickMode,
      refresh,
      run,
      runId,
      selectedStepId,
      sessionId,
    ]
  )

  return (
    <AuthoringObserveContext.Provider value={value}>
      {children}
      {disambiguationModal ? (
        <Dialog open onOpenChange={(open) => !open && setDisambiguationModal(null)}>
          <DialogContent className='sm:max-w-md'>
            <DialogHeader>
              <DialogTitle className='flex items-center gap-1.5'>
                <span>🎯</span>
                <span>请确认目标语义</span>
              </DialogTitle>
              <DialogDescription>
                检测到该元素页面上显示的文本与底层无障碍名称存在差异，请确认采用哪一个作为定位描述：
              </DialogDescription>
            </DialogHeader>
            <RadioGroup
              value={disambiguationChoice}
              onValueChange={(val) => setDisambiguationChoice(val as 'visible_text' | 'accessible_name')}
              className='space-y-2 py-2'
            >
              <div className='flex items-center space-x-2 rounded-md border border-border-card p-3 bg-muted/20'>
                <RadioGroupItem value='visible_text' id='r-vis' />
                <Label htmlFor='r-vis' className='flex-1 cursor-pointer text-small'>
                  <span className='font-semibold text-foreground'>页面可见字：「{disambiguationModal.visibleText}」</span>
                  <span className='ml-2 text-status-success-foreground font-medium'>(推荐)</span>
                </Label>
              </div>
              <div className='flex items-center space-x-2 rounded-md border border-border-card p-3 bg-muted/20'>
                <RadioGroupItem value='accessible_name' id='r-aria' />
                <Label htmlFor='r-aria' className='flex-1 cursor-pointer text-small'>
                  <span className='font-semibold text-foreground'>无障碍名称：「{disambiguationModal.accessibleName}」</span>
                </Label>
              </div>
            </RadioGroup>
            <DialogFooter className='gap-2 sm:gap-0'>
              <Button variant='outline' onClick={() => setDisambiguationModal(null)}>
                取消
              </Button>
              <Button onClick={() => confirmDisambiguation(disambiguationChoice)}>
                确认采用
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </AuthoringObserveContext.Provider>
  )
}
