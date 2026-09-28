import { inflateSync } from 'node:zlib'
import type { ScreenshotDiagnosis } from '@cairn/shared'
import type { Page } from 'playwright'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export async function pageHasMeaningfulContent(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as { document?: { body?: { innerText?: string; querySelector: (selector: string) => unknown } } }).document
      const body = doc?.body
      if (!body) return false
      const text = String(body.innerText ?? '').replace(/\s+/g, '')
      if (text.length > 0) return true
      return body.querySelector('img,canvas,svg,video,iframe,input,button,textarea,select') != null
    })
  } catch {
    return true
  }
}

export async function isOmittableInitialBlank(page: Page, commandType?: string): Promise<boolean> {
  if (commandType !== 'navigate') return false
  let url = ''
  try {
    url = page.url()
  } catch {
    return false
  }
  if (url !== 'about:blank') return false
  return !(await pageHasMeaningfulContent(page))
}

export function pngLooksUniform(bytes: Buffer): boolean {
  const samples = samplePng(bytes)
  if (!samples || samples.length === 0) return false
  const [base] = samples
  return samples.every((pixel) => pixel.every((channel, index) => Math.abs(channel - (base?.[index] ?? channel)) <= 12))
}

export async function diagnoseScreenshot(page: Page, bytes: Buffer): Promise<ScreenshotDiagnosis> {
  if (await pageHasMeaningfulContent(page)) return 'not_flagged'
  return pngLooksUniform(bytes) ? 'suspected_blank' : 'not_flagged'
}

/**
 * 画面是否仍处在加载遮罩/加载动画阶段。
 *
 * 只依据标准 Web Animations API（`document.getAnimations()`），不认任何具体
 * 框架的 class 名：找一条正在播放、且自身或最近 4 层祖先覆盖视口面积过半的
 * 动画，就当作还在加载。覆盖阈值刻意选得高，只抓「整页/大面积遮罩」这类，
 * 小局部 loading（例如按钮里的小图标）不算。
 *
 * 会连遮罩淡出（内容其实已经画好，只是过渡还没播完）也一起判进来；这不是
 * 误判风险，因为调用方只把它当「再等一等再拍」的触发条件，不改变空白诊断
 * 语义——淡出中再等一次，拍到的只会是更完整的画面，不会更差。
 */
export async function pageLooksLoading(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const globalAny = globalThis as unknown as {
        document?: { getAnimations?: () => any[] }
        innerWidth?: number
        innerHeight?: number
      }
      const doc = globalAny.document
      if (!doc || typeof doc.getAnimations !== 'function') return false
      const vw = globalAny.innerWidth ?? 0
      const vh = globalAny.innerHeight ?? 0
      if (!vw || !vh) return false
      const viewportArea = vw * vh
      const animations = doc.getAnimations()
      for (const animation of animations) {
        if (animation.playState !== 'running') continue
        const target = animation.effect?.target
        if (!target) continue
        let el = target
        let coveredArea = 0
        for (let hop = 0; hop < 4 && el; hop += 1) {
          const rect = el.getBoundingClientRect()
          const area =
            Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) *
            Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0))
          if (area > coveredArea) coveredArea = area
          el = el.parentElement
        }
        if (coveredArea >= viewportArea * 0.5) return true
      }
      return false
    })
  } catch {
    return false
  }
}

async function pollUntil(
  page: Page,
  budgetMs: number,
  signal: AbortSignal | undefined,
  done: (page: Page) => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  while (Date.now() < deadline && !signal?.aborted) {
    if (await done(page)) return
    const slice = Math.min(200, deadline - Date.now())
    if (slice <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, slice)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}

export async function waitForVisibleContent(page: Page, budgetMs: number, signal?: AbortSignal): Promise<void> {
  await pollUntil(page, budgetMs, signal, pageHasMeaningfulContent)
}

const DOM_QUIET_MS = 200

/**
 * 遮罩消失不等于内容画完——很多列表/表格是遮罩一撤就开始逐行渲染。在剩余预算内
 * 等一段 DOM 静默期：装一个 MutationObserver，每次变动就把静默计时器重置，直到
 * 连续 `quietMs` 无变动或触到预算上限才放行。页面已跳转/关闭等取不到时静默放弃，
 * 不影响后续补拍。
 */
async function waitForDomQuiet(page: Page, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
  if (maxWaitMs <= 0) return
  const evaluated = page
    .evaluate(
      ({ quietMs, maxWaitMs: capMs }) => {
        return new Promise<void>((resolve) => {
          const globalAny = globalThis as unknown as {
            document?: { documentElement?: unknown }
            MutationObserver?: new (cb: () => void) => { observe: (target: unknown, opts: unknown) => void; disconnect: () => void }
          }
          const root = globalAny.document?.documentElement
          if (!root || typeof globalAny.MutationObserver !== 'function') {
            resolve()
            return
          }
          let quietTimer: ReturnType<typeof setTimeout>
          const finish = () => {
            clearTimeout(quietTimer)
            clearTimeout(capTimer)
            observer.disconnect()
            resolve()
          }
          const observer = new globalAny.MutationObserver(() => {
            clearTimeout(quietTimer)
            quietTimer = setTimeout(finish, quietMs)
          })
          observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
          quietTimer = setTimeout(finish, quietMs)
          const capTimer = setTimeout(finish, capMs)
        })
      },
      { quietMs: DOM_QUIET_MS, maxWaitMs },
    )
    .catch(() => undefined)
  await Promise.race([
    evaluated,
    new Promise<void>((resolve) => {
      if (!signal) return
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
    }),
  ])
}

/**
 * 等到整页级加载遮罩/动画消失为止，而不是等到「有任意可见内容」——首屏壳层
 * （顶栏、导航）通常从一开始就有文字，`waitForVisibleContent` 会立刻判定满足，
 * 根本等不到遮罩后面的真实内容画出来。遮罩消失后再等一段 DOM 静默期，防止
 * 撤下遮罩那一刻列表/表格还在逐行渲染。全程共用同一个 RETAKE_BUDGET_MS 预算，
 * 不新开一个更长的等待窗口。
 */
export async function waitWhileLoading(page: Page, budgetMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  await pollUntil(page, budgetMs, signal, async (p) => !(await pageLooksLoading(p)))
  if (signal?.aborted) return
  await waitForDomQuiet(page, deadline - Date.now(), signal)
}

function samplePng(bytes: Buffer): number[][] | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) return undefined
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      colorType = bytes[dataStart + 9] ?? 0
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!width || !height || channels === 0 || idat.length === 0) return undefined
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return undefined
  }
  const stride = width * channels
  const samples: number[][] = []
  const points = 24
  for (let index = 0; index < points; index += 1) {
    const x = Math.min(width - 1, Math.floor(((index + 0.5) * width) / points))
    const y = Math.min(height - 1, Math.floor(((index * 7) % points) * height / points))
    const rowStart = y * (stride + 1)
    if (rowStart + 1 + stride > raw.length) return undefined
    const filter = raw[rowStart]
    if (filter !== 0) return undefined
    const pixel = rowStart + 1 + x * channels
    samples.push([raw[pixel] ?? 0, raw[pixel + 1] ?? 0, raw[pixel + 2] ?? 0])
  }
  return samples
}
