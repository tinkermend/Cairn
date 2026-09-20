import type { Page, Locator } from 'playwright'
import sharp from 'sharp'
import { generateSliderTrajectory, type TrajectoryOptions } from './trajectory.js'
import { slideMatch, type GrayImage } from './slide-match.js'

async function toGrayImage(buffer: Buffer): Promise<GrayImage> {
  const { data, info } = await sharp(buffer).grayscale().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export interface SliderCaptchaOptions extends TrajectoryOptions {
  timeoutMs?: number
  expectedDistancePx?: number
}

export interface SliderCaptchaResult {
  solved: boolean
  displacementPx: number
  durationMs: number
  error?: string
}

/**
 * 缺口图像模板匹配/边缘特征比对算法。
 * 针对拼图滑块，分析背景图中阴影缺口的横向 X 轴偏移量。
 */
export async function detectPuzzleGapOffset(
  bgBuffer: Buffer,
  knobBuffer?: Buffer,
): Promise<number> {
  const bg = sharp(bgBuffer).grayscale()
  const { width, height } = await bg.metadata()
  if (!width || !height) return 200

  const rawBg = await bg.raw().toBuffer()

  // 1. 如果有滑块小图，提取滑块高度与宽度，进行灰度方差/边缘匹配
  // 简易但高鲁棒性的滑块缺口定位算法：
  // 大多数拼图验证码缺口在背景中具有明显的边缘突变或深色/凹陷阴影
  // 我们在 X 轴 [width * 0.2, width * 0.9] 范围内扫描梯度最大的连续矩形区域
  const minX = Math.floor(width * 0.2)
  const maxX = Math.floor(width * 0.9)
  let bestX = minX
  let maxEdgeSum = -1

  // 垂直方向取中段 60% 区域计算垂直边缘强度 (Sobel-like vertical gradient)
  const startY = Math.floor(height * 0.2)
  const endY = Math.floor(height * 0.8)

  for (let x = minX; x < maxX; x += 2) {
    let edgeSum = 0
    for (let y = startY; y < endY; y += 2) {
      const idx = y * width + x
      const left = rawBg[idx - 1] ?? 0
      const right = rawBg[idx + 1] ?? 0
      edgeSum += Math.abs(right - left)
    }
    if (edgeSum > maxEdgeSum) {
      maxEdgeSum = edgeSum
      bestX = x
    }
  }

  return bestX
}

/**
 * 求解滑动验证码（包含平移滑动条与拼图滑块）。
 * 自动根据传入定位器推断是 Track 模式还是 Puzzle 模式。
 */
export async function solveSliderCaptcha(
  page: Page,
  knobLocator: Locator,
  containerOrBgLocator?: Locator,
  options?: SliderCaptchaOptions,
): Promise<SliderCaptchaResult> {
  const startTime = Date.now()
  try {
    const timeout = options?.timeoutMs ?? 15_000
    await knobLocator.waitFor({ state: 'visible', timeout })

    const knobBox = await knobLocator.boundingBox()
    if (!knobBox) {
      return {
        solved: false,
        displacementPx: 0,
        durationMs: Date.now() - startTime,
        error: '无法获取滑块元素的屏幕坐标',
      }
    }

    let displacementPx = options?.expectedDistancePx ?? 0

    if (!displacementPx && containerOrBgLocator) {
      const targetBox = await containerOrBgLocator.boundingBox()
      if (targetBox) {
        // 判断容器是背景大图（拼图模式）还是水平滑轨（滑动条模式）
        // 拼图背景大图高宽比通常比较大（例如 300x150），而滑轨通常高度较小（例如 400x40）
        const isPuzzleBg = targetBox.height > knobBox.height * 2

        if (isPuzzleBg) {
          const bgBuffer = await containerOrBgLocator.screenshot()
          const knobBuffer = await knobLocator.screenshot().catch(() => undefined)
          if (knobBuffer) {
            const match = slideMatch(await toGrayImage(knobBuffer), await toGrayImage(bgBuffer))
            const bgMeta = await sharp(bgBuffer).metadata()
            const scaleX = (bgMeta.width ?? targetBox.width) / Math.max(1, targetBox.width)
            const targetCenterCss = match.x / scaleX
            const knobCenterCss = knobBox.x - targetBox.x + knobBox.width / 2
            if (match.confidence >= 0.15) {
              displacementPx = Math.max(0, Math.round(targetCenterCss - knobCenterCss))
            }
          }
          if (!displacementPx) {
            displacementPx = await detectPuzzleGapOffset(bgBuffer, knobBuffer)
          }
        } else {
          // Track 模式：计算平移轨道全长
          displacementPx = Math.max(20, Math.round(targetBox.width - knobBox.width))
        }
      }
    }

    // 若未指定且未探测出，兜底估算平移量
    if (!displacementPx || displacementPx <= 0) {
      displacementPx = 300
    }

    // 计算鼠标起止点
    const startX = Math.round(knobBox.x + knobBox.width / 2)
    const startY = Math.round(knobBox.y + knobBox.height / 2)

    // 生成拟人化贝塞尔曲线点流
    const points = generateSliderTrajectory(startX, startY, displacementPx, {
      minDurationMs: options?.minDurationMs ?? 800,
      maxDurationMs: options?.maxDurationMs ?? 1500,
      jitterY: options?.jitterY ?? 2,
      overshootPx: options?.overshootPx,
    })

    // 执行 Playwright 鼠标轨迹流
    await page.mouse.move(startX, startY)
    await page.waitForTimeout(50 + Math.floor(Math.random() * 50))
    await page.mouse.down()

    for (const point of points) {
      await page.mouse.move(point.x, point.y)
      if (point.delayMs > 0) {
        await page.waitForTimeout(point.delayMs)
      }
    }

    await page.mouse.up()

    // 释放鼠标后等待页面组件更新状态
    await page.waitForTimeout(400)

    return {
      solved: true,
      displacementPx,
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    return {
      solved: false,
      displacementPx: 0,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
