import assert from 'node:assert/strict'
import { session, sample, artifact, save } from './browser.mjs'

// Exercise the real editor and API reads without saving or starting a Run.
const s = await session({ width: 1440, height: 1000 })
const checks = [], measurements = {}
s.page.on('pageerror', (error) => console.error('PAGE ERROR after', checks.at(-1), error.stack))
const check = (name) => { checks.push(name); console.log('PASS', name) }
const button = (name) => s.page.getByRole('button', { name, exact: true })
const shot = async (name) => {
  await s.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  return s.page.screenshot({ path: artifact(`snake-${name}.png`), fullPage: true, animations: 'disabled' })
}
const ready = async (count = 10, arrangement = 'snake') => {
  await s.page.waitForFunction(({ count, arrangement }) => document.querySelectorAll('[data-flow-step]').length === count && document.querySelector('.flowgram-sequence')?.dataset.arrangement === arrangement, { count, arrangement })
  await s.page.waitForFunction(() => [...document.querySelectorAll('[data-flow-step]')].every((node) => node.getBoundingClientRect().width > 230))
  await s.page.waitForFunction((arrangement) => {
    const nodes = [...document.querySelectorAll('[data-flow-step]')].map((node) => node.getBoundingClientRect())
    return arrangement === 'vertical' ? nodes.every((node) => Math.abs(node.x - nodes[0].x) < 1 && node.width === 300) : nodes[0].y === nodes[1].y && Math.abs(nodes[0].x - nodes[1].x) > 200
  }, arrangement)
}
const nodes = () => s.page.locator('[data-flow-step]').evaluateAll((nodes) => nodes.map((node) => {
  const rect = node.getBoundingClientRect(), body = node.querySelector('.flowgram-step-body')
  return { id: node.dataset.flowStep, ordinal: Number(body.getAttribute('aria-label').match(/^步骤 (\d+) /)[1]), x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right, font: getComputedStyle(node.querySelector('.flowgram-step-name')).fontSize }
}).sort((a, b) => a.ordinal - b.ordinal))
const waitOrder = (ids) => s.page.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('[data-flow-step]')].sort((a, b) => Number(a.querySelector('.flowgram-step-body').getAttribute('aria-label').match(/^步骤 (\d+) /)[1]) - Number(b.querySelector('.flowgram-step-body').getAttribute('aria-label').match(/^步骤 (\d+) /)[1])).map((node) => node.dataset.flowStep)) === JSON.stringify(ids), ids)
const visibleCount = async () => {
  const surface = await s.page.locator('.flowgram-surface').boundingBox()
  return (await nodes()).filter((node) => node.y >= surface.y && node.bottom <= surface.y + surface.height && node.x >= surface.x && node.right <= surface.x + surface.width).length
}
const locate = async (ordinal) => {
  await s.page.getByRole('combobox', { name: '定位步骤', exact: true }).click()
  await s.page.getByRole('option', { name: new RegExp(`^${String(ordinal).padStart(2, '0')} · `) }).click()
  await s.page.waitForFunction(() => {
    const node = document.querySelector('.flowgram-step.is-selected')?.getBoundingClientRect()
    const surface = document.querySelector('.flowgram-surface')?.getBoundingClientRect()
    return node && surface && node.width > 230 && node.top >= surface.top && node.bottom <= surface.bottom && node.left >= surface.left && node.right <= surface.right
  })
}
const dragAfter = async (id, afterId, expected) => {
  const a = await s.page.locator(`[data-flow-step="${id}"] .flowgram-drag`).boundingBox()
  const target = s.page.locator(`[data-flow-step="${afterId}"] .flowgram-step-name`)
  const b = await button(`在${await target.textContent()}后插入步骤`).boundingBox()
  await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await s.page.mouse.down()
  await s.page.mouse.move(a.x + a.width / 2 + 18, a.y + a.height / 2 + 18, { steps: 5 })
  await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 })
  await s.page.locator('.flowgram-drop-highlight').waitFor()
  await s.page.mouse.up()
  await waitOrder(expected)
}
try {
  const original = await s.request(`/scenarios/${sample.scenarioId}`)
  const ids = original.draft.document.steps.map((step) => step.id)
  await s.page.goto(`${sample.url}&runId=${sample.successfulRunId}`)
  await ready()
  await s.page.waitForFunction(() => [...document.querySelectorAll('[data-flow-step]')].every((node) => node.textContent.includes('试跑 成功')))
  const folded = await nodes()
  for (let i = 0; i < folded.length; i += 2) {
    assert.equal(folded[i].y, folded[i + 1].y)
    assert.ok(i % 4 === 0 ? folded[i].x < folded[i + 1].x : folded[i].x > folded[i + 1].x)
  }
  assert.deepEqual(folded.map((node) => node.id), ids)
  measurements.snake1440 = { count: await visibleCount(), font: folded[0].font, surface: await s.page.locator('.flowgram-surface').boundingBox() }
  assert.ok(await s.page.locator('[data-sequence-arrow]').count() >= 7)
  await shot('desktop')
  await button('纵向').click()
  await ready(10, 'vertical')
  await s.page.waitForFunction(() => [...document.querySelectorAll('[data-flow-step]')].every((node) => node.getBoundingClientRect().width === 300))
  const vertical = await nodes()
  measurements.vertical1440 = { count: await visibleCount(), font: vertical[0].font, surface: await s.page.locator('.flowgram-surface').boundingBox() }
  assert.ok(vertical.every((node) => Math.abs(node.x - vertical[0].x) < 1))
  assert.equal(measurements.snake1440.font, measurements.vertical1440.font)
  assert.ok(measurements.snake1440.count > measurements.vertical1440.count)
  await shot('vertical-comparison')
  await button('折行').click()
  await ready()
  check('真实 10 步蛇形顺序、方向箭头、纵向切换；同字号和同画布高度的可见步数提升')

  await locate(1)
  await dragAfter(ids[0], ids[1], [ids[1], ids[0], ...ids.slice(2)])
  await button('撤销结构操作').click()
  await waitOrder(ids)
  await locate(1)
  await dragAfter(ids[0], ids[2], [ids[1], ids[2], ids[0], ...ids.slice(3)])
  await button('撤销结构操作').click()
  await waitOrder(ids)
  await locate(1)
  await button(`在${sample.steps[1].name}后插入步骤`).click()
  await s.page.getByRole('menuitem', { name: '断言', exact: true }).click()
  await ready(11)
  const inserted = await nodes()
  assert.deepEqual(inserted.slice(0, 2).map((node) => node.id), ids.slice(0, 2))
  assert.equal(inserted[3].id, ids[2])
  await button('撤销结构操作').click()
  await waitOrder(ids)
  check('行尾和反向行真实鼠标拖动、行尾插入均修改正确顺序；结构撤销恢复')

  await locate(5)
  await button('下移').click()
  await waitOrder([...ids.slice(0, 4), ids[5], ids[4], ...ids.slice(6)])
  assert.equal(await button('试跑').isDisabled(), true)
  assert.ok(await s.page.locator('[data-flow-step] [title="引用 / 字段异常"]').count() > 0)
  await shot('diagnostics')
  await button('撤销结构操作').click()
  await waitOrder(ids)
  await button('查看全流程').click()
  await locate(10)
  const name = s.page.getByLabel('步骤名称', { exact: true })
  await name.fill('未保存的长名称 · 检查业务订单与关联客户信息以及后续采购登记步骤')
  await button('纵向').click()
  await ready(10, 'vertical')
  assert.equal(await name.inputValue(), '未保存的长名称 · 检查业务订单与关联客户信息以及后续采购登记步骤')
  await button('步骤列表').click()
  await button('流程画布').click()
  await ready(10, 'vertical')
  assert.equal(await button('纵向').getAttribute('aria-pressed'), 'true')
  await button('折行').click()
  await ready()
  await locate(10)
  await shot('long-name')
  const overflow = await s.page.locator('.flowgram-step.is-selected').evaluate((node) => {
    const r = node.getBoundingClientRect(), hint = node.querySelector('.flowgram-step-hint').getBoundingClientRect()
    return hint.bottom > r.bottom - 4
  })
  assert.equal(overflow, false, 'Long name must leave space for the step contract hint')
  await button('步骤列表').click()
  assert.equal(await name.inputValue(), '未保存的长名称 · 检查业务订单与关联客户信息以及后续采购登记步骤')
  await button('定位上一步').click()
  await button('定位下一步').click()
  assert.equal(await name.inputValue(), '未保存的长名称 · 检查业务订单与关联客户信息以及后续采购登记步骤')
  check('概览后定位、长名称、跨排布和列表切换保留编辑；引用错误仍阻止试跑')

  for (const withRun of [true, false]) {
    await s.page.goto(withRun ? `${sample.url}&runId=${sample.successfulRunId}` : sample.url)
    await ready()
    await button('步骤列表').click()
    const left = s.page.getByRole('region', { name: '执行步骤', exact: true })
    const right = s.page.getByRole('region', { name: '步骤属性', exact: true })
    const a = await left.boundingBox(), b = await right.boundingBox()
    const grid = await left.evaluate((node) => ({ width: node.parentElement.getBoundingClientRect().width, right: node.parentElement.getBoundingClientRect().right, columns: getComputedStyle(node.parentElement).gridTemplateColumns }))
    assert.equal(grid.columns.split(' ').length, 2)
    assert.ok(Math.abs(b.x + b.width - grid.right) < 2)
    assert.ok(a.width + b.width > grid.width * 0.97)
    measurements[withRun ? 'listWithRun' : 'listWithoutRun'] = grid
    await shot(withRun ? 'list-with-run' : 'list-without-run')
  }
  check('带历史试跑与不带试跑的列表均用满两列宽度，消除预留的第三空列')

  for (const width of [1920, 1366, 1024, 390]) {
    await s.page.setViewportSize({ width, height: 1000 })
    await s.page.goto(`${sample.url}&runId=${sample.successfulRunId}`)
    await ready(10, width >= 1366 ? 'snake' : 'vertical')
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    measurements[`canvas${width}`] = { count: await visibleCount(), surface: await s.page.locator('.flowgram-surface').boundingBox() }
    if (width === 1920) {
      assert.equal(await s.page.locator('[data-sequence-arrow]').count(), 9)
      assert.equal(measurements.canvas1920.count, 10)
      measurements.arrowPaths = await s.page.locator('[data-line-id][marker-end]').evaluateAll((nodes) => nodes.map((node) => ({ id: node.getAttribute('data-line-id'), d: node.getAttribute('d') })))
      assert.deepEqual(measurements.arrowPaths.map((line) => line.id), ids.slice(0, -1))
      assert.deepEqual(measurements.arrowPaths.map((line) => {
        const [x1, y1, x2, y2] = line.d.match(/-?\d+(?:\.\d+)?/g).map(Number)
        return y2 > y1 ? 'down' : x2 > x1 ? 'right' : 'left'
      }), ['right', 'right', 'down', 'left', 'left', 'down', 'right', 'right', 'down'])
    }
    await shot(String(width))
    if (width === 1920) {
      await locate(1)
      await dragAfter(ids[0], ids[1], [ids[1], ids[0], ...ids.slice(2)])
      await button('撤销结构操作').click()
      await waitOrder(ids)
    }
    await locate(10)
    if (width === 390) {
      await s.page.locator('.flowgram-step.is-selected .flowgram-step-body').click()
      assert.equal(await name.isVisible(), true)
      await button('返回步骤列表').click()
    }
    await button('步骤列表').click()
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    if (width === 390) await shot('mobile-list')
  }
  check('1920 / 1366 / 1024 / 390px 自适应，无页面横向溢出；窄屏单列与属性切换正常')

  const long = structuredClone(original)
  long.name = '32 步长序列 · 前端排布验证样本'
  for (let index = 10; index < 32; index++) long.draft.document.steps.push({ ...structuredClone(original.draft.document.steps[0]), id: crypto.randomUUID(), name: `步骤 ${index + 1} · 核对跨部门采购订单及关联业务信息，用于验证较长中文名称的显示和步骤定位` })
  await s.page.route(`**/api/scenarios/${sample.scenarioId}`, (route) => route.fulfill({ json: long }))
  await s.page.setViewportSize({ width: 1440, height: 1000 })
  await s.page.goto(sample.url)
  await ready(32)
  await locate(32)
  assert.equal(await name.inputValue(), long.draft.document.steps[31].name)
  assert.equal(await button('添加步骤').isDisabled(), true)
  assert.ok(await s.page.locator('.flowgram-insert').evaluateAll((buttons) => buttons.every((button) => button.disabled)))
  await shot('32-steps')
  await s.page.unroute(`**/api/scenarios/${sample.scenarioId}`)
  check('32 步前端样本可定位并读取完整长名称，上限保持禁止添加')

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
  await button('纵向').click()
  await ready(10, 'vertical')
  await s.page.unroute('**/api/me')
  check('只读权限前端样本可切换排布和查看属性，编辑与拖动禁用')

  assert.deepEqual((await s.request(`/scenarios/${sample.scenarioId}`)).draft, original.draft)
  assert.deepEqual(s.errors, [])
  await save('snake-checks.json', { checks, measurements, errors: s.errors, revision: original.draft.revision, mutatedBackend: false })
} catch (error) {
  await shot('failure')
  await save('snake-checks.json', { checks, measurements, errors: s.errors, failure: error.message })
  throw error
} finally { await s.browser.close() }
