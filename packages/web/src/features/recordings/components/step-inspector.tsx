import { useState } from 'react'
import type { RecordingEvent, RecordingItem } from '@cairn/shared'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Props = {
  item: RecordingItem | undefined
  totalCount: number
  events: RecordingEvent[]
  onPrev: () => void
  onNext: () => void
  hasPrev: boolean
  hasNext: boolean
}

export function RecordingStepInspector({
  item,
  totalCount,
  events,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  const [viewMode, setViewMode] = useState<'structured' | 'json'>('structured')
  const [copiedSelector, setCopiedSelector] = useState(false)
  const [copiedJson, setCopiedJson] = useState(false)

  if (!item) {
    return (
      <div className='flex h-64 items-center justify-center rounded-lg border border-border-card bg-card p-6 text-center shadow-card'>
        <p className='text-body text-muted-foreground'>请在左侧选择一个步骤以查看深度详情</p>
      </div>
    )
  }

  // 提取原始关联事件
  const relatedEvents = item.sourceIndexes
    .map((idx) => (idx >= 0 && idx < events.length ? events[idx] : null))
    .filter((e): e is RecordingEvent => e !== null)

  const inputObj = item.input && typeof item.input === 'object' ? (item.input as Record<string, unknown>) : null
  const selector = typeof inputObj?.selector === 'string' ? inputObj.selector : null

  const handleCopySelector = () => {
    if (!selector) return
    void navigator.clipboard.writeText(selector)
    setCopiedSelector(true)
    toast.success('选择器已复制到剪贴板')
    setTimeout(() => setCopiedSelector(false), 2000)
  }

  const handleCopyJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(item, null, 2))
    setCopiedJson(true)
    toast.success('步骤完整 JSON 已复制')
    setTimeout(() => setCopiedJson(false), 2000)
  }

  return (
    <div className='flex flex-col gap-3 rounded-lg border border-border-card bg-card p-4 shadow-card'>
      {/* 头部：序号、标题与快捷导航 */}
      <div className='flex items-start justify-between gap-2 border-b border-border-divider pb-3'>
        <div className='min-w-0 flex-1 space-y-1'>
          <div className='flex items-center gap-2'>
            <span className='text-label font-semibold text-primary uppercase tracking-wider'>
              步骤 {String(item.index + 1).padStart(2, '0')} / {totalCount}
            </span>
            <StatusBadge tone={item.status === 'mapped' ? 'success' : item.status === 'parameterized' ? 'warning' : 'neutral'}>
              {item.status === 'mapped' ? '可直接导入' : item.status === 'parameterized' ? '需补参数' : '待处理'}
            </StatusBadge>
          </div>
          <h3 className='text-body font-semibold text-foreground truncate' title={item.name}>
            {item.name}
          </h3>
        </div>

        {/* 上一步/下一步导航按钮 */}
        <div className='flex items-center gap-1 shrink-0'>
          <Button
            size='icon'
            variant='outline'
            className='size-7'
            disabled={!hasPrev}
            onClick={onPrev}
            title='上一步 (↑)'
            aria-label='上一步'
          >
            <ChevronUp className='size-4' />
          </Button>
          <Button
            size='icon'
            variant='outline'
            className='size-7'
            disabled={!hasNext}
            onClick={onNext}
            title='下一步 (↓)'
            aria-label='下一步'
          >
            <ChevronDown className='size-4' />
          </Button>
        </div>
      </div>

      {/* 安全与诊断提示（若有） */}
      {item.sensitive ? (
        <div className='flex items-start gap-2.5 rounded-md border border-status-warning-foreground/30 bg-status-warning-background p-2.5 text-label text-status-warning-foreground'>
          <KeyRound className='size-4 shrink-0 mt-0.5' />
          <div className='space-y-0.5'>
            <p className='font-medium'>敏感数据已自动保护</p>
            <p className='text-label opacity-90'>
              录制器已从操作中排除敏感凭据明文。回填到场景时，请使用场景全局输入变量或绑定目标系统 Secret。
            </p>
          </div>
        </div>
      ) : null}

      {item.diagnostics.length > 0 ? (
        <div className='flex items-start gap-2.5 rounded-md border border-status-warning-foreground/30 bg-status-warning-background/60 p-2.5 text-label text-status-warning-foreground'>
          <AlertCircle className='size-4 shrink-0 mt-0.5' />
          <div className='space-y-0.5'>
            <p className='font-medium'>规整警告 ({item.diagnostics.length} 项)</p>
            <ul className='list-disc pl-4 space-y-0.5 text-label'>
              {item.diagnostics.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {/* 选项卡：步骤预览 / 定位与上下文 / 原始事件溯源 */}
      <Tabs defaultValue='preview' className='w-full'>
        <TabsList className='grid w-full grid-cols-3 h-8'>
          <TabsTrigger value='preview' className='text-label'>候选步骤</TabsTrigger>
          <TabsTrigger value='locator' className='text-label'>定位与环境</TabsTrigger>
          <TabsTrigger value='events' className='text-label'>原始事件 ({relatedEvents.length})</TabsTrigger>
        </TabsList>

        {/* Tab 1: 候选步骤预览 */}
        <TabsContent value='preview' className='mt-3 space-y-3'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-label text-muted-foreground'>目标 DSL 类型:</span>
              <code className='rounded bg-primary-100 px-1.5 py-0.5 text-label font-mono font-semibold text-primary-700'>
                {item.candidateStepType ?? '未映射 (unresolved)'}
              </code>
            </div>
            <div className='flex items-center gap-1'>
              <Button
                size='sm'
                variant={viewMode === 'structured' ? 'secondary' : 'ghost'}
                className='h-6 px-2 text-label'
                onClick={() => setViewMode('structured')}
              >
                结构化
              </Button>
              <Button
                size='sm'
                variant={viewMode === 'json' ? 'secondary' : 'ghost'}
                className='h-6 px-2 text-label'
                onClick={() => setViewMode('json')}
              >
                JSON
              </Button>
            </div>
          </div>

          {viewMode === 'structured' ? (
            <div className='space-y-2.5'>
              {selector ? (
                <div className='rounded-md border border-border-card bg-surface-subtle p-2.5'>
                  <div className='flex items-center justify-between text-label text-muted-foreground pb-1'>
                    <span>目标元素选择器 (Selector)</span>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-5 px-1.5 text-label gap-1 text-primary'
                      onClick={handleCopySelector}
                    >
                      {copiedSelector ? <Check className='size-3' /> : <Copy className='size-3' />}
                      {copiedSelector ? '已复制' : '复制'}
                    </Button>
                  </div>
                  <code className='block text-label font-mono font-medium text-foreground break-all selection:bg-primary-100'>
                    {selector}
                  </code>
                </div>
              ) : null}

              {/* 其余参数键值列表 */}
              {inputObj ? (
                <div className='overflow-hidden rounded-md border border-border-card text-label'>
                  <table className='w-full border-collapse'>
                    <tbody>
                      {Object.entries(inputObj).map(([key, val]) => {
                        if (key === 'selector') return null // 已单独重点展示
                        const displayVal =
                          typeof val === 'string'
                            ? val
                            : typeof val === 'number' || typeof val === 'boolean'
                              ? String(val)
                              : JSON.stringify(val)

                        return (
                          <tr key={key} className='border-b border-border-divider last:border-0 hover:bg-muted/20'>
                            <td className='w-1/3 bg-surface-subtle p-2 font-mono text-muted-foreground align-top'>
                              {key}
                            </td>
                            <td className='p-2 font-mono text-foreground break-all'>
                              {item.sensitive && key === 'value' ? '•••••• (敏感值已脱敏)' : displayVal}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className='rounded-md border border-dashed border-border-card p-4 text-center text-label text-muted-foreground'>
                  无输入参数
                </div>
              )}
            </div>
          ) : (
            <div className='relative rounded-md border border-border-card bg-surface-subtle p-2.5'>
              <Button
                size='icon'
                variant='ghost'
                className='absolute right-2 top-2 size-6 text-muted-foreground hover:text-foreground'
                onClick={handleCopyJson}
                title='复制完整 JSON'
              >
                {copiedJson ? <Check className='size-3.5 text-status-success-foreground' /> : <Copy className='size-3.5' />}
              </Button>
              <pre className='max-h-64 overflow-auto text-label font-mono leading-relaxed text-foreground'>
                {JSON.stringify(item, null, 2)}
              </pre>
            </div>
          )}
        </TabsContent>

        {/* Tab 2: 定位与环境上下文 */}
        <TabsContent value='locator' className='mt-3 space-y-3'>
          <div className='rounded-md border border-border-card bg-card p-3 space-y-2 text-label'>
            <div>
              <span className='text-muted-foreground'>关联页面 (Page Alias):</span>
              <span className='ms-2 font-mono font-medium text-foreground'>
                {item.pageAlias || 'page0 (主页面)'}
              </span>
            </div>

            <div>
              <span className='text-muted-foreground'>嵌套 Frame 路径:</span>
              {item.framePath && item.framePath.length > 0 ? (
                <div className='mt-1 flex flex-wrap items-center gap-1'>
                  <span className='rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-label text-muted-foreground'>
                    main
                  </span>
                  {item.framePath.map((frame, idx) => (
                    <span key={`${frame}-${idx}`} className='flex items-center gap-1 font-mono text-label'>
                      <span className='text-muted-foreground'>&gt;</span>
                      <span className='rounded bg-surface-subtle px-1.5 py-0.5 text-primary font-medium'>
                        {frame}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <span className='ms-2 text-muted-foreground'>顶级页面 (无嵌套 iframe)</span>
              )}
            </div>

            {/* 若原始事件中有 locator 说明 */}
            {relatedEvents.some((e) => e.locator) ? (
              <div className='border-t border-border-divider pt-2 mt-2 space-y-1'>
                <span className='text-muted-foreground'>录制器智能定位符 (Locator):</span>
                {relatedEvents.map(
                  (e, idx) =>
                    e.locator && (
                      <pre
                        key={idx}
                        className='rounded bg-surface-subtle p-2 text-label font-mono overflow-auto max-h-32 text-foreground'
                      >
                        {JSON.stringify(e.locator, null, 2)}
                      </pre>
                    ),
                )}
              </div>
            ) : null}
          </div>
        </TabsContent>

        {/* Tab 3: 原始事件溯源 */}
        <TabsContent value='events' className='mt-3 space-y-2'>
          <p className='text-label text-muted-foreground'>
            本步骤由插件捕获的 {relatedEvents.length} 个浏览器底层事件聚合规整而成：
          </p>
          {relatedEvents.length === 0 ? (
            <div className='rounded-md border border-dashed border-border-card p-4 text-center text-label text-muted-foreground'>
              无对应原始事件记录
            </div>
          ) : (
            <div className='space-y-2 max-h-64 overflow-y-auto pr-1'>
              {relatedEvents.map((evt, idx) => (
                <div key={idx} className='rounded-md border border-border-card bg-surface-subtle p-2.5 text-label space-y-1'>
                  <div className='flex items-center justify-between'>
                    <span className='font-mono font-semibold text-primary'>
                      Event #{item.sourceIndexes[idx] ?? idx}: {String(evt.name)}
                    </span>
                    {evt.markedSensitive ? (
                      <span className='text-status-warning-foreground font-medium'>[敏感]</span>
                    ) : null}
                  </div>
                  {evt.selector ? (
                    <div className='font-mono text-muted-foreground truncate'>
                      selector: {evt.selector}
                    </div>
                  ) : null}
                  {evt.url ? (
                    <div className='font-mono text-muted-foreground truncate'>
                      url: {evt.url}
                    </div>
                  ) : null}
                  {evt.value !== undefined ? (
                    <div className='font-mono text-muted-foreground truncate'>
                      value: {evt.markedSensitive ? '••••••' : String(evt.value)}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
