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
import { useRunObservation } from '@/features/runs/use-run-observation'

type AuthoringObserveValue = {
  runId?: string
  holding: boolean
  checkpointStepId?: string
  overlayStepId?: string
  highlight?: TargetObservation
  lastPicked?: TargetDescriptor
  pickMode: boolean
  canIndicate: boolean
  canHighlight: boolean
  canDebugHold: boolean
  setPickMode: (next: boolean) => void
  highlightTarget: (target: TargetDescriptor) => void
  pickAt: (x: number, y: number) => void
  applyForTrial: (target?: TargetDescriptor) => void
  clearOverlay: (stepId: string) => void
  writeBack: () => void
}

const closedObserve: AuthoringObserveValue = {
  holding: false,
  pickMode: false,
  canIndicate: false,
  canHighlight: false,
  canDebugHold: false,
  setPickMode: () => undefined,
  highlightTarget: () => undefined,
  pickAt: () => undefined,
  applyForTrial: () => undefined,
  clearOverlay: () => undefined,
  writeBack: () => undefined,
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
  selectedStepId,
  enabled,
  authoring,
  onApplyTarget,
  onWriteBack,
  children,
}: {
  runId?: string
  selectedStepId?: string | null
  enabled: boolean
  authoring?: AuthoringCapabilities
  onApplyTarget: (target: TargetDescriptor) => void
  onWriteBack?: () => Promise<boolean>
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
  const canIndicate = authoring?.indicate !== 'closed'
  const canHighlight = authoring?.highlight !== 'closed'
  const canDebugHold = authoring?.debugHold !== 'closed'

  const value = useMemo<AuthoringObserveValue>(
    () => ({
      runId,
      holding,
      checkpointStepId: holding ? run?.checkpoint?.stepId : undefined,
      overlayStepId: overlayStepIdForSelection(run, selectedStepId),
      highlight,
      lastPicked,
      pickMode,
      canIndicate,
      canHighlight,
      canDebugHold,
      setPickMode: (next) => {
        if (next && (!canIndicate || !runId || !holding)) {
          toast.message('没有调试画面时，请先开试跑或使用录制插件指认')
          return
        }
        setPickModeState(next)
        if (next && runId && holding) {
          void observeRun(runId, { op: 'highlight' }).catch(() => undefined)
        }
      },
      highlightTarget: (target) => {
        if (!canHighlight) return
        if (!runId || !holding) {
          toast.message('没有调试画面时，请先开试跑或使用录制插件指认')
          return
        }
        void observeRun(runId, { op: 'highlight', target })
          .then((observation) => {
            setHighlight(observation)
            if (observation.outcome === 'AMBIGUOUS') {
              toast.message(
                observation.alternatives?.[0]?.reason ??
                  '找到多个匹配，请改候选或再点一次'
              )
              return
            }
            if (observation.outcome !== 'FOUND') {
              toast.message('没有找到唯一匹配')
              return
            }
            if (observationShowsFragileCss(observation)) {
              toast.message(
                '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
              )
            }
          })
          .catch((error) => {
            toast.error(
              error instanceof ApiRequestError ? error.message : '校验失败'
            )
          })
      },
      pickAt: (x, y) => {
        if (!canIndicate || !runId || !holding) return
        void observeRun(runId, { op: 'pick', x, y })
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
              setLastPicked(observation.target)
              setPickModeState(false)
              toast.success('已点到元素，可写入本次验证或写回草稿')
              if (observationShowsFragileCss(observation)) {
                toast.message(
                  '当前只能用较脆弱的 CSS 定位，建议改成测试标识或角色'
                )
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
        void observeRun(runId, {
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
        void observeRun(runId, { op: 'highlight', clearOverlayStepId: stepId })
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
        if (lastPicked) onApplyTarget(lastPicked)
        void onWriteBack?.().then((ok) => {
          if (ok) {
            setLastPicked(undefined)
            void refresh()
          }
        })
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
      onApplyTarget,
      onWriteBack,
      pickMode,
      refresh,
      run,
      runId,
      selectedStepId,
    ]
  )

  return (
    <AuthoringObserveContext.Provider value={value}>
      {children}
    </AuthoringObserveContext.Provider>
  )
}
