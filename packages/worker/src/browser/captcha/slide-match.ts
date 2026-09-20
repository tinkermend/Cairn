export interface GrayImage {
  data: Uint8Array
  width: number
  height: number
}

export interface SlideMatchResult {
  x: number
  y: number
  confidence: number
}

function pixel(image: GrayImage, x: number, y: number): number {
  return image.data[y * image.width + x] ?? 0
}

function sobelEdges(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.width * image.height)
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const gx =
        -pixel(image, x - 1, y - 1) +
        pixel(image, x + 1, y - 1) -
        2 * pixel(image, x - 1, y) +
        2 * pixel(image, x + 1, y) -
        pixel(image, x - 1, y + 1) +
        pixel(image, x + 1, y + 1)
      const gy =
        -pixel(image, x - 1, y - 1) -
        2 * pixel(image, x, y - 1) -
        pixel(image, x + 1, y - 1) +
        pixel(image, x - 1, y + 1) +
        2 * pixel(image, x, y + 1) +
        pixel(image, x + 1, y + 1)
      data[y * image.width + x] = Math.min(255, Math.hypot(gx, gy))
    }
  }
  return { data, width: image.width, height: image.height }
}

function nccAt(background: GrayImage, target: GrayImage, originX: number, originY: number): number {
  let sumT = 0
  let sumI = 0
  const n = target.width * target.height
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      sumT += pixel(target, x, y)
      sumI += pixel(background, originX + x, originY + y)
    }
  }
  const meanT = sumT / n
  const meanI = sumI / n
  let num = 0
  let denT = 0
  let denI = 0
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      const dt = pixel(target, x, y) - meanT
      const di = pixel(background, originX + x, originY + y) - meanI
      num += dt * di
      denT += dt * dt
      denI += di * di
    }
  }
  const den = Math.sqrt(denT * denI)
  if (den !== 0) return num / den
  let sad = 0
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      sad += Math.abs(pixel(target, x, y) - pixel(background, originX + x, originY + y))
    }
  }
  return 1 - sad / (n * 255)
}

/** 官方 slide_match：滑块小图在背景上做模板 / 边缘匹配。 */
export function slideMatch(target: GrayImage, background: GrayImage, simpleTarget = false): SlideMatchResult {
  const probe = simpleTarget ? { target, background } : { target: sobelEdges(target), background: sobelEdges(background) }
  const maxX = Math.max(0, probe.background.width - probe.target.width)
  const maxY = Math.max(0, probe.background.height - probe.target.height)
  let best = { x: 0, y: 0, confidence: -1 }
  const stepY = probe.target.height > 24 ? 2 : 1
  for (let y = 0; y <= maxY; y += stepY) {
    for (let x = 0; x <= maxX; x += 1) {
      const confidence = nccAt(probe.background, probe.target, x, y)
      if (confidence > best.confidence) best = { x, y, confidence }
    }
  }
  return {
    x: best.x + Math.floor(probe.target.width / 2),
    y: best.y + Math.floor(probe.target.height / 2),
    confidence: best.confidence < 0 ? 0 : best.confidence,
  }
}

/** 官方 slide_comparison：完整图与带缺口图的差异质心。 */
export function slideComparison(gapped: GrayImage, complete: GrayImage): SlideMatchResult {
  const width = Math.min(gapped.width, complete.width)
  const height = Math.min(gapped.height, complete.height)
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const diff = Math.abs(pixel(gapped, x, y) - pixel(complete, x, y))
      if (diff < 30) continue
      sumX += x
      sumY += y
      count += 1
    }
  }
  if (count === 0) return { x: 0, y: 0, confidence: 0 }
  return {
    x: Math.round(sumX / count),
    y: Math.round(sumY / count),
    confidence: Math.min(1, count / (width * height * 0.05)),
  }
}
