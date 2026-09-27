import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import type {
  AssistantCapabilityId,
  AssistantCapabilitiesResponse,
  AssistantPageContext,
  AssistantStage,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowUp,
  FileCode,
  GripHorizontal,
  History,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  Sparkles,
  SquarePen,
  X,
} from 'lucide-react'
import { useCan } from '@/hooks/use-permissions'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { useAssistantStore, type AssistantBoundContext } from '@/stores/assistant-store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { assistantIcon } from './icon'
import { AssistantResultView } from './result'
import { MiniRunTracker } from './mini-run-tracker'
import { PromptCards } from './prompt-cards'
import { HistoryDrawer } from './history-drawer'
import { ThinkingProcessBlock } from './components/thinking-process'

function contextLabel(context: AssistantPageContext | null): string {
  if (!context) return '全局上下文 · 识途通用助理'
  if (context.page === 'run' && context.runId)
    return `当前运行 · #${context.runId.slice(0, 8)}`
  if (context.page === 'studio' && context.scenarioId) {
    return context.stepId
      ? '当前场景 · 正在聚焦步骤'
      : '当前场景编排'
  }
  if (context.page === 'target' && context.targetId)
    return '当前目标'
  return '当前页面'
}

function ContextCapsule({
  boundContext,
  capabilities,
  onChipClick,
}: {
  boundContext: AssistantBoundContext | null
  capabilities: AssistantCapabilitiesResponse | null
  onChipClick: (question: string, capabilityHint?: AssistantCapabilityId) => void
}) {
  const canAssist = useCan('ai:assist')
  const canWrite = useCan('workflow:write')

  // 仅在存在实体绑定且有实质性业务信息时才展示次级胶囊：
  // 1. 存在具体实体 ID (entityId)
  // 2. 或处于报错诊断状态 (statusTone === 'error')
  // 3. 或存在未保存本地草稿 (isDirty)
  // 4. 或带有专属操作推荐 Chips
  // 普通列表页无实体聚焦的通用描述（如“运行记录与执行历史列表”）不作为次级胶囊展示，避免重复废话
  const hasSubstantiveDetail =
    Boolean(boundContext?.entityId) ||
    Boolean(boundContext?.isDirty) ||
    boundContext?.statusTone === 'error' ||
    Boolean(boundContext?.chips && boundContext.chips.length > 0)

  if (!boundContext || !hasSubstantiveDetail) {
    return null
  }

  const chips = (boundContext.chips ?? []).filter((chip) => {
    if (chip.capabilityHint === 'scenario.propose-step' && !canWrite) return false
    return true
  })

  return (
    <div
      role='region'
      aria-label='上下文详情与操作'
      className='shrink-0 border-b border-border-default bg-surface-subtle px-4 py-2.5 space-y-2'
    >
      {boundContext.summaryText ? (
        <p className='text-label text-text-secondary line-clamp-2 leading-relaxed'>
          {boundContext.summaryText}
        </p>
      ) : null}
      {chips.length > 0 && capabilities?.modelEnabled && canAssist ? (
        <div className='flex flex-wrap gap-1.5 pt-0.5'>
          {chips.map((chip) => (
            <button
              key={chip.label}
              type='button'
              onClick={() => onChipClick(chip.question, chip.capabilityHint)}
              className='inline-flex items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-2.5 py-1 text-label text-text-secondary shadow-2xs transition-colors hover:border-primary-400 hover:text-text-primary'
            >
              <Sparkles className='size-3 text-primary-600' aria-hidden='true' />
              <span>{chip.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AssistantPanel({
  onClose,
  dragHandleProps,
  isDocked = false,
}: {
  onClose: () => void
  dragHandleProps: HTMLAttributes<HTMLElement>
  isDocked?: boolean
}) {
  const question = useAssistantStore((state) => state.question)
  const turns = useAssistantStore((state) => state.turns)
  const busy = useAssistantStore((state) => state.busy)
  const cancelling = useAssistantStore((state) => state.cancelling)
  const error = useAssistantStore((state) => state.error)
  const navigate = useNavigate()
  const activeStage = useAssistantStore((state) => state.activeStage)
  const activeQueuePosition = useAssistantStore((state) => state.activeQueuePosition)
  const activeTurnId = useAssistantStore((state) => state.activeTurnId)
  const thinkingText = useAssistantStore((state) => state.thinkingText)
  const pageContext = useAssistantStore((state) => state.pageContext)
  const capabilities = useAssistantStore((state) => state.capabilities)
  const adoptHandler = useAssistantStore((state) => state.adoptHandler)
  const rollbackHandler = useAssistantStore((state) => state.rollbackHandler)
  const lastAdoptedProposalId = useAssistantStore(
    (state) => state.lastAdoptedProposalId,
  )
  const setLastAdopted = useAssistantStore((state) => state.setLastAdopted)
  const setPreviewStepId = useAssistantStore((state) => state.setPreviewStepId)
  const mode = useAssistantStore((state) => state.mode)
  const activeQuote = useAssistantStore((state) => state.activeQuote)
  const boundContext = useAssistantStore((state) => state.boundContext)
  const routeContext = useAssistantStore((state) => state.routeContext)
  const effectiveBoundContext = boundContext ?? routeContext
  const newConversation = useAssistantStore((state) => state.newConversation)
  const historyOpen = useAssistantStore((state) => state.historyOpen)
  const setHistoryOpen = useAssistantStore((state) => state.setHistoryOpen)

  const setQuestion = useAssistantStore((state) => state.setQuestion)
  const openPanel = useAssistantStore((state) => state.openPanel)
  const submit = useAssistantStore((state) => state.submit)
  const cancel = useAssistantStore((state) => state.cancel)
  const cancelCurrentTask = useAssistantStore((state) => state.cancelCurrentTask)
  const toggleMode = useAssistantStore((state) => state.toggleMode)
  const clearQuote = useAssistantStore((state) => state.clearQuote)
  const loadCapabilities = useAssistantStore((state) => state.loadCapabilities)

  const [adopting, setAdopting] = useState(false)
  const [capabilitiesLoadError, setCapabilitiesLoadError] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadCapabilities().catch(() => setCapabilitiesLoadError(true))
  }, [loadCapabilities])

  useEffect(() => {
    const conversation = conversationRef.current
    if (conversation) conversation.scrollTop = conversation.scrollHeight
  }, [turns, busy])

  const handlePromptSelect = (q: string, capabilityHint?: AssistantCapabilityId) => {
    if (!capabilities?.modelEnabled) return
    if (!question.trim()) {
      openPanel({
        question: q,
        capabilityHint,
        pageContext: pageContext ?? undefined,
      })
      void submit()
    } else {
      setQuestion(`${question}\n${q}`.trim())
    }
  }

  const isGlobal = !effectiveBoundContext && !pageContext
  const isErrorTone = effectiveBoundContext?.statusTone === 'error'
  const dotColor = isErrorTone ? 'bg-status-error-foreground' : 'bg-status-success-accent'
  const pingColor = isErrorTone ? 'bg-status-error-foreground' : 'bg-status-success-accent/70'

  const statusLabel =
    effectiveBoundContext?.statusLabel ??
    (pageContext ? contextLabel(pageContext) : '全局上下文 · 识途通用助理')

  return (
    <section className='@container relative flex h-full min-h-0 w-full flex-col bg-surface-card text-body'>
      {historyOpen ? <HistoryDrawer onClose={() => setHistoryOpen(false)} /> : null}

      <header
        {...(isDocked ? {} : dragHandleProps)}
        className={cn(
          'flex shrink-0 items-center gap-3 border-b border-border-default px-4 py-3 select-none',
          !isDocked &&
            'cursor-grab touch-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
        )}
      >
        <img
          {...assistantIcon}
          sizes='36px'
          alt=''
          className='pointer-events-none size-9 shrink-0 object-contain'
          width={36}
          height={36}
        />
        <div className='min-w-0 flex-1 space-y-0.5'>
          <h2
            id='assistant-window-title'
            className='flex items-center gap-2 text-body font-semibold text-text-primary'
          >
            识途助手
            {!isDocked ? (
              <GripHorizontal
                className='size-4 text-text-muted'
                aria-hidden='true'
              />
            ) : null}
          </h2>
          <div
            id='assistant-window-description'
            data-testid='context-capsule'
            className='flex items-center gap-1.5 min-w-0'
          >
            <span
              className='relative flex size-2 shrink-0 items-center justify-center'
              aria-hidden='true'
            >
              <span
                className={cn(
                  'absolute inline-flex size-full animate-subtle-ping rounded-full',
                  pingColor,
                )}
              />
              <span className={cn('relative inline-flex size-1.5 rounded-full', dotColor)} />
            </span>
            <span className='text-label font-medium text-text-secondary truncate'>
              {statusLabel}
            </span>
            {isGlobal ? (
              <span className='text-label text-text-muted hidden sm:inline truncate font-normal'>
                · 帮你理解场景、分析运行、找到功能入口
              </span>
            ) : null}
            {boundContext?.isDirty ? (
              <span
                data-testid='dirty-draft-badge'
                className='inline-flex items-center gap-1 rounded bg-status-warning-subtle text-status-warning-foreground border border-status-warning-border px-1.5 py-0.5 text-small font-medium shrink-0'
              >
                <AlertTriangle className='size-2.5 shrink-0' aria-hidden='true' />
                存在未保存草稿
              </span>
            ) : null}
            {boundContext?.entityId ? (
              <span
                className='text-label text-text-muted ms-auto font-mono opacity-60 hover:opacity-100 transition-opacity shrink-0'
                title={`内部实体 ID: ${boundContext.entityId}`}
              >
                #{boundContext.entityId.slice(0, 8)}
              </span>
            ) : null}
          </div>
        </div>
        <div className='flex items-center gap-1'>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-8 text-text-muted hover:text-text-primary'
            aria-label='新建会话'
            title='新建会话'
            onClick={newConversation}
            data-testid='assistant-new-chat-btn'
          >
            <SquarePen className='size-4' aria-hidden='true' />
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className={cn(
              'size-8 text-text-muted hover:text-text-primary',
              historyOpen && 'bg-surface-subtle text-primary-600'
            )}
            aria-label='会话历史'
            title='会话历史'
            onClick={() => setHistoryOpen(!historyOpen)}
            data-testid='assistant-history-btn'
          >
            <History className='size-4' aria-hidden='true' />
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-8 text-text-muted hover:text-text-primary'
            aria-label={mode === 'docked' ? '恢复悬浮窗' : '停靠到右侧边栏'}
            title={mode === 'docked' ? '恢复悬浮窗' : '停靠到右侧边栏'}
            onClick={toggleMode}
            data-testid='assistant-dock-toggle'
          >
            {mode === 'docked' ? (
              <PanelRightClose className='size-4' aria-hidden='true' />
            ) : (
              <PanelRightOpen className='size-4' aria-hidden='true' />
            )}
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-8 text-text-muted hover:text-text-primary'
            aria-label='关闭识途助手'
            onClick={onClose}
          >
            <X aria-hidden='true' className='size-4' />
          </Button>
        </div>
      </header>

      {/* 仅在具体业务实体绑定 (boundContext) 且含有错误/诊断或实体摘要时渲染 */}
      <ContextCapsule
        boundContext={boundContext}
        capabilities={capabilities}
        onChipClick={handlePromptSelect}
      />

      <div
        ref={conversationRef}
        className='flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-4'
        aria-label='助手对话'
      >
        {turns.length === 0 && !busy && capabilities?.modelEnabled ? (
          <PromptCards
            pageContext={pageContext}
            boundContext={effectiveBoundContext}
            capabilities={capabilities}
            onSelectPrompt={handlePromptSelect}
          />
        ) : null}
        {turns.length === 0 && !busy && !capabilities && (
          <div className='my-auto text-center text-label text-text-muted'>
            {capabilitiesLoadError ? (
              <>
                <p>助手能力暂时无法加载。</p>
                <Button type='button' variant='ghost' size='sm' onClick={() => {
                  setCapabilitiesLoadError(false)
                  void loadCapabilities().catch(() => setCapabilitiesLoadError(true))
                }}>
                  重试
                </Button>
              </>
            ) : '正在加载助手能力…'}
          </div>
        )}
        <div className='space-y-5 [overflow-wrap:anywhere]'>
          {turns
            .slice()
            .reverse()
            .map((turn) => {
              const isCurrentTurnLive =
                (turn.id === activeTurnId && busy) ||
                (busy && (turn.status === 'RUNNING' || turn.status === 'QUEUED'))

              return (
                <article key={turn.id} className='space-y-3.5'>
                  <div className='flex justify-end'>
                    <p className='max-w-[85%] rounded-2xl rounded-tr-xs bg-primary-100 px-3.5 py-2.5 text-body text-text-primary shadow-2xs whitespace-pre-wrap leading-relaxed'>
                      <span className='sr-only'>你：</span>
                      {turn.question}
                    </p>
                  </div>
                  <div className='space-y-2'>
                    <p data-testid='turn-assistant-author' className='text-label font-medium text-text-muted'>
                      识途助手
                    </p>
                    {isCurrentTurnLive ? (
                      <ThinkingProcessBlock
                        stage={activeStage ?? (turn.stage as AssistantStage | 'queued')}
                        queuePosition={activeQueuePosition ?? turn.queuePosition}
                        thinkingText={thinkingText || turn.thinkingText}
                        isLive={true}
                        onCancel={() => void cancel()}
                      />
                    ) : (
                      <>
                        {turn.thinkingDurationMs || turn.thinkingText ? (
                          <ThinkingProcessBlock
                            thinkingText={turn.thinkingText}
                            thinkingDurationMs={turn.thinkingDurationMs}
                            isLive={false}
                          />
                        ) : null}
                        {turn.result ? (
                          <AssistantResultView
                            result={turn.result}
                            adopting={adopting}
                            onNavigate={onClose}
                            onPreviewStep={
                              turn.result.kind === 'authoring_proposal' ||
                              boundContext?.scenarioId ||
                              pageContext?.scenarioId
                                ? (stepId) => {
                                    const targetScenarioId =
                                      (turn.result?.kind === 'authoring_proposal'
                                        ? turn.result.scenarioId
                                        : undefined) ??
                                      boundContext?.scenarioId ??
                                      pageContext?.scenarioId
                                    if (targetScenarioId && pageContext?.page !== 'studio') {
                                      navigate({
                                        to: '/scenarios/$scenarioId',
                                        params: { scenarioId: targetScenarioId },
                                        search: { action: 'inspect-step', step_id: stepId },
                                      })
                                    } else {
                                      setPreviewStepId(stepId)
                                    }
                                  }
                                : undefined
                            }
                            isAdopted={
                              (turn.result.kind === 'authoring_proposal' &&
                                lastAdoptedProposalId === turn.result.proposalId) ||
                              (turn.result.kind === 'proposal' &&
                                lastAdoptedProposalId === turn.result.stepId)
                            }
                            onClarify={(optionId, option) => {
                              if (option?.kind === 'scenario') {
                                openPanel({
                                  question: option?.label ?? optionId,
                                  pageContext: pageContext ?? undefined,
                                })
                                void submit({ selectedOptionId: optionId, replyToTurnId: turn.id })
                              } else {
                                openPanel({
                                  question: turn.question,
                                  capabilityHint: optionId as AssistantCapabilityId,
                                  pageContext: pageContext ?? undefined,
                                })
                                void submit({ selectedOptionId: optionId, replyToTurnId: turn.id })
                              }
                            }}
                            onCancelTask={() => {
                              void cancelCurrentTask(turn.id)
                            }}
                            onNextPage={() => {
                              openPanel({
                                question: '下一页',
                                capabilityHint: 'scenario.discover',
                                pageContext: pageContext ?? undefined,
                              })
                              void submit({ replyToTurnId: turn.id })
                            }}
                            onAdopt={
                              turn.result.kind === 'authoring_proposal' || turn.result.kind === 'proposal'
                                ? async (proposal) => {
                                    if (!adoptHandler) {
                                      toast.error('请先打开对应场景工作区再采纳')
                                      return
                                    }
                                    setAdopting(true)
                                    try {
                                      const adopted = await adoptHandler(proposal)
                                      if (adopted.ok) {
                                        const proposalId =
                                          'proposalId' in proposal ? proposal.proposalId : proposal.stepId
                                        setLastAdopted({ proposalId, digest: adopted.digest ?? '' })
                                        toast.success('已放入本地草稿，尚未保存')
                                      } else {
                                        toast.error(adopted.reason || '采纳失败')
                                      }
                                    } finally {
                                      setAdopting(false)
                                    }
                                  }
                                : undefined
                            }
                            onRollback={
                              (turn.result.kind === 'authoring_proposal' ||
                                turn.result.kind === 'proposal') &&
                              rollbackHandler
                                ? async (proposal) => {
                                    const res = await rollbackHandler(proposal)
                                    if (res.ok) {
                                      setLastAdopted(null)
                                      toast.success('已撤销本次采纳')
                                    } else {
                                      toast.error(res.reason || '撤销失败')
                                    }
                                  }
                                : undefined
                            }
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          {busy &&
          !turns.some(
            (turn) =>
              turn.id === activeTurnId || turn.status === 'RUNNING' || turn.status === 'QUEUED',
          ) ? (
            <div className='space-y-2'>
              <p data-testid='turn-assistant-author' className='text-label font-medium text-text-muted'>
                识途助手
              </p>
              <ThinkingProcessBlock
                stage={activeStage}
                queuePosition={activeQueuePosition}
                thinkingText={thinkingText}
                isLive={true}
                onCancel={() => void cancel()}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* 微型运行监控坞 */}
      <MiniRunTracker />

      <form
        className='shrink-0 space-y-2.5 border-t border-border-default px-4 py-3'
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {capabilities && !capabilities.modelEnabled ? (
          <div
            data-testid='model-disabled-banner'
            className='flex items-center gap-1.5 rounded-md border border-status-warning-border/40 bg-status-warning-background/20 px-2.5 py-1.5 text-label text-status-warning-foreground'
          >
            <AlertTriangle className='size-3.5 shrink-0 text-status-warning-foreground' aria-hidden='true' />
            <span>平台 AI 尚未启用或未配置模型。请在平台配置中接入模型提供商后使用助手。</span>
          </div>
        ) : null}
        {error ? (
          <p role='alert' className='text-label text-status-error-foreground'>
            {error}
          </p>
        ) : null}
        {boundContext?.isDirty ? (
          <p className='text-label text-status-warning-foreground'>
            当前有未保存修改。助手会依据已保存版本回答；要分析刚才的编辑，请先保存草稿。
          </p>
        ) : null}

        {/* 选区与对象 Quote 药丸标签 */}
        {activeQuote ? (
          <div
            role='group'
            aria-label={`引用目标: ${activeQuote.title}`}
            data-testid='quote-pill'
            className='flex items-center justify-between gap-2 rounded-lg border border-primary-100 bg-primary-50 px-3 py-1.5 text-label'
          >
            <div className='flex items-center gap-2 min-w-0'>
              {activeQuote.type === 'step_failure' ? (
                <AlertTriangle className='size-3.5 shrink-0 text-status-error-foreground' aria-hidden='true' />
              ) : (
                <FileCode className='size-3.5 shrink-0 text-primary-600' aria-hidden='true' />
              )}
              <span className='font-medium text-text-primary truncate'>
                {activeQuote.title}
              </span>
              {activeQuote.summary ? (
                <span className='hidden sm:inline text-text-muted truncate max-w-[220px]'>
                  — {activeQuote.summary}
                </span>
              ) : null}
            </div>
            <Button
              type='button'
              variant='ghost'
              size='icon'
              className='size-5 text-text-muted hover:text-text-primary'
              onClick={clearQuote}
              aria-label='移除引用'
            >
              <X className='size-3' aria-hidden='true' />
            </Button>
          </div>
        ) : null}

        <label className='sr-only' htmlFor='assistant-question'>
          向助手提问
        </label>
        <Textarea
          id='assistant-question'
          className='max-h-28 min-h-11 resize-none py-2 text-body leading-relaxed'
          value={question}
          disabled={busy || (capabilities !== null && !capabilities.modelEnabled)}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Backspace' &&
              !question &&
              activeQuote
            ) {
              clearQuote()
              return
            }
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault()
              void submit()
            }
          }}
          aria-describedby='assistant-input-help'
          placeholder={
            capabilities !== null && !capabilities.modelEnabled
              ? '平台 AI 未启用，暂不支持提问…'
              : activeQuote
                ? '针对选中的对象提问（按 Backspace 可取消引用）…'
                : '问问识途，或描述你遇到的问题…'
          }
        />
        <div className='flex items-center justify-between gap-3 pt-0.5'>
          <p
            id='assistant-input-help'
            className='text-label text-text-muted'
          >
            <span className='flex items-center gap-1.5'>
              <ShieldCheck className='size-3.5 shrink-0' aria-hidden='true' />
              仅使用你已有的访问权限
            </span>
            <span className='mt-0.5 hidden sm:block'>
              Enter 发送 · Shift + Enter 换行
            </span>
          </p>
          <div className='flex shrink-0 gap-2'>
            {busy ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='h-8 text-label px-3'
                onClick={() => void cancel()}
                disabled={cancelling}
                loading={cancelling}
              >
                {cancelling ? '正在停止' : '停止'}
              </Button>
            ) : null}
            <Button
              type='submit'
              size='sm'
              className='h-8 text-label px-3.5 gap-1.5'
              disabled={busy || (capabilities !== null && !capabilities.modelEnabled) || question.trim().length === 0}
              loading={busy}
            >
              发送
              <ArrowUp className='size-3.5' aria-hidden='true' />
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}
