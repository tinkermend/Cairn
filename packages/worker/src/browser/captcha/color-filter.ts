/** 官方 ddddocr HSV 预设（OpenCV：H 0–180，S/V 0–255）。 */
export const COLOR_PRESETS: Record<string, Array<[[number, number, number], [number, number, number]]>> = {
  red: [
    [[0, 50, 50], [10, 255, 255]],
    [[170, 50, 50], [180, 255, 255]],
  ],
  blue: [[[100, 50, 50], [130, 255, 255]]],
  green: [[[40, 50, 50], [80, 255, 255]]],
  yellow: [[[20, 50, 50], [40, 255, 255]]],
  orange: [[[10, 50, 50], [20, 255, 255]]],
  purple: [[[130, 50, 50], [170, 255, 255]]],
  pink: [[[140, 50, 50], [170, 255, 255]]],
  brown: [[[8, 50, 20], [20, 255, 180]]],
  cyan: [[[80, 50, 50], [100, 255, 255]]],
  black: [[[0, 0, 0], [180, 255, 50]]],
  white: [[[0, 0, 200], [180, 30, 255]]],
  gray: [[[0, 0, 50], [180, 30, 200]]],
}

export type HsvRange = [[number, number, number], [number, number, number]]

export function resolveColorRanges(colors?: string[] | null, customRanges?: HsvRange[] | null): HsvRange[] {
  const ranges: HsvRange[] = []
  for (const color of colors ?? []) {
    const preset = COLOR_PRESETS[color.toLowerCase()]
    if (!preset) continue
    ranges.push(...preset)
  }
  if (customRanges) ranges.push(...customRanges)
  return ranges
}

function rgbToHsvOpenCv(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / delta) % 6)
    else if (max === gg) h = 60 * ((bb - rr) / delta + 2)
    else h = 60 * ((rr - gg) / delta + 4)
  }
  if (h < 0) h += 360
  const s = max === 0 ? 0 : delta / max
  return [Math.round(h / 2), Math.round(s * 255), Math.round(max * 255)]
}

function inRange(h: number, s: number, v: number, range: HsvRange): boolean {
  const [lo, hi] = range
  return h >= lo[0] && h <= hi[0] && s >= lo[1] && s <= hi[1] && v >= lo[2] && v <= hi[2]
}

/** 只保留指定颜色，其余铺白，对齐官方 ColorFilter.filter_image。 */
export function filterRgbByColors(
  rgb: Uint8Array,
  width: number,
  height: number,
  ranges: HsvRange[],
): Uint8Array {
  if (ranges.length === 0) return rgb
  const out = new Uint8Array(rgb.length)
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 3
    const [h, s, v] = rgbToHsvOpenCv(rgb[o] ?? 0, rgb[o + 1] ?? 0, rgb[o + 2] ?? 0)
    const keep = ranges.some((range) => inRange(h, s, v, range))
    if (keep) {
      out[o] = rgb[o] ?? 0
      out[o + 1] = rgb[o + 1] ?? 0
      out[o + 2] = rgb[o + 2] ?? 0
    } else {
      out[o] = 255
      out[o + 1] = 255
      out[o + 2] = 255
    }
  }
  return out
}
