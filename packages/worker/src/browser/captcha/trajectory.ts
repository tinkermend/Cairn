export interface TrajectoryPoint {
  x: number
  y: number
  delayMs: number
}

export interface TrajectoryOptions {
  minDurationMs?: number
  maxDurationMs?: number
  jitterY?: number
  overshootPx?: number
}

/**
 * 拟人化贝塞尔曲线轨迹规划器。
 * 模拟人类拖拽滑块时的物理特性：
 * 1. 启动加速 -> 中段平稳 -> 接近终点减速
 * 2. Y 轴微小生理抖动 (Jitter)
 * 3. 终点微小超调 (Overshoot) 与反向校正回拉 (Pullback)
 */
export function generateSliderTrajectory(
  startX: number,
  startY: number,
  distanceX: number,
  options: TrajectoryOptions = {},
): TrajectoryPoint[] {
  const minDuration = options.minDurationMs ?? 800
  const maxDuration = options.maxDurationMs ?? 1500
  const totalDuration = Math.floor(minDuration + Math.random() * (maxDuration - minDuration))
  const maxJitter = options.jitterY ?? 2
  const overshoot = options.overshootPx ?? Math.floor(2 + Math.random() * 3)

  const stepsCount = Math.max(25, Math.floor(totalDuration / 30))
  const points: TrajectoryPoint[] = []

  // 三次贝塞尔拟合参数 (Cubic Bézier P0=(0,0), P1=(0.25, 0.1), P2=(0.25, 1.0), P3=(1,1))
  const bezier = (t: number): number => {
    // 缓动曲线：先慢后快再慢 (Ease-in-out)
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  const stepInterval = Math.floor((totalDuration * 0.8) / stepsCount)

  // 1. 主干位移（包含超调）
  const targetWithOvershoot = distanceX + overshoot
  for (let i = 1; i <= stepsCount; i += 1) {
    const t = i / stepsCount
    const progress = bezier(t)
    const currentX = Math.round(startX + targetWithOvershoot * progress)
    // 随机 Y 轴抖动，终段逐渐平稳
    const jitter = (1 - t) * (Math.random() * 2 * maxJitter - maxJitter)
    const currentY = Math.round(startY + jitter)

    points.push({
      x: currentX,
      y: currentY,
      delayMs: stepInterval + Math.floor(Math.random() * 6 - 3),
    })
  }

  // 2. 超调后微小停顿
  points.push({
    x: startX + targetWithOvershoot,
    y: startY,
    delayMs: 60 + Math.floor(Math.random() * 40),
  })

  // 3. 回拉校正至真实终点
  const pullbackSteps = 3
  for (let j = 1; j <= pullbackSteps; j += 1) {
    const pt = j / pullbackSteps
    const curX = Math.round(startX + targetWithOvershoot - overshoot * pt)
    points.push({
      x: curX,
      y: startY,
      delayMs: 25 + Math.floor(Math.random() * 10),
    })
  }

  // 4. 松手前最终停留
  points.push({
    x: startX + distanceX,
    y: startY,
    delayMs: 50 + Math.floor(Math.random() * 30),
  })

  return points
}
