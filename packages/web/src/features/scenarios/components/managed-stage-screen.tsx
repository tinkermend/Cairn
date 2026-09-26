import { Monitor, Maximize2, LayoutGrid } from 'lucide-react'
import { StudioScreen, type StudioScreenProps } from '../studio-screen'
import type { StudioViewPreset } from './studio-splitter-layout'
import { cn } from '@/lib/utils'

export interface ManagedStageScreenProps extends StudioScreenProps {
  preset?: StudioViewPreset
  onPresetChange?: (preset: StudioViewPreset) => void
  className?: string
}

export function ManagedStageScreen({
  preset = 'balanced',
  onPresetChange,
  className,
  ...screenProps
}: ManagedStageScreenProps) {
  return (
    <div
      data-testid='managed-stage-screen'
      className={cn('flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card', className)}
    >
      {/* 舞台微型控制条 */}
      <div className='flex items-center justify-between border-b border-border-divider bg-surface-header px-3 py-1.5 shrink-0 gap-2'>
        <div className='flex items-center gap-2 min-w-0'>
          <Monitor className='size-3.5 text-primary shrink-0' />
          <span className='text-label font-medium text-foreground truncate'>受管浏览器舞台</span>
        </div>

        {/* 三档工作区聚焦模式快捷切换 */}
        {onPresetChange && (
          <div className='flex items-center gap-1 rounded-md border border-border-divider bg-surface-subtle p-0.5 text-label'>
            <button
              type='button'
              title='均衡视图（左管线 + 中舞台 + 右属性）'
              aria-label='均衡视图'
              onClick={() => onPresetChange('balanced')}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-caption font-medium transition-colors',
                preset === 'balanced'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutGrid className='size-3' />
              <span>均衡</span>
            </button>
            <button
              type='button'
              title='舞台对焦模式（大屏点选）'
              aria-label='舞台对焦模式'
              onClick={() => onPresetChange('stage')}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-caption font-medium transition-colors',
                preset === 'stage'
                  ? 'bg-card text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Maximize2 className='size-3' />
              <span>舞台聚焦</span>
            </button>
          </div>
        )}
      </div>

      {/* 画面视口舞台主体 */}
      <div className='flex-1 min-h-0 min-w-0 overflow-hidden relative'>
        <StudioScreen {...screenProps} />
      </div>
    </div>
  )
}
