import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { RESOLVED_ATTRIBUTE } from '@cairn/shared'
import { generateCandidateFromElement } from './reverse-locator.js'

describe('ReverseLocator (定位器反向生成与单元素验证)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await page?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  })

  it('优先生成 role+name 候选且通过 count()===1 验证', async () => {
    await page.setContent(`
      <div>
        <button id="btn1">提交采购工单</button>
      </div>
    `)
    const token = 'tok-1'
    await page.locator('#btn1').evaluate((el, attr) => el.setAttribute(attr, 'tok-1'), RESOLVED_ATTRIBUTE)

    const result = await generateCandidateFromElement(page, token)
    expect(result.candidate).toEqual({
      by: 'role',
      value: 'button',
      name: '提交采购工单',
    })
  })

  it('无有效 role 时降级至 label 候选', async () => {
    await page.setContent(`
      <div>
        <div id="card1" aria-label="客户详情卡片">客户详细信息</div>
      </div>
    `)
    const token = 'tok-2'
    await page.locator('#card1').evaluate((el, attr) => el.setAttribute(attr, 'tok-2'), RESOLVED_ATTRIBUTE)

    const result = await generateCandidateFromElement(page, token)
    expect(result.candidate).toEqual({
      by: 'label',
      value: '客户详情卡片',
    })
  })

  it('存在 data-testid 时可生成 testId 候选', async () => {
    await page.setContent(`
      <div id="d1" data-testid="order-summary-card">
        <div>复杂内容</div>
      </div>
    `)
    const token = 'tok-3'
    await page.locator('#d1').evaluate((el, attr) => el.setAttribute(attr, 'tok-3'), RESOLVED_ATTRIBUTE)

    const result = await generateCandidateFromElement(page, token)
    expect(result.candidate).toEqual({
      by: 'testId',
      value: 'order-summary-card',
    })
  })

  it('纯文本元素生成 text 候选', async () => {
    await page.setContent(`
      <span id="s1">当前状态：待财务审批</span>
    `)
    const token = 'tok-4'
    await page.locator('#s1').evaluate((el, attr) => el.setAttribute(attr, 'tok-4'), RESOLVED_ATTRIBUTE)

    const result = await generateCandidateFromElement(page, token)
    expect(result.candidate).toEqual({
      by: 'text',
      value: '当前状态：待财务审批',
    })
  })

  it('当高优先级候选存在重复 (count > 1) 时，自动降级至具有唯一性的候选', async () => {
    await page.setContent(`
      <div>
        <button class="del-btn">删除</button>
        <button class="del-btn" data-testid="unique-delete-target">删除</button>
        <button class="del-btn">删除</button>
      </div>
    `)
    const token = 'tok-dup'
    // 绑定第二个按钮
    await page.locator('[data-testid="unique-delete-target"]').evaluate(
      (el, attr) => el.setAttribute(attr, 'tok-dup'),
      RESOLVED_ATTRIBUTE,
    )

    const result = await generateCandidateFromElement(page, token)
    // role 'button' with name '删除' count 为 3，text '删除' count 为 3
    // 自动降级为具有唯一性的 testId 候选
    expect(result.candidate).toEqual({
      by: 'testId',
      value: 'unique-delete-target',
    })
  })

  it('所有候选均不具有唯一性 (count > 1) 时丢弃，绝不盲目输出', async () => {
    await page.setContent(`
      <div>
        <button>查看</button>
        <button id="target">查看</button>
      </div>
    `)
    const token = 'tok-all-dup'
    await page.locator('#target').evaluate((el, attr) => el.setAttribute(attr, 'tok-all-dup'), RESOLVED_ATTRIBUTE)

    const result = await generateCandidateFromElement(page, token)
    expect(result.candidate).toBeUndefined()
    expect(result.reason).toBe('no_candidate_passed_uniqueness_verification')
  })

  it('不支持 iframe 与 canvas 元素反向生成候选', async () => {
    await page.setContent(`
      <canvas id="c1" width="100" height="100"></canvas>
      <iframe id="f1" src="about:blank"></iframe>
    `)

    const tokenCanvas = 'tok-canvas'
    await page.locator('#c1').evaluate((el, attr) => el.setAttribute(attr, 'tok-canvas'), RESOLVED_ATTRIBUTE)
    const resCanvas = await generateCandidateFromElement(page, tokenCanvas)
    expect(resCanvas.candidate).toBeUndefined()
    expect(resCanvas.reason).toContain('unsupported_element_type: canvas')

    const tokenIframe = 'tok-iframe'
    await page.locator('#f1').evaluate((el, attr) => el.setAttribute(attr, 'tok-iframe'), RESOLVED_ATTRIBUTE)
    const resIframe = await generateCandidateFromElement(page, tokenIframe)
    expect(resIframe.candidate).toBeUndefined()
    expect(resIframe.reason).toContain('unsupported_element_type: iframe')
  })
})
