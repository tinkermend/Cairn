import { useMemo } from 'react'
import type { AssistantConversation } from '@cairn/shared'
import {
  Clock,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAssistantStore } from '@/stores/assistant-store'
import { Button } from '@/components/ui/button'

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''

  const now = Date.now()
  const diffMs = now - d.getTime()
  const diffMinutes = Math.floor(diffMs / (60 * 1000))
  const diffHours = Math.floor(diffMs / (3600 * 1000))
  const diffDays = Math.floor(diffMs / (86400 * 1000))

  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  if (diffHours < 24) {
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${hours}:${mins}`
  }
  if (diffDays === 1) return '昨天'
  return `${diffDays} 天前`
}

export function groupConversationsByDate(items: AssistantConversation[]) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86400 * 1000

  const today: AssistantConversation[] = []
  const yesterday: AssistantConversation[] = []
  const earlier: AssistantConversation[] = []

  for (const item of items) {
    const t = new Date(item.updatedAt || item.createdAt).getTime()
    if (t >= startOfToday) {
      today.push(item)
    } else if (t >= startOfYesterday) {
      yesterday.push(item)
    } else {
      earlier.push(item)
    }
  }

  return [
    { label: '今天', items: today },
    { label: '昨天', items: yesterday },
    { label: '近 5 天内', items: earlier },
  ].filter((g) => g.items.length > 0)
}

export function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const conversations = useAssistantStore((state) => state.conversations)
  const currentConversationId = useAssistantStore((state) => state.conversationId)
  const historyLoading = useAssistantStore((state) => state.historyLoading)
  const switchConversation = useAssistantStore((state) => state.switchConversation)
  const newConversation = useAssistantStore((state) => state.newConversation)
  const deleteConversationLocally = useAssistantStore(
    (state) => state.deleteConversationLocally
  )

  const groups = useMemo(() => groupConversationsByDate(conversations), [conversations])

  const handleStartNew = () => {
    newConversation()
    onClose()
  }

  const handleSelect = (id: string) => {
    void switchConversation(id)
    onClose()
  }

  return (
    <div
      role='region'
      aria-label='会话历史抽屉'
      data-testid='assistant-history-drawer'
      className='absolute inset-0 z-20 flex flex-col bg-surface-card animate-in fade-in slide-in-from-right duration-150'
    >
      {/* 抽屉顶栏 */}
      <header className='flex shrink-0 items-center justify-between border-b border-border-default px-4 py-3'>
        <div className='flex items-center gap-2'>
          <History className='size-4 text-primary-600' aria-hidden='true' />
          <h3 className='text-body font-semibold text-text-primary'>会话历史</h3>
          <span className='rounded-full bg-surface-subtle px-2 py-0.5 text-label font-normal text-text-muted'>
            保留最近 5 天
          </span>
        </div>
        <div className='flex items-center gap-1'>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-7 text-text-muted hover:text-text-primary'
            aria-label='关闭历史列表'
            onClick={onClose}
          >
            <X className='size-4' aria-hidden='true' />
          </Button>
        </div>
      </header>

      {/* 快捷新建按钮 */}
      <div className='p-3 shrink-0 border-b border-border-default/60'>
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='w-full justify-center gap-2 border-dashed border-border-default bg-surface-subtle text-text-primary hover:border-primary-400 hover:text-primary-600 text-small font-medium'
          onClick={handleStartNew}
        >
          <Plus className='size-3.5' aria-hidden='true' />
          <span>开始新会话</span>
        </Button>
      </div>

      {/* 会话列表区域 */}
      <div className='flex-1 overflow-y-auto px-3 py-2 space-y-4'>
        {historyLoading && conversations.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-12 text-text-muted gap-2'>
            <Loader2 className='size-5 animate-spin text-primary-600' aria-hidden='true' />
            <span className='text-label'>加载历史会话中...</span>
          </div>
        ) : null}

        {!historyLoading && groups.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-16 text-center text-text-muted px-4 space-y-2'>
            <div className='flex size-10 items-center justify-center rounded-full bg-surface-subtle'>
              <Clock className='size-5 text-text-muted' aria-hidden='true' />
            </div>
            <p className='text-small font-medium text-text-primary'>暂无最近 5 天的会话记录</p>
            <p className='text-label text-text-muted'>
              发起新对话后，将在此保留最近 5 天的上下文记录供随时回溯。
            </p>
          </div>
        ) : null}

        {groups.map((group) => (
          <div key={group.label} className='space-y-1.5'>
            <div className='px-1.5 text-label font-medium text-text-muted'>
              {group.label}
            </div>
            <div className='space-y-1'>
              {group.items.map((conv) => {
                const isActive = conv.id === currentConversationId
                return (
                  <div
                    key={conv.id}
                    data-testid={`history-item-${conv.id}`}
                    className={cn(
                      'group relative flex items-center justify-between rounded-lg border px-3 py-2 text-start transition-colors cursor-pointer select-none',
                      isActive
                        ? 'border-primary-300 bg-primary-50/60 text-primary-950 font-medium'
                        : 'border-transparent bg-surface-card hover:bg-surface-subtle hover:border-border-default text-text-secondary hover:text-text-primary'
                    )}
                    onClick={() => handleSelect(conv.id)}
                  >
                    <div className='flex items-center gap-2 min-w-0 flex-1 pr-2'>
                      <MessageSquare
                        className={cn(
                          'size-3.5 shrink-0',
                          isActive ? 'text-primary-600' : 'text-text-muted group-hover:text-text-primary'
                        )}
                        aria-hidden='true'
                      />
                      <span className='truncate text-small leading-tight'>
                        {conv.title || '新会话'}
                      </span>
                    </div>

                    <div className='flex items-center gap-2 shrink-0'>
                      <span className='text-label text-text-muted tabular-nums'>
                        {formatRelativeTime(conv.updatedAt || conv.createdAt)}
                      </span>
                      <button
                        type='button'
                        data-testid={`delete-conv-${conv.id}`}
                        aria-label='删除此会话'
                        title='从本地列表中移除'
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteConversationLocally(conv.id)
                        }}
                        className='opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-status-error-foreground hover:bg-surface-subtle transition-opacity'
                      >
                        <Trash2 className='size-3.5' aria-hidden='true' />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 底部提示 */}
      <footer className='shrink-0 border-t border-border-default bg-surface-subtle px-4 py-2 text-center text-label text-text-muted'>
        仅保留最近 5 天内的活动记录，超期记录自动归档
      </footer>
    </div>
  )
}
