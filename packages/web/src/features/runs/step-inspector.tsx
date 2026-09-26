import { useState } from 'react'
import {
  isAiStepType,
  type EvidenceMetadata,
  type RunDetailDto,
  type StepRunDto,
} from '@cairn/shared'
import {
  AlertTriangle,
  Bug,
  Copy,
  Database,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  Target,
} from 'lucide-react'
import { toast } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildStepQuote } from '@/features/assistant/quote-helper'
import { translateStepError } from './error-translator'
import { OutcomeConditionList } from './outcome-axis'
import { ContextLists } from './context-lists'
import { AiAttemptSummary } from './ai-evidence'
import { RunMapClues } from '@/features/map/run-clues'
import { RunMapDecisions } from './map-decisions'
import { RunResolutionDecisions } from './resolution-decisions'
import { AiActionTracePanel } from './ai-action-trace'
import {
  formatDuration,
  STEP_RUN_STATUS_LABELS,
  stepRunStatusTone,
} from './labels'
import { StatusBadge } from '@/components/status-badge'

type Props = {
  run: RunDetailDto
  step: StepRunDto | undefined
  selectedAttemptId: string | null
  evidenceItems: EvidenceMetadata[]
  eventSeq?: number
  onFocusEvidence?: (evidenceId: string) => void
}

export function StepInspector({
  run,
  step,
  selectedAttemptId,
  evidenceItems,
  eventSeq = 0,
  onFocusEvidence,
}: Props) {
  const [activeTab, setActiveTab] = useState<'evidence' | 'outcome' | 'data' | 'debug'>('evidence')
  const setQuote = useAssistantStore((s) => s.setQuote)
  const openAssistant = useAssistantStore((s) => s.openPanel)

  if (!step) {
    return (
      <div className='flex size-full items-center justify-center rounded-lg border border-border-card bg-card p-8 text-center shadow-card'>
        <p className='text-label text-muted-foreground'>请在左侧流水线中选择一个步骤进行检视</p>
      </div>
    )
  }

  // 确定当前选中的 Attempt
  const activeAttempt =
    step.attempts.find((a) => a.id === selectedAttemptId) ||
    step.attempts[step.attempts.length - 1]

  const attemptEvidences = activeAttempt
    ? evidenceItems.filter((item) => item.attemptId === activeAttempt.id)
    : []

  const isFailed = step.status === 'FAILED' || activeAttempt?.status === 'FAILED'
  const errorInfo = activeAttempt?.error
  const diagnosis = isFailed && errorInfo ? translateStepError(errorInfo) : null
  const isAi = isAiStepType(step.type)

  const askAssistantAboutError = () => {
    if (!errorInfo) return
    const quote = buildStepQuote(
      step,
      `第 ${activeAttempt?.attemptNo ?? 1} 次尝试报错 [${errorInfo.code}]: ${errorInfo.safeMessage}`
    )
    setQuote(quote)
    openAssistant({
      question: `帮我诊断这个步骤报错：${diagnosis?.title || errorInfo.code}，原因与排查方案是什么？`,
      capabilityHint: 'run.diagnose',
      pageContext: { page: 'run', runId: run.id },
    })
  }

  return (
    <div className='flex size-full flex-col overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
      {/* 1. 检视器头部：步骤名称、状态与操作 */}
      <div className='border-b border-border-divider bg-surface-header p-3 shrink-0'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2 min-w-0'>
            <span className='font-mono font-bold text-foreground text-body'>
              #{step.ordinal + 1}
            </span>
            <h2 className='text-body font-semibold text-foreground truncate max-w-sm sm:max-w-md' title={step.name}>
              {step.name}
            </h2>
            <StatusBadge tone={stepRunStatusTone(step.status)}>
              {STEP_RUN_STATUS_LABELS[step.status]}
            </StatusBadge>

            {activeAttempt ? (
              <span className='rounded bg-muted/60 px-1.5 py-0.5 font-mono text-caption text-muted-foreground'>
                尝试 #{activeAttempt.attemptNo}
                {formatDuration(activeAttempt.startedAt, activeAttempt.finishedAt)
                  ? ` · ${formatDuration(activeAttempt.startedAt, activeAttempt.finishedAt)}`
                  : ''}
              </span>
            ) : null}
          </div>

          <div className='flex items-center gap-2 shrink-0'>
            <Can allOf={['ai:assist']}>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-7 text-label text-primary gap-1'
                onClick={() => {
                  const err = errorInfo ? `${errorInfo.code}: ${errorInfo.safeMessage}` : undefined
                  setQuote(buildStepQuote(step, err))
                  toast.success('已引用该步骤至识途助手')
                }}
              >
                <MessageSquare className='size-3.5' />
                <span>引用至助手</span>
              </Button>
            </Can>
          </div>
        </div>
      </div>

      {/* 2. 检视器 Tab 导航与内容区 */}
      <Tabs
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as typeof activeTab)}
        className='flex flex-1 flex-col overflow-hidden'
      >
        <div className='border-b border-border-divider px-3 bg-card shrink-0'>
          <TabsList className='h-9 bg-transparent p-0 gap-4'>
            <TabsTrigger
              value='evidence'
              className='relative h-9 rounded-none border-b-2 border-transparent px-2 font-medium data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:shadow-none'
            >
              <div className='flex items-center gap-1.5'>
                <ImageIcon className='size-3.5' />
                <span>诊断与证据</span>
                {isFailed ? (
                  <span className='size-1.5 rounded-full bg-status-error-foreground' />
                ) : null}
              </div>
            </TabsTrigger>

            <TabsTrigger
              value='outcome'
              className='relative h-9 rounded-none border-b-2 border-transparent px-2 font-medium data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:shadow-none'
            >
              <div className='flex items-center gap-1.5'>
                <Target className='size-3.5' />
                <span>成功条件</span>
              </div>
            </TabsTrigger>

            <TabsTrigger
              value='data'
              className='relative h-9 rounded-none border-b-2 border-transparent px-2 font-medium data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:shadow-none'
            >
              <div className='flex items-center gap-1.5'>
                <Database className='size-3.5' />
                <span>步骤数据</span>
              </div>
            </TabsTrigger>

            <TabsTrigger
              value='debug'
              className='relative h-9 rounded-none border-b-2 border-transparent px-2 font-medium data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:shadow-none'
            >
              <div className='flex items-center gap-1.5'>
                <Bug className='size-3.5' />
                <span>技术调试</span>
              </div>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Tab 1: 诊断与现场证据 */}
        <div className={activeTab === 'evidence' ? 'flex-1 overflow-y-auto p-4 space-y-4 m-0' : 'hidden'}>
          {/* A. 业务人话错误转译卡片 */}
          {diagnosis ? (
            <div className='rounded-lg border border-status-error-foreground/30 bg-status-error-background/20 p-4 shadow-xs space-y-3'>
              <div className='flex items-start justify-between gap-3'>
                <div className='flex items-start gap-2.5'>
                  <AlertTriangle className='size-5 text-status-error-foreground shrink-0 mt-0.5' />
                  <div>
                    <h3 className='text-body font-semibold text-status-error-foreground'>
                      {diagnosis.title}
                    </h3>
                    <p className='mt-1 text-label text-foreground/90 leading-relaxed'>
                      {diagnosis.description}
                    </p>
                  </div>
                </div>

                <Can allOf={['ai:assist']}>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='shrink-0 h-7 text-label text-status-error-foreground border-status-error-foreground/40 hover:bg-status-error-background/40 gap-1'
                    onClick={askAssistantAboutError}
                  >
                    <Sparkles className='size-3' />
                    <span>智能诊断</span>
                  </Button>
                </Can>
              </div>

              <div className='rounded-md bg-card/80 p-2.5 border border-border-card text-label'>
                <span className='font-medium text-foreground'>💡 排查与自愈建议：</span>
                <span className='text-muted-foreground ml-1'>{diagnosis.suggestion}</span>
              </div>
            </div>
          ) : null}

          {/* B. 关键截图证据 */}
          <div className='space-y-2'>
            <h3 className='text-label font-semibold text-foreground flex items-center gap-1.5'>
              <ImageIcon className='size-3.5 text-primary' />
              <span>现场截图与证据</span>
            </h3>

            {/* 步骤证据附件列表 */}
            {attemptEvidences.length > 0 ? (
              <div className='pt-1 space-y-2'>
                <p className='text-caption font-medium text-muted-foreground'>
                  本步骤产生证据 ({attemptEvidences.length} 项)
                </p>
                <div className='space-y-1.5'>
                  {attemptEvidences.map((ev) => (
                    <div
                      key={ev.id}
                      className='flex items-center justify-between rounded border border-border-card bg-muted/20 px-3 py-2 text-label'
                    >
                      <div className='flex items-center gap-2'>
                        <span className='font-medium text-foreground'>{ev.type}</span>
                        <span className='font-mono text-caption text-muted-foreground'>#{ev.id.slice(0, 8)}</span>
                      </div>
                      <span className='text-caption text-muted-foreground'>{ev.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className='text-label text-muted-foreground'>该步骤无关键现场截图</p>
            )}
          </div>

          {/* C. AI 执行摘要（若为 AI 步骤） */}
          {isAi && activeAttempt ? (
            <div className='rounded-md border border-purple-200 bg-purple-50/50 dark:bg-purple-950/20 p-3 space-y-2'>
              <div className='flex items-center gap-1.5 text-purple-700 dark:text-purple-300 font-medium text-label'>
                <Sparkles className='size-3.5' />
                <span>AI 智能动作决策</span>
              </div>
              <AiAttemptSummary output={activeAttempt.output} evidence={attemptEvidences} />
            </div>
          ) : null}
        </div>

        {/* Tab 2: 成功条件与业务判定 */}
        <div className={activeTab === 'outcome' ? 'flex-1 overflow-y-auto p-4 space-y-3 m-0' : 'hidden'}>
          {run.snapshot.outcomeManifest?.entries.length ||
          run.snapshot.runtimeInvariantManifest?.entries.length ? (
            <OutcomeConditionList
              runId={run.id}
              run={run}
              evidenceItems={evidenceItems}
              onFocusEvidence={onFocusEvidence}
            />
          ) : (
            <div className='py-12 text-center text-label text-muted-foreground'>
              本次运行未配置成功条件或运行期不变式规则。
            </div>
          )}
        </div>

        {/* Tab 3: 步骤数据（上下文输入输出） */}
        <div className={activeTab === 'data' ? 'flex-1 overflow-y-auto p-4 space-y-4 m-0' : 'hidden'}>
          <div className='flex items-center justify-between'>
            <h3 className='text-label font-semibold text-foreground'>步骤输入与输出变量</h3>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 px-2 text-label'
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(run.context, null, 2))
                toast.success('已复制步骤上下文数据')
              }}
            >
              <Copy className='mr-1 size-3' />
              复制全局上下文
            </Button>
          </div>

          <div className='space-y-3'>
            <ContextLists context={run.context} />

            <details className='rounded-md border border-border-card/60 bg-muted/30 p-2.5'>
              <summary className='cursor-pointer text-label font-medium text-muted-foreground hover:text-foreground'>
                查看完整上下文原始 JSON 数据
              </summary>
              <pre className='mt-2 overflow-x-auto rounded bg-card p-3 text-caption font-mono border border-border-card'>
                {JSON.stringify(run.context, null, 2)}
              </pre>
            </details>
          </div>
        </div>

        {/* Tab 4: 技术调试 */}
        <div className={activeTab === 'debug' ? 'flex-1 overflow-y-auto p-4 space-y-4 m-0' : 'hidden'}>
          {/* Aria 快照比对差异 (Diff) */}
          {typeof activeAttempt?.output === 'object' &&
          activeAttempt.output !== null &&
          'diff' in activeAttempt.output &&
          typeof (activeAttempt.output as { diff?: unknown }).diff === 'string' ? (
            <div className='rounded-md border border-border bg-card p-3 space-y-2'>
              <p className='text-label font-semibold text-foreground'>Aria 快照比对差异 (Diff):</p>
              <pre className='overflow-x-auto rounded bg-muted/40 p-2.5 font-mono text-caption leading-relaxed'>
                {(activeAttempt.output as { diff: string }).diff}
              </pre>
            </div>
          ) : null}

          {/* AI 动作轨迹事实 */}
          {activeAttempt ? (
            <AiActionTracePanel runId={run.id} attemptId={activeAttempt.id} />
          ) : null}

          {/* 地图决策与线索 */}
          <div className='space-y-3 border-t border-border-divider pt-3'>
            <RunMapClues targetId={run.targetId} runId={run.id} />
            <RunMapDecisions runId={run.id} eventSeq={eventSeq} steps={run.stepRuns} />
            <RunResolutionDecisions runId={run.id} eventSeq={eventSeq} steps={run.stepRuns} />
          </div>
        </div>
      </Tabs>
    </div>
  )
}
