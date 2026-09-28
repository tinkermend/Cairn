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
  ExternalLink,
  Image as ImageIcon,
  MessageSquare,
  Sparkles,
  Target,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildStepQuote } from '@/features/assistant/quote-helper'
import { translateStepError } from './error-translator'
import { healerHypothesisOf, isAttemptHealed, isStepHealed } from './healed-helper'
import { OutcomeConditionList } from './outcome-axis'
import { ContextLists } from './context-lists'
import { AiAttemptSummary } from './ai-evidence'
import { RunMapClues } from '@/features/map/run-clues'
import { RunMapDecisions } from './map-decisions'
import { RunResolutionDecisions } from './resolution-decisions'
import { AiActionTracePanel } from './ai-action-trace'
import { AttemptEvidenceList } from './evidence-viewer'
import {
  formatDuration,
  STEP_RUN_STATUS_LABELS,
  stepRunStatusTone,
} from './labels'
import { StatusBadge } from '@/components/status-badge'

import { useResetOnChange } from '@/hooks/use-reset-on-change'
type Props = {
  run: RunDetailDto
  step: StepRunDto | undefined
  selectedAttemptId: string | null
  evidenceItems: EvidenceMetadata[]
  eventSeq?: number
  focusEvidenceId?: string
  onFocusEvidence?: (evidenceId: string) => void
}

export function StepInspector({
  run,
  step,
  selectedAttemptId,
  evidenceItems,
  eventSeq = 0,
  focusEvidenceId,
  onFocusEvidence,
}: Props) {
  const [activeTab, setActiveTab] = useState<'evidence' | 'outcome' | 'data' | 'debug'>('evidence')
  const setQuote = useAssistantStore((s) => s.setQuote)
  const openAssistant = useAssistantStore((s) => s.openPanel)

  // 当外部聚焦指定证据时，自动切至「诊断与证据」Tab
  useResetOnChange(focusEvidenceId, (id) => {
    if (id) setActiveTab('evidence')
  })

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
    ? evidenceItems.filter(
        (item) => item.attemptId === activeAttempt.id || (!item.attemptId && item.stepRunId === step.id)
      )
    : []

  const isFailed = step.status === 'FAILED' || activeAttempt?.status === 'FAILED'
  const errorInfo = activeAttempt?.error
  const diagnosis = isFailed && errorInfo ? translateStepError(errorInfo) : null
  const isAi = isAiStepType(step.type)

  const healedAttempt = step.attempts.find((a) => isAttemptHealed(a, evidenceItems))
  const isHealed = Boolean(healedAttempt) || isStepHealed(step, evidenceItems)
  const parentModule = run.snapshot.moduleManifest?.entries.find((e) =>
    e.expandedStepIds.includes(step.stepId),
  )

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

            {isHealed && (
              <Badge variant='outline' className='text-label border-primary/40 text-primary bg-primary/5 gap-1'>
                <Sparkles className='size-3 text-primary' />
                AI 救活
              </Badge>
            )}

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

      {/* AI 救活与受控修复候选提示横幅 */}
      {isHealed && (
        <div className='border-b border-border-divider p-3 bg-muted/10 shrink-0'>
          {parentModule ? (
            <div className='rounded-md border border-muted bg-muted/30 p-2.5 space-y-1.5 text-label'>
              <div className='flex items-center gap-2 font-medium text-foreground'>
                <Sparkles className='size-4 text-primary shrink-0' />
                <span>此步骤已在运行时由 AI 自愈策略成功救活</span>
              </div>
              <p className='text-muted-foreground'>
                该步骤属于动作模块 <span className='font-semibold text-foreground'>「{parentModule.name}」</span>。由模块定义纳管，请前往模块详情评估（不产生场景级草稿修复候选）。
              </p>
              {parentModule.moduleId && (
                <Button variant='outline' size='sm' asChild className='h-7 text-label gap-1 mt-1'>
                  <Link to='/action-modules/$moduleId' params={{ moduleId: parentModule.moduleId }}>
                    <ExternalLink className='size-3' />
                    前往动作模块详情
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <div className='rounded-md border border-primary/30 bg-primary/5 p-2.5 space-y-1.5 text-label'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2 font-medium text-primary'>
                  <Sparkles className='size-4 shrink-0' />
                  <span>运行时已成功自愈，已生成受控修复候选 (Heal → Repair)</span>
                </div>
                <Badge variant='secondary' className='text-label font-mono'>
                  受控修复
                </Badge>
              </div>
              <p className='text-muted-foreground'>
                {healerHypothesisOf(healedAttempt?.output) || '定位器已在运行时自动修正并救活执行。可前往场景编排草稿或维护中心受控采纳。'}
              </p>
              {run.scenarioId && (
                <div className='flex items-center gap-2 pt-0.5'>
                  <Button variant='default' size='sm' asChild className='h-7 text-label gap-1'>
                    <Link to='/scenarios/$scenarioId' params={{ scenarioId: run.scenarioId }}>
                      <ExternalLink className='size-3' />
                      前往场景采纳修复候选
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

          {/* B. 关键现场截图与证据 */}
          <div className='space-y-2.5'>
            <div className='flex items-center justify-between'>
              <h3 className='text-label font-semibold text-foreground flex items-center gap-1.5'>
                <ImageIcon className='size-3.5 text-primary' />
                <span>现场截图与证据清单</span>
              </h3>
              <span className='text-caption text-muted-foreground'>
                {attemptEvidences.length > 0 ? `共 ${attemptEvidences.length} 项证据` : '暂无证据'}
              </span>
            </div>

            {/* 步骤证据卡片列表（支持图片大图预览、Playwright Trace下载、日志技术详情） */}
            {attemptEvidences.length > 0 ? (
              <div className='pt-1'>
                <AttemptEvidenceList
                  runId={run.id}
                  items={attemptEvidences}
                  focusEvidenceId={focusEvidenceId}
                />
              </div>
            ) : (
              <div className='rounded-lg border border-border-card bg-muted/20 p-6 text-center text-label text-muted-foreground'>
                该步骤本次尝试未产生证据附件。
              </div>
            )}
          </div>

          {/* C. AI 执行摘要（若为 AI 步骤） */}
          {isAi && activeAttempt ? (
            <div className='rounded-md border border-ai-accent/30 bg-ai-background p-3 space-y-2'>
              <div className='flex items-center gap-1.5 text-ai-foreground font-medium text-label'>
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
              onFocusEvidence={(evidenceId) => {
                setActiveTab('evidence')
                onFocusEvidence?.(evidenceId)
              }}
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
            <RunResolutionDecisions runId={run.id} eventSeq={eventSeq} steps={run.stepRuns} resolution={run.snapshot.resolution} />
          </div>
        </div>
      </Tabs>
    </div>
  )
}
