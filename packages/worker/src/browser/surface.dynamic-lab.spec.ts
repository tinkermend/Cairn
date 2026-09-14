import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

describe('声明式动态测试靶场引擎 (Configurable Lab Engine)', () => {
  let labHandle: { url: string; close: () => Promise<void> }
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    // 动态加载避免被 check-deps 阻断
    const serverModulePath = resolve(__dirname, '../../../../tests/target-surface-lab/server.mjs')
    const { startLabServer } = await import(pathToFileURL(serverModulePath).href)
    labHandle = await startLabServer(0)

    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    if (browser) await browser.close()
    if (labHandle) await labHandle.close()
  })

  it('网络混沌端点 /lab/chaos 支持模拟状态码与网络延迟', async () => {
    const start = Date.now()
    const res = await fetch(`${labHandle.url}/lab/chaos?status=504&delay=50`)
    const duration = Date.now() - start

    expect(res.status).toBe(504)
    expect(duration).toBeGreaterThanOrEqual(40)
    const json = (await res.json()) as { status: number }
    expect(json.status).toBe(504)
  })

  it('声明式动态 DOM 渲染与前后端双向事实源断言闭环', async () => {
    // 1. 声明页面要素
    const spec = {
      title: '自动化开户声明式测试页',
      elements: [
        { tag: 'input', id: 'tenant-name', name: 'tenantName', placeholder: '请输入企业全称' },
        {
          tag: 'select',
          id: 'tenant-plan',
          name: 'plan',
          options: [
            { value: 'free', label: '基础免费版' },
            { value: 'enterprise', label: '企业旗舰版' },
          ],
        },
        { tag: 'button', id: 'btn-create', text: '开通租户账户' },
      ],
      submitAction: {
        apiEndpoint: `${labHandle.url}/lab/api/submit`,
        successMessage: '租户开通成功',
      },
    }

    const dynamicUrl = `${labHandle.url}/lab/dynamic?spec=${encodeURIComponent(JSON.stringify(spec))}`

    // 2. 真实 Chromium 访问该声明式页面
    await page.goto(dynamicUrl)
    const titleText = await page.locator('#page-title').innerText()
    expect(titleText).toBe('自动化开户声明式测试页')

    // 3. 填写表单
    await page.locator('#tenant-name').fill('识途智能科技有限公司')
    await page.locator('#tenant-plan').selectOption('enterprise')

    // 4. 点击提交并断言前端 DOM 回显
    await page.locator('#btn-create').click()
    const banner = page.locator('#result-banner')
    await banner.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(
      'document.getElementById("result-banner")?.innerText.includes("租户开通成功")',
      { timeout: 5000 },
    )
    const bannerText = await banner.innerText()
    expect(bannerText).toContain('租户开通成功')

    // 5. 反向检查靶场服务端内存事实源 (/lab/inspect)
    const inspectRes = await fetch(`${labHandle.url}/lab/inspect`)
    const inspectData = (await inspectRes.json()) as {
      total: number
      records: Array<{ data: Record<string, unknown> }>
    }

    expect(inspectData.total).toBeGreaterThanOrEqual(1)
    const latestRecord = inspectData.records[inspectData.records.length - 1]
    expect(latestRecord?.data).toEqual({
      tenantName: '识途智能科技有限公司',
      plan: 'enterprise',
    })
  })
})
