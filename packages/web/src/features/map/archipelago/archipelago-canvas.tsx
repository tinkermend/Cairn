import { useMemo } from 'react'
import type { MapAtlasPageItem } from '@cairn/shared'
import { computeArchipelagoLayout } from './layout'
import { IslandNode } from './island-node'

interface ArchipelagoCanvasProps {
  items: MapAtlasPageItem[]
  selectedPageId?: string
  onSelectPage: (pageId: string | undefined) => void
}

export function ArchipelagoCanvas({
  items,
  selectedPageId,
  onSelectPage,
}: ArchipelagoCanvasProps) {
  const placements = useMemo(() => computeArchipelagoLayout(items), [items])

  return (
    <div
      className='archipelago-canvas'
      role='region'
      aria-label='知识海图群岛视口'
    >
      {/* 深海微光背景与噪波纹理 */}
      <img
        src='/images/ocean-surface.webp'
        className='archipelago-ocean-bg'
        alt=''
        aria-hidden='true'
      />

      {/* 海底等深线测绘弧线 */}
      <svg
        className='archipelago-ocean-lines'
        viewBox='0 0 1200 690'
        preserveAspectRatio='xMidYMid slice'
        aria-hidden='true'
      >
        <path d='M-95 92 C92 19 224 21 352 85 S634 160 754 90 1034 22 1290 112' />
        <path d='M-135 132 C45 57 199 60 338 125 S613 205 756 127 1049 60 1288 150' />
        <path d='M-172 176 C18 101 190 102 330 163 S603 247 763 166 1062 106 1301 195' />
        <path d='M-130 549 C76 464 248 455 372 515 S639 592 784 508 1049 469 1290 548' />
        <path d='M-121 587 C72 511 244 491 380 550 S645 632 785 549 1057 505 1275 580' />
        <path d='M-98 628 C97 551 237 530 384 590 S653 673 796 592 1065 552 1290 624' />
      </svg>

      {/* 航海网格十字标与经纬坐标 */}
      <span className='archipelago-crosshair archipelago-crosshair--a' aria-hidden='true' />
      <span className='archipelago-crosshair archipelago-crosshair--b' aria-hidden='true' />
      <span className='archipelago-coordinate archipelago-coordinate--a' aria-hidden='true'>
        PAGE / OBJECT
      </span>
      <span className='archipelago-coordinate archipelago-coordinate--b' aria-hidden='true'>
        KNOWLEDGE / ATLAS
      </span>

      {/* 岛屿群实体渲染 */}
      {placements.map((placement) => (
        <IslandNode
          key={placement.item.pageId}
          placement={placement}
          isSelected={placement.item.pageId === selectedPageId}
          isDim={Boolean(selectedPageId && placement.item.pageId !== selectedPageId)}
          onClick={() =>
            onSelectPage(
              placement.item.pageId === selectedPageId ? undefined : placement.item.pageId,
            )
          }
        />
      ))}
    </div>
  )
}
