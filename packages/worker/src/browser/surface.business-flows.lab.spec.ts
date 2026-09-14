import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { dumpTestFailureArtifacts } from '../testing/failure-artifacts.js'

import { pathToFileURL } from 'node:url'

type LabServerHandle = {
  port: number
  url: string
  close: () => Promise<void>
}

describe('靶场业务仿真流（Auth / Order / Dynamic Table）', { timeout: 30_000 }, () => {
  let lab: LabServerHandle
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const labServerPath = resolve(__dirname, '../../../../tests/target-surface-lab/server.mjs')
    const labModule = (await import(pathToFileURL(labServerPath).href)) as {
      startLabServer: (port?: number) => Promise<LabServerHandle>
    }
    lab = await labModule.startLabServer(0)
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    page = await context.newPage()
  })

  afterAll(async () => {
    if (page) await page.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (lab) await lab.close().catch(() => {})
  })

  it('多步骤认证流 (/auth-flow): 密码 -> OTP -> 令牌持久化', async () => {
    await page.goto(`${lab.url}/auth-flow`)
    expect(await page.locator('#auth-title').innerText()).toBe('目标系统安全登录')

    // 步骤 1: 错误密码校验
    await page.fill('#username', 'lab-admin')
    await page.fill('#password', 'wrong-pass')
    await page.click('#btn-login-step1')
    expect(await page.locator('#err-password').isVisible()).toBe(true)

    // 步骤 1: 正确密码
    await page.fill('#password', 'password123')
    await page.click('#btn-login-step1')

    // 步骤 2: OTP 页面展示
    expect(await page.locator('#step-otp').isVisible()).toBe(true)
    await page.fill('#otp-code', '888888')
    await page.click('#btn-verify-otp')

    // 步骤 3: 认证成功
    expect(await page.locator('#auth-success').isVisible()).toBe(true)
    expect(await page.locator('#auth-status').innerText()).toBe('AUTHENTICATED')
    expect(await page.locator('#welcome-msg').innerText()).toContain('lab-admin')
  })

  it('业务工单流 (/order-flow): 级联下拉 -> 金额计算 -> 模态确认 -> 单号生成', async () => {
    page.on('console', (msg) => console.log('[PAGE CONSOLE]', msg.text()))
    page.on('pageerror', (err) => console.error('[PAGE ERROR]', err))
    await page.goto(`${lab.url}/order-flow`)
    expect(await page.locator('#order-title').innerText()).toBe('新建业务采购工单')

    // 级联选择
    await page.locator('#category-select').selectOption('hardware')
    await page.waitForSelector('#product-select option[value="hw-srv"]', { state: 'attached' })
    await page.locator('#product-select').selectOption('hw-srv')

    // 输入数量与备注
    await page.fill('#quantity-input', '2')
    expect(await page.locator('#total-amount').innerText()).toBe('¥ 37600.00')
    await page.fill('#remarks-input', '核心机房扩容采购')

    // 触发提交模态框
    await page.click('#btn-submit-order')
    expect(await page.locator('#confirm-modal').isVisible()).toBe(true)

    // 确认提交
    await page.click('#btn-modal-confirm')
    expect(await page.locator('#order-result').isVisible()).toBe(true)
    const orderNo = await page.locator('#order-no-display').innerText()
    expect(orderNo).toMatch(/^ORD-[A-Z0-9]+$/)
  })

  it('动态表格流 (/dynamic-table): 异步加载 -> 搜索过滤 -> 行内操作 -> 模态删除', async () => {
    await page.goto(`${lab.url}/dynamic-table`)
    expect(await page.locator('#table-title').innerText()).toBe('企业采购订单列表')

    // 初始状态校验
    await page.waitForSelector('#order-table tbody tr')
    expect(await page.locator('#total-count').innerText()).toBe('5')

    // 搜索过滤
    await page.fill('#search-input', '未来科技')
    await page.click('#btn-search')
    await page.waitForTimeout(100)
    expect(await page.locator('#total-count').innerText()).toBe('1')
    expect(await page.locator('.customer-name').innerText()).toBe('未来科技有限责任公司')

    // 重置搜索
    await page.fill('#search-input', '')
    await page.click('#btn-search')
    await page.waitForTimeout(100)
    expect(await page.locator('#total-count').innerText()).toBe('5')

    // 删除行 ORD-101
    await page.click('tr[data-id="ORD-101"] .btn-delete')
    expect(await page.locator('#delete-modal').isVisible()).toBe(true)
    await page.click('#btn-confirm-delete')

    // 验证删除后记录总数减少为 4
    await page.waitForTimeout(100)
    expect(await page.locator('#total-count').innerText()).toBe('4')
    expect(await page.locator('tr[data-id="ORD-101"]').count()).toBe(0)
  })

  it('测试失败自动捕获工件 (dumpTestFailureArtifacts)', async () => {
    const dumped = await dumpTestFailureArtifacts({
      testName: 'business_flow_spec_sample',
      page,
      error: new Error('Simulated test failure for artifact verification'),
      context: {
        currentUrl: page.url(),
        testSessionId: 'sess-test-999',
        targetAccountSecret: 'my-super-secret-password-12345',
      },
    })

    expect(dumped.artifactDir).toBeDefined()
    expect(dumped.domPath).toBeDefined()
    expect(dumped.screenshotPath).toBeDefined()
    expect(dumped.contextPath).toBeDefined()
  })
})
