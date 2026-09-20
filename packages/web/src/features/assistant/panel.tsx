import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import type {
  AssistantCapabilityStatus,
  AssistantPageContext,
} from '@cairn/shared'
import {
  ArrowRight,
  ArrowUp,
  Compass,
  FileText,
  GripHorizontal,
  Loader2,
  ScanSearch,
  ShieldCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAssistantStore } from '@/stores/assistant-store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { assistantIcon } from './icon'
import { AssistantResultView } from './result'

function contextLabel(context: AssistantPageContext | null): string {
  if (!context) return '帮你理解场景、分析运行、找到功能入口'
  if (context.page === 'run' && context.runId)
    return `当前运行 · ${context.runId.slice(0, 8)}…`
  if (context.page === 'studio' && context.scenarioId) {
    return context.stepId
      ? `当前步骤 · ${context.stepId.slice(0, 8)}…`
      : `当前场景 · ${context.scenarioId.slice(0, 8)}…`
  }
  if (context.page === 'target' && context.targetId)
    return `当前目标 · ${context.targetId.slice(0, 8)}…`
  return '结合当前页面，为你提供帮助'
}

function shortcuts(
  items: AssistantCapabilityStatus[] | undefined,
  page: AssistantPageContext | null
) {
  const available = new Set(
    (items ?? []).filter((item) => item.available).map((item) => item.id)
  )
  const options: {
    question: string
    description: string
    icon: typeof Compass
    hint: AssistantCapabilityStatus['id']
  }[] = []
  if (page?.page === 'run' && available.has('run.diagnose')) {
    options.push({
      question: '这次为什么失败？',
      description: '结合运行事实，查看原因和下一步建议',
      icon: ScanSearch,
      hint: 'run.diagnose',
    })
  }
  if (page?.page === 'studio' && available.has('scenario.explain')) {
    options.push({
      question: '这个场景在做什么？',
      description: '梳理步骤意图，理解当前场景的执行逻辑',
      icon: FileText,
      hint: 'scenario.explain',
    })
  }
  if (available.has('platform.guide')) {
    options.push({
      question: '在哪里配置目标账号？',
      description: '找到目标系统与账号的管理入口',
      icon: Compass,
      hint: 'platform.guide',
    })
  }
  return options
}

export function AssistantPanel({
  onClose,
  dragHandleProps,
}: {
  onClose: () => void
  dragHandleProps: HTMLAttributes<HTMLElement>
}) {
  const question = useAssistantStore((state) => state.question)
  const turns = useAssistantStore((state) => state.turns)
  const busy = useAssistantStore((state) => state.busy)
  const error = useAssistantStore((state) => state.error)
  const pageContext = useAssistantStore((state) => state.pageContext)
  const capabilities = useAssistantStore((state) => state.capabilities)
  const adoptHandler = useAssistantStore((state) => state.adoptHandler)
  const setQuestion = useAssistantStore((state) => state.setQuestion)
  const openPanel = useAssistantStore((state) => state.openPanel)
  const submit = useAssistantStore((state) => state.submit)
  const cancel = useAssistantStore((state) => state.cancel)
  const loadCapabilities = useAssistantStore((state) => state.loadCapabilities)
  const [adopting, setAdopting] = useState(false)
  const conversationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadCapabilities().catch(() => undefined)
  }, [loadCapabilities])

  useEffect(() => {
    const conversation = conversationRef.current
    if (conversation) conversation.scrollTop = conversation.scrollHeight
  }, [turns, busy])

  const hints = shortcuts(capabilities?.items, pageContext)

  return (
    <section className='flex h-full min-h-0 w-full flex-col bg-card text-body'>
      <header
        {...dragHandleProps}
        className='flex shrink-0 cursor-grab touch-none items-center gap-3 border-b border-border px-4 py-3 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset active:cursor-grabbing'
      >
        <img
          {...assistantIcon}
          sizes='36px'
          alt=''
          className='pointer-events-none size-9 shrink-0 object-contain'
          width={36}
          height={36}
        />
        <div className='min-w-0 flex-1 space-y-1'>
          <h2
            id='assistant-window-title'
            className='flex items-center gap-2 text-body font-semibold'
          >
            识途助手
            <GripHorizontal
              className='size-4 text-muted-foreground'
              aria-hidden='true'
            />
          </h2>
          <p
            id='assistant-window-description'
            className='text-label text-muted-foreground'
          >
            {contextLabel(pageContext)}
          </p>
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='size-11'
          aria-label='关闭识途助手'
          onClick={onClose}
        >
          <X aria-hidden='true' />
        </Button>
      </header>
      <div
        ref={conversationRef}
        className='flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-5'
        aria-label='助手对话'
      >
        {turns.length === 0 && !busy ? (
          <div className='my-auto py-3'>
            <h3 className='text-section font-semibold'>有什么可以帮你？</h3>
            <p className='mt-2 text-body text-muted-foreground'>
              {hints.length > 0
                ? '直接描述你的问题，或从下面开始。'
                : '描述你遇到的问题，我会根据当前页面提供帮助。'}
            </p>
            {hints.length > 0 ? (
              <div className='mt-5 space-y-2'>
                {hints.map((item) => (
                  <Button
                    key={item.question}
                    type='button'
                    variant='outline'
                    className='h-auto min-h-16 w-full justify-start gap-3 rounded-lg px-4 py-3 text-start whitespace-normal shadow-none'
                    onClick={() => {
                      openPanel({
                        question: item.question,
                        capabilityHint: item.hint,
                        pageContext: pageContext ?? undefined,
                      })
                      void submit()
                    }}
                  >
                    <span className='flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-primary'>
                      <item.icon className='size-4' aria-hidden='true' />
                    </span>
                    <span className='min-w-0 flex-1'>
                      <span className='block text-body font-medium'>
                        {item.question}
                      </span>
                      <span className='mt-1 block text-label font-normal text-muted-foreground'>
                        {item.description}
                      </span>
                    </span>
                    <ArrowRight
                      className='size-4 text-muted-foreground'
                      aria-hidden='true'
                    />
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className='space-y-6 [overflow-wrap:anywhere]'>
          {turns
            .slice()
            .reverse()
            .map((turn) => (
              <article key={turn.id} className='space-y-4'>
                <div className='flex justify-end'>
                  <p className='max-w-[90%] rounded-lg bg-secondary px-4 py-3 whitespace-pre-wrap'>
                    <span className='sr-only'>你：</span>
                    {turn.question}
                  </p>
                </div>
                <div className='space-y-2'>
                  <p className='text-label font-medium text-muted-foreground'>
                    识途助手
                  </p>
                  {turn.result ? (
                    <AssistantResultView
                      result={turn.result}
                      adopting={adopting}
                      onNavigate={onClose}
                      onClarify={(optionId) => {
                        openPanel({
                          question: turn.question,
                          capabilityHint:
                            optionId as AssistantCapabilityStatus['id'],
                          pageContext: pageContext ?? undefined,
                        })
                        void submit()
                      }}
                      onAdopt={
                        turn.result.kind === 'proposal'
                          ? async (proposal) => {
                              if (!adoptHandler) {
                                toast.error('请先打开对应场景工作区再采纳')
                                return
                              }
                              setAdopting(true)
                              try {
                                const adopted = await adoptHandler(proposal)
                                if (adopted.ok) {
                                  toast.success('已放入本地草稿，尚未保存')
                                  onClose()
                                } else toast.error(adopted.reason)
                              } finally {
                                setAdopting(false)
                              }
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <p className='text-label text-muted-foreground'>
                      {turn.status === 'RUNNING' ? '正在处理' : turn.status}
                    </p>
                  )}
                </div>
              </article>
            ))}
          {busy ? (
            <div className='space-y-4'>
              <div className='flex justify-end'>
                <p className='max-w-[90%] rounded-lg bg-secondary px-4 py-3 whitespace-pre-wrap'>
                  {question}
                </p>
              </div>
              <p
                role='status'
                className='flex items-center gap-2 text-label text-muted-foreground'
              >
                <Loader2
                  className='size-4 animate-spin motion-reduce:animate-none'
                  aria-hidden='true'
                />
                正在分析，请稍候…
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <form
        className='shrink-0 space-y-3 border-t border-border px-4 py-3'
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {capabilities && !capabilities.modelEnabled ? (
          <p className='text-label text-muted-foreground'>
            控制台助手未启用，仍可使用功能导览与运行事实诊断。
          </p>
        ) : null}
        {error ? (
          <p role='alert' className='text-label text-destructive'>
            {error}
          </p>
        ) : null}
        <label className='sr-only' htmlFor='assistant-question'>
          向助手提问
        </label>
        <Textarea
          id='assistant-question'
          className='max-h-32 min-h-20 resize-none'
          value={question}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
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
          placeholder='问问识途，或描述你遇到的问题…'
        />
        <div className='flex items-center justify-between gap-3'>
          <p
            id='assistant-input-help'
            className='text-label text-muted-foreground'
          >
            <span className='flex items-center gap-1.5'>
              <ShieldCheck className='size-3.5 shrink-0' aria-hidden='true' />
              仅使用你已有的访问权限
            </span>
            <span className='mt-1 hidden sm:block'>
              Enter 发送 · Shift + Enter 换行
            </span>
          </p>
          <div className='flex shrink-0 gap-2'>
            {busy ? (
              <Button
                type='button'
                variant='outline'
                className='h-11'
                onClick={cancel}
              >
                停止
              </Button>
            ) : null}
            <Button
              type='submit'
              className='h-11'
              disabled={busy || question.trim().length === 0}
              loading={busy}
            >
              发送
              <ArrowUp aria-hidden='true' />
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}
