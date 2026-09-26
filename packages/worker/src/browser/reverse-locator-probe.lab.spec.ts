/**
 * 阶段 C：定位器反向生成与自愈闭环探针（PAS-P4 / TC-PAS-C01 ~ TC-PAS-C04）
 * 遵循宪法与规范：使用真实 Chromium + 靶场页面（target-surface-lab）验证元素反向提取与自愈闭环。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { RESOLVED_ATTRIBUTE, healingPatchSchema } from '@cairn/shared'
import { generateCandidateFromElement } from './reverse-locator.js'
import { locatorForCandidate } from './runtime.js'

const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

describe('阶段 C：定位器反向生成探针与自愈闭环验证 (PAS-P4 / TC-PAS-C01 ~ C04)', () => {
  let browser: Browser
  let server: ReturnType<typeof createServer>
  let origin = ''

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const relative = extname(raw) ? raw : `${raw}.html`
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server listen failed')
    origin = `http://127.0.0.1:${address.port}`

    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server?.close(() => resolve())).catch(() => undefined)
  })

  // --------------------------------------------------------------------------
  // TC-PAS-C01: 候选反向生成 100% 唯一性与同元素核对
  // --------------------------------------------------------------------------
  it('TC-PAS-C01: 反向生成的候选 100% 通过 count()===1 且解析回绑定的同一元素', async () => {
    const page = await browser.newPage()
    await page.goto(`${origin}/order-flow.html`)

    try {
      // 测试靶场页面中代表性的多个交互元素
      const targetSelectors = [
        '#order-title', // h2 标题
        '#btn-submit-order', // 提交工单按钮
        '#category-select', // 下拉选择框
        '#quantity-input', // 数量输入框
        '#unit-price', // 单价只读框
        '#remarks-input', // 文本域
      ]

      for (const selector of targetSelectors) {
        const token = `tok-${selector.replace(/[^a-zA-Z0-9]/g, '')}`
        const el = page.locator(selector)
        await el.evaluate((node, { attr, t }) => node.setAttribute(attr, t), {
          attr: RESOLVED_ATTRIBUTE,
          t: token,
        })

        const res = await generateCandidateFromElement(page, token)
        expect(res.candidate).toBeDefined()
        const candidate = res.candidate!

        // 1. 验证 count() === 1
        const loc = locatorForCandidate(page, candidate)
        const count = await loc.count()
        expect(count).toBe(1)

        // 2. 验证解析回同一个已绑定的元素
        const boundToken = await loc.getAttribute(RESOLVED_ATTRIBUTE)
        expect(boundToken).toBe(token)

        console.log(`[TC-PAS-C01] 元素 ${selector} 反向生成成功:`, JSON.stringify(candidate))
      }
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-C02: 提案生成与自愈补丁（ADD_CANDIDATE）结构合规
  // --------------------------------------------------------------------------
  it('TC-PAS-C02: 产出 ADD_CANDIDATE 格式的自愈补丁提案', async () => {
    const page = await browser.newPage()
    await page.goto(`${origin}/dynamic-table.html`)
    await page.waitForSelector('#table-body tr', { timeout: 3000 })

    try {
      const token = 'tok-search-btn'
      await page.locator('#btn-search').evaluate(
        (node, attr) => node.setAttribute(attr, 'tok-search-btn'),
        RESOLVED_ATTRIBUTE,
      )

      const res = await generateCandidateFromElement(page, token)
      expect(res.candidate).toBeDefined()

      // 构造自愈补丁提案
      const patch = {
        kind: 'ADD_CANDIDATE' as const,
        suggestedCandidate: res.candidate!,
      }

      // 补丁必须符合共享契约，才能进入修复候选链路
      expect(healingPatchSchema.safeParse(patch).success).toBe(true)

      console.log('[TC-PAS-C02] 成功构造 ADD_CANDIDATE 自愈补丁:', JSON.stringify(patch))
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-C03: 不支持范围（iframe、Canvas 等）不产出候选，原因可追溯
  // --------------------------------------------------------------------------
  it('TC-PAS-C03: 不支持范围（Canvas、iframe 等）不产出候选且原因可追溯', async () => {
    const page = await browser.newPage()
    await page.goto(`${origin}/canvas.html`)

    try {
      const token = 'tok-canvas'
      await page.locator('#board').evaluate(
        (node, attr) => node.setAttribute(attr, 'tok-canvas'),
        RESOLVED_ATTRIBUTE,
      )

      const res = await generateCandidateFromElement(page, token)
      expect(res.candidate).toBeUndefined()
      expect(res.reason).toBe('unsupported_element_type: canvas')
      console.log('[TC-PAS-C03] Canvas 元素阻断成功，原因:', res.reason)
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-C04: 与自愈方案 SH 用例衔接（应用新候选后重试直接命中）
  // --------------------------------------------------------------------------
  it('TC-PAS-C04: 自愈衔接：将反向生成的候选应用到步骤后，下一次执行直接命中', async () => {
    const page = await browser.newPage()
    await page.goto(`${origin}/order-flow.html`)

    try {
      // 原选择器已失效
      expect(await page.locator('#non-existent-button-999').count()).toBe(0)

      // 模拟 AI 定位成功并绑定了真实按钮
      const token = 'tok-healed-submit'
      await page.locator('#btn-submit-order').evaluate(
        (node, attr) => node.setAttribute(attr, 'tok-healed-submit'),
        RESOLVED_ATTRIBUTE,
      )

      // 反向生成候选
      const res = await generateCandidateFromElement(page, token)
      expect(res.candidate).toBeDefined()

      // 反向生成的候选不再依赖运行期绑定标记，也能确定性唯一命中
      await page.locator('#btn-submit-order').evaluate((node, attr) => node.removeAttribute(attr), RESOLVED_ATTRIBUTE)
      const count = await locatorForCandidate(page, res.candidate!).count()
      expect(count).toBe(1)

      console.log('[TC-PAS-C04] 自愈补丁应用成功，新候选可直接确定性命中:', JSON.stringify(res.candidate))
    } finally {
      await page.close()
    }
  })
})
