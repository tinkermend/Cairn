import { type ReactNode, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type StudioInspectorTab = 'step' | 'inputs' | 'outputs' | 'outcomes'

export interface StudioInspectorHostProps {
  rightTab?: StudioInspectorTab
  onTabChange?: (tab: StudioInspectorTab) => void
  showTabs?: boolean
  onOpenScenarioConfig?: () => void
  stepTitle?: string
  stepSubTitle?: string
  inputsCount?: number
  outputsCount?: number
  diagnosticsCount?: number
  topHealing?: ReactNode
  topHoldingRetry?: ReactNode
  children: ReactNode
  className?: string
}

export function StudioInspectorHost({
  rightTab = 'step',
  onTabChange,
  showTabs = true,
  onOpenScenarioConfig,
  stepTitle,
  stepSubTitle,
  inputsCount = 0,
  outputsCount = 0,
  diagnosticsCount = 0,
  topHealing,
  topHoldingRetry,
  children,
  className,
}: StudioInspectorHostProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  return (
    <section
      data-testid='studio-inspector-host'
      aria-label='属性检查器'
      className={cn('@container flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card', className)}
    >
      {/* 属性面板顶栏导航：纯净白表面与冷蓝边界，消除多余灰底嵌套 */}
      <div className='border-b border-border-divider bg-surface-header p-3 shrink-0 space-y-2.5'>
        {showTabs ? (
          <>
            {/* 四态 Tab 导航胶囊 */}
            <div
              className='flex items-center gap-0.5 p-1 bg-surface-subtle rounded-lg border border-border-default/80 text-label'
              role='tablist'
              aria-label='属性面板导航'
            >
              <button
                type='button'
                role='tab'
                aria-selected={rightTab === 'step'}
                className={cn(
                  'min-w-0 flex-auto whitespace-nowrap py-1.5 px-1 rounded-md font-medium text-label transition-colors text-center',
                  rightTab === 'step'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onTabChange?.('step')}
              >
                步骤配置
              </button>
              <button
                type='button'
                role='tab'
                aria-selected={rightTab === 'inputs'}
                aria-label={inputsCount > 0 ? `输入参数，${inputsCount} 项` : '输入参数'}
                className={cn(
                  'min-w-0 flex-auto whitespace-nowrap py-1.5 px-1 rounded-md font-medium text-label transition-colors text-center flex items-center justify-center gap-1',
                  rightTab === 'inputs'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => {
                  onTabChange?.('inputs')
                  scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              >
                <span>输入参数</span>
                {inputsCount > 0 && (
                  <span
                    className={cn(
                      'inline-flex items-center justify-center px-1.5 py-0.2 text-caption font-semibold rounded-full @max-[389px]:hidden',
                      rightTab === 'inputs'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {inputsCount}
                  </span>
                )}
              </button>
              <button
                type='button'
                role='tab'
                aria-selected={rightTab === 'outputs'}
                aria-label={outputsCount > 0 ? `业务输出，${outputsCount} 项` : '业务输出'}
                className={cn(
                  'min-w-0 flex-auto whitespace-nowrap py-1.5 px-1 rounded-md font-medium text-label transition-colors text-center flex items-center justify-center gap-1',
                  rightTab === 'outputs'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => {
                  onTabChange?.('outputs')
                  scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              >
                <span>业务输出</span>
                {outputsCount > 0 && (
                  <span
                    className={cn(
                      'inline-flex items-center justify-center px-1.5 py-0.2 text-caption font-semibold rounded-full @max-[389px]:hidden',
                      rightTab === 'outputs'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {outputsCount}
                  </span>
                )}
              </button>
              <button
                type='button'
                role='tab'
                aria-selected={rightTab === 'outcomes'}
                aria-label={diagnosticsCount > 0 ? `预期与诊断，${diagnosticsCount} 项` : '预期与诊断'}
                className={cn(
                  'min-w-0 flex-auto whitespace-nowrap py-1.5 px-1 rounded-md font-medium text-label transition-colors text-center flex items-center justify-center gap-1',
                  rightTab === 'outcomes'
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => {
                  onTabChange?.('outcomes')
                  scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              >
                <span>预期与诊断</span>
                {diagnosticsCount > 0 && (
                  <span className='inline-flex items-center justify-center px-1.5 py-0.2 text-caption font-semibold rounded-full bg-status-warning/15 text-status-warning-foreground @max-[389px]:hidden'>
                    {diagnosticsCount}
                  </span>
                )}
              </button>
            </div>

            {/* 标题与面包屑信息 */}
            <div className='px-1'>
              <p className='text-label text-muted-foreground'>
                {stepSubTitle ?? (rightTab === 'step' ? '步骤详情' : '场景级配置')}
              </p>
              <h3 className='mt-0.5 text-section font-semibold text-foreground break-words'>
                {stepTitle ?? (rightTab === 'step' ? '步骤配置' : '配置详情')}
              </h3>
            </div>
          </>
        ) : (
          <div className='flex items-center justify-between gap-2 px-1'>
            <div className='min-w-0'>
              <p className='text-caption text-muted-foreground truncate'>
                {stepSubTitle ?? '步骤详情'}
              </p>
              <h3 className='mt-0.5 text-body font-semibold text-foreground truncate'>
                {stepTitle ?? '步骤配置'}
              </h3>
            </div>
            {onOpenScenarioConfig && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                data-testid='inspector-open-scenario-config'
                onClick={onOpenScenarioConfig}
                className='shrink-0 h-7 px-2.5 text-label gap-1 font-medium hover:bg-muted text-primary border-primary/20 bg-primary/5 hover:bg-primary/10'
                title='切换至场景全局配置'
              >
                <span>切换至场景配置</span>
                <ArrowRight className='size-3.5' />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 滚动检查器内容区 */}
      <div
        ref={scrollRef}
        data-testid='inspector-scroll-area'
        className='flex-1 min-h-0 space-y-4 overflow-y-auto p-4 pb-28'
      >
        {/* 最高优先级置顶区：阶段一自愈卡片 */}
        {topHealing}

        {/* 单步挂起快捷重试横条 */}
        {topHoldingRetry}

        {/* 检查器具体面板 */}
        {children}
      </div>
    </section>
  )
}
