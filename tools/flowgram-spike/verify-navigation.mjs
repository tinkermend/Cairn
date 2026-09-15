import assert from 'node:assert/strict'
import { session, sample, artifact, save } from './browser.mjs'

// Real sample reads and local draft interactions; artificial cases intercept GET
// responses only. This check never saves a draft or starts a business run.
const s = await session({ width: 1440, height: 1000 })
const checks = []
const check = (name) => { checks.push(name); console.log('PASS', name) }
const button = (name) => s.page.getByRole('button', { name, exact: true })
const ready = async (count = 10) => {
  await s.page.waitForFunction((count) => document.querySelectorAll('[data-flow-step]').length === count, count)
  await button('纵向').click()
  await s.page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('[data-flow-step]')].map((node) => node.getBoundingClientRect())
    return nodes.every((node) => node.width === 300 && Math.abs(node.x - nodes[0].x) < 1)
  })
}
const shot = (name) => s.page.screenshot({ path: artifact(name), fullPage: true, animations: 'disabled' })
const waitOrder = (ids) => s.page.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('[data-flow-step]')].sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y).map((node) => node.dataset.flowStep)) === JSON.stringify(ids), ids)
const locate = async (ordinal) => {
  await s.page.getByRole('combobox', { name: '定位步骤', exact: true }).click()
  await s.page.getByRole('option', { name: new RegExp(`^${String(ordinal).padStart(2, '0')} · `) }).click()
  await s.page.waitForFunction(() => {
    const node = document.querySelector('.flowgram-step.is-selected')?.getBoundingClientRect()
    const surface = document.querySelector('.flowgram-surface')?.getBoundingClientRect()
    return node && surface && node.width > 290 && node.top >= surface.top && node.bottom <= surface.bottom
  })
}

try {
  const original = await s.request(`/scenarios/${sample.scenarioId}`)
  const ids = original.draft.document.steps.map((step) => step.id)
  await s.page.goto(`${sample.url}&runId=${sample.successfulRunId}`)
  await ready()
  await s.page.waitForFunction(() => [...document.querySelectorAll('[data-flow-step]')].every((node) => node.textContent.includes('试跑 成功')))
  const steps = await s.page.getByRole('region', { name: '执行步骤', exact: true }).boundingBox()
  const properties = await s.page.getByRole('region', { name: '步骤属性', exact: true }).boundingBox()
  assert.ok(properties.x >= steps.x + steps.width)
  assert.equal(await s.page.getByRole('dialog').count(), 0)
  const nodeXs = await s.page.locator('[data-flow-step]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x))
  assert.ok(nodeXs.every((x) => Math.abs(x - nodeXs[0]) < 1))
  await shot('navigation-desktop.png')
  check('恢复纵向画布与常驻属性并排；真实 10 步和历史状态可见，无属性抽屉')

  await button('查看全流程').click()
  await locate(10)
  const name = s.page.getByLabel('步骤名称', { exact: true })
  assert.equal(await name.inputValue(), original.draft.document.steps[9].name)
  await name.fill('连续编辑验证 · 未保存')
  await button('定位上一步').click()
  assert.equal(await name.inputValue(), original.draft.document.steps[8].name)
  await button('定位下一步').click()
  assert.equal(await name.inputValue(), '连续编辑验证 · 未保存')
  await button('步骤列表').click()
  assert.equal(await name.inputValue(), '连续编辑验证 · 未保存')
  await s.page.waitForFunction(() => {
    const a = document.querySelector('[data-list-step]:last-child').getBoundingClientRect()
    const b = document.querySelector('[aria-label="有序步骤列表"]').getBoundingClientRect()
    return a.top >= b.top && a.bottom <= b.bottom
  })
  await name.fill(original.draft.document.steps[9].name)
  await s.page.locator(`[data-list-step="${ids[1]}"] button`).click()
  assert.equal(await name.inputValue(), original.draft.document.steps[1].name)
  const borders = await s.page.locator('[data-list-step] button[aria-pressed=false]').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderColor))
  assert.equal(new Set(borders).size, 1)
  assert.ok((await s.page.locator(`[data-list-step="${ids[1]}"]`).textContent()).includes('1 项提醒'))
  assert.ok((await s.page.getByRole('region', { name: '步骤属性', exact: true }).textContent()).includes('只用 CSS 定位'))
  await shot('navigation-list.png')
  check('前后切换直接编辑；跨视图保留字段与选择；列表自动定位，普通与提醒项使用同一中性边框')

  await button('流程画布').click()
  await ready()
  await locate(5)
  await button('下移').click()
  await waitOrder([...ids.slice(0, 4), ids[5], ids[4], ...ids.slice(6)])
  assert.ok(await s.page.locator('[data-flow-step]').filter({ hasText: '引用 / 字段异常' }).count() > 0)
  assert.equal(await button('试跑').isDisabled(), true)
  await button('撤销结构操作').click()
  await waitOrder(ids)
  await locate(1)
  const a = await s.page.locator(`[data-flow-step="${ids[0]}"] .flowgram-drag`).boundingBox()
  const b = await button(`在${sample.steps[1].name}后插入步骤`).boundingBox()
  await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await s.page.mouse.down()
  await s.page.mouse.move(a.x + 25, a.y + 25, { steps: 5 })
  await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
  await s.page.locator('.flowgram-drop-highlight').waitFor()
  await s.page.mouse.up()
  await waitOrder([ids[1], ids[0], ...ids.slice(2)])
  await button('撤销结构操作').click()
  await waitOrder(ids)
  check('按钮与真实拖动重排可用，引用失效阻止试跑，结构撤销恢复原序列')

  for (const width of [1024, 390]) {
    await s.page.setViewportSize({ width, height: 1000 })
    await s.page.goto(`${sample.url}&runId=${sample.successfulRunId}`)
    await ready()
    await locate(10)
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await shot(`navigation-${width}.png`)
    if (width === 390) {
      await s.page.locator('.flowgram-step.is-selected .flowgram-step-body').click()
      assert.equal(await name.isVisible(), true)
      await button('返回步骤列表').click()
    }
    await button('步骤列表').click()
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await shot(`navigation-list-${width}.png`)
    check(`${width}px 两视图无页面横向溢出，窄屏保留原步骤 / 属性切换`)
  }

  const long = structuredClone(original)
  long.name = '32 步长序列 · 前端定位验证样本'
  for (let index = 10; index < 32; index++) long.draft.document.steps.push({ ...structuredClone(original.draft.document.steps[0]), id: crypto.randomUUID(), name: `步骤 ${index + 1} · 核对跨部门采购订单及关联业务信息，用于验证较长中文名称的显示和步骤定位` })
  await s.page.route(`**/api/scenarios/${sample.scenarioId}`, (route) => route.fulfill({ json: long }))
  await s.page.setViewportSize({ width: 1440, height: 1000 })
  await s.page.goto(sample.url)
  await ready(32)
  await locate(32)
  assert.equal(await name.inputValue(), long.draft.document.steps[31].name)
  assert.equal(await button('添加步骤').isDisabled(), true)
  await shot('navigation-32-steps.png')
  await button('步骤列表').click()
  assert.equal(await name.inputValue(), long.draft.document.steps[31].name)
  await s.page.unroute(`**/api/scenarios/${sample.scenarioId}`)
  check('32 步前端样本可直接定位到末步并立即编辑，达到领域上限后禁止添加')

  await s.page.route('**/api/me', async (route) => {
    const response = await route.fetch(), json = await response.json()
    json.account.permissions = json.account.permissions.filter((permission) => permission !== 'workflow:write')
    await route.fulfill({ response, json })
  })
  await s.page.goto(sample.url)
  await ready()
  await locate(5)
  assert.equal(await name.isDisabled(), true)
  assert.equal(await button('上移').isDisabled(), true)
  assert.ok(await s.page.locator('.flowgram-drag,.flowgram-insert').evaluateAll((buttons) => buttons.every((button) => button.disabled)))
  await s.page.unroute('**/api/me')
  check('只读前端权限样本仍可定位与查看，字段及结构编辑保持禁用')

  assert.deepEqual((await s.request(`/scenarios/${sample.scenarioId}`)).draft, original.draft)
  assert.deepEqual(s.errors, [])
  await save('navigation-checks.json', { checks, errors: s.errors, revision: original.draft.revision, mutatedBackend: false })
} catch (error) {
  await shot('navigation-failure.png')
  await save('navigation-checks.json', { checks, errors: s.errors, failure: error.message })
  throw error
} finally { await s.browser.close() }
