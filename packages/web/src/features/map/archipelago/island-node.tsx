import { memo, useId } from 'react'
import type { IslandPlacement } from './layout'
import { getIslandShape } from './shapes'

interface IslandNodeProps {
  placement: IslandPlacement
  isSelected: boolean
  isDim: boolean
  onClick: () => void
}

export const IslandNode = memo(function IslandNode({
  placement,
  isSelected,
  isDim,
  onClick,
}: IslandNodeProps) {
  const { item, leftPercent, topPercent, widthPercent, zIndex } = placement
  const reactId = useId()
  const artId = `island-${item.pageId}-${reactId.replace(/:/g, '')}`
  const shape = getIslandShape(item.pageId)

  return (
    <button
      type='button'
      className={`archipelago-island ${isSelected ? 'archipelago-island--selected' : ''} ${isDim ? 'archipelago-island--dim' : ''}`}
      style={{
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
        width: `${widthPercent}%`,
        zIndex,
      }}
      onClick={onClick}
      aria-label={`海岛 ${item.displayName}，包含 ${item.uniqueObjectCount} 个知识对象${item.uniqueNeedsAttentionCount > 0 ? `，${item.uniqueNeedsAttentionCount} 个待关注` : ''}`}
      aria-pressed={isSelected}
    >
      <svg viewBox='0 0 340 225' aria-hidden='true' focusable='false'>
        <defs>
          <linearGradient id={`land-${artId}`} x1='0' y1='0' x2='0.86' y2='1'>
            <stop offset='0%' stopColor='var(--archipelago-land-highlight)' />
            <stop offset='53%' stopColor='var(--archipelago-land-middle)' />
            <stop offset='100%' stopColor='var(--archipelago-land-low)' />
          </linearGradient>
          <clipPath id={`clip-${artId}`}>
            <path d={shape} />
          </clipPath>
        </defs>

        {/* 底层断崖阴影 */}
        <path
          d={shape}
          transform='translate(0 19)'
          fill='var(--archipelago-cliff-shadow)'
          stroke='var(--archipelago-cliff-edge)'
          strokeWidth={3}
        />
        {/* 中层岩层侧壁 */}
        <path
          d={shape}
          transform='translate(0 10)'
          fill='var(--archipelago-cliff-face)'
          stroke='var(--archipelago-cliff-rim)'
          strokeWidth={2}
        />
        {/* 顶层陆地表面 */}
        <path
          d={shape}
          fill={`url(#land-${artId})`}
          stroke='var(--archipelago-land-rim)'
          strokeWidth={2.5}
        />

        {/* 等高线地形脊线 */}
        <g
          clipPath={`url(#clip-${artId})`}
          fill='none'
          stroke='var(--archipelago-contour)'
          strokeWidth={1.25}
          opacity={0.45}
        >
          <path d='M10 89 C80 55 126 66 181 51 S280 64 326 83' />
          <path d='M7 111 C70 79 118 83 174 72 S272 83 332 106' />
          <path d='M5 133 C71 109 122 110 173 99 S276 112 337 133' />
          <path d='M12 153 C91 127 129 138 183 124 S273 140 333 155' />
        </g>
      </svg>

      <div className='archipelago-island-label'>
        <span className='archipelago-island-overline'>
          {item.pageKind === 'frame_primary' ? 'FRAME' : item.pageKind === 'composite' ? 'COMPOSITE' : 'PAGE'}
        </span>
        <strong className='archipelago-island-title'>{item.displayName}</strong>
        <span className='archipelago-island-route'>{item.routeSummary}</span>
      </div>

      <div className='archipelago-island-count'>
        <span>{item.uniqueObjectCount} 对象</span>
      </div>

      {item.uniqueNeedsAttentionCount > 0 ? (
        <span
          className='archipelago-beacon'
          title={`${item.uniqueNeedsAttentionCount} 个对象需复核或不可执行`}
        >
          {item.uniqueNeedsAttentionCount}
        </span>
      ) : null}
    </button>
  )
})
