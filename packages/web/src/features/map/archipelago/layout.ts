import type { MapAtlasPageItem } from '@cairn/shared'

export type IslandPlacement = {
  item: MapAtlasPageItem
  leftPercent: number
  topPercent: number
  widthPercent: number
  zIndex: number
  isPrimary: boolean
}

// Pre-calculated collision-free slots for up to 8 islands in sea canvas
const PRESET_SLOTS_3 = [
  { left: 5, top: 27, width: 44, zIndex: 4 },
  { left: 54, top: 9, width: 36, zIndex: 3 },
  { left: 52, top: 55, width: 37, zIndex: 5 },
]

const PRESET_SLOTS_4 = [
  { left: 6, top: 24, width: 40, zIndex: 4 },
  { left: 53, top: 8, width: 33, zIndex: 3 },
  { left: 55, top: 55, width: 34, zIndex: 5 },
  { left: 24, top: 62, width: 31, zIndex: 6 },
]

const PRESET_SLOTS_8 = [
  { left: 6, top: 25, width: 36, zIndex: 6 },   // Main anchor
  { left: 45, top: 7, width: 27, zIndex: 3 },    // Northeast upper
  { left: 73, top: 12, width: 25, zIndex: 2 },   // Far East upper
  { left: 72, top: 48, width: 26, zIndex: 4 },   // Far East lower
  { left: 45, top: 58, width: 28, zIndex: 5 },   // Southeast
  { left: 20, top: 65, width: 26, zIndex: 7 },   // South
  { left: 22, top: 4, width: 25, zIndex: 2 },    // Northwest
  { left: 44, top: 33, width: 24, zIndex: 5 },   // Center channel
]

/**
 * Calculates collision-free positions for sea islands.
 * Deterministic, instant, with zero layout shift or physics lag.
 */
export function computeArchipelagoLayout(
  items: MapAtlasPageItem[],
): IslandPlacement[] {
  if (items.length === 0) return []

  if (items.length === 1) {
    return [
      {
        item: items[0],
        leftPercent: 28,
        topPercent: 25,
        widthPercent: 44,
        zIndex: 4,
        isPrimary: true,
      },
    ]
  }

  if (items.length === 2) {
    return [
      {
        item: items[0],
        leftPercent: 8,
        topPercent: 26,
        widthPercent: 44,
        zIndex: 4,
        isPrimary: true,
      },
      {
        item: items[1],
        leftPercent: 54,
        topPercent: 28,
        widthPercent: 38,
        zIndex: 3,
        isPrimary: false,
      },
    ]
  }

  if (items.length === 3) {
    return items.map((item, index) => ({
      item,
      leftPercent: PRESET_SLOTS_3[index].left,
      topPercent: PRESET_SLOTS_3[index].top,
      widthPercent: PRESET_SLOTS_3[index].width,
      zIndex: PRESET_SLOTS_3[index].zIndex,
      isPrimary: index === 0,
    }))
  }

  if (items.length === 4) {
    return items.map((item, index) => ({
      item,
      leftPercent: PRESET_SLOTS_4[index].left,
      topPercent: PRESET_SLOTS_4[index].top,
      widthPercent: PRESET_SLOTS_4[index].width,
      zIndex: PRESET_SLOTS_4[index].zIndex,
      isPrimary: index === 0,
    }))
  }

  if (items.length <= 8) {
    return items.map((item, index) => ({
      item,
      leftPercent: PRESET_SLOTS_8[index].left,
      topPercent: PRESET_SLOTS_8[index].top,
      widthPercent: PRESET_SLOTS_8[index].width,
      zIndex: PRESET_SLOTS_8[index].zIndex,
      isPrimary: index === 0,
    }))
  }

  // 9+ items: Grid-based navigation lanes (3 columns x N rows)
  const cols = 3
  const cardWidth = 28
  const cardHeight = 28
  const gapX = 4
  const gapY = 5
  const startX = 4
  const startY = 6

  return items.map((item, index) => {
    const row = Math.floor(index / cols)
    const col = index % cols
    return {
      item,
      leftPercent: startX + col * (cardWidth + gapX),
      topPercent: startY + row * (cardHeight + gapY),
      widthPercent: cardWidth,
      zIndex: 2 + index,
      isPrimary: index === 0,
    }
  })
}
