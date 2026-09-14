/** 实际 Vite / React 页面验收。所有 API 请求隔离在本浏览器，不读写真实数据。 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(root, 'packages/web/package.json'))
const { chromium } = require('playwright')
const origin = process.env.CAIRN_WEB_REVIEW_ORIGIN ?? 'http://127.0.0.1:5173'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), '仅连接本地 Web 预览')
const output = path.join(import.meta.dirname, 'screenshots')
await mkdir(output, { recursive: true })
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const timestamp = '2026-09-13T01:30:00.000Z'
const targetBase = { authMethod: 'password', captchaMode: 'none', status: 'active', loginUrl: null, loginFields: null, accountCount: 2, createdAt: timestamp, updatedAt: timestamp }
const targets = [
  { ...targetBase, id: id(1), name: '零售运营平台', code: 'retail-ops', entryUrl: 'https://retail.example.test/console' },
  { ...targetBase, id: id(2), name: '供应链协同系统', code: 'supply-chain', entryUrl: 'https://supply.example.test', captchaMode: 'image' },
  { ...targetBase, id: id(3), name: '客户服务工作台', code: 'customer-service', entryUrl: 'https://service.example.test', authMethod: 'manual', accountCount: 4 },
  { ...targetBase, id: id(4), name: '财务结算中心', code: 'finance-center', entryUrl: 'https://finance.example.test', accountCount: 1 },
  { ...targetBase, id: id(5), name: '旧版采购系统', code: 'purchase-legacy', entryUrl: 'https://legacy.example.test', status: 'disabled', accountCount: 0 },
]
const descriptor = (name) => ({ framePath: [], candidates: [{ by: 'label', value: name }] })
const steps = [
  { id: id(101), name: '打开订单管理页面', type: 'navigate', effectType: 'READ_ONLY', input: { url: 'https://retail.example.test/orders' } },
  { id: id(102), name: '填写订单查询条件', type: 'fill', effectType: 'IDEMPOTENT', input: { target: descriptor('订单编号'), from: 'orderNo' } },
  { id: id(103), name: '查询订单', type: 'click', effectType: 'READ_ONLY', input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '查询' }] } }, policy: { timeoutMs: 10000, retryLimit: 1 } },
  { id: id(104), name: '提取订单状态', type: 'extract', effectType: 'READ_ONLY', outputKey: 'orderStatus', input: { target: descriptor('订单状态'), as: 'text' } },
  { id: id(105), name: '确认订单已完成', type: 'assert', effectType: 'READ_ONLY', input: { target: descriptor('订单状态'), expect: { kind: 'text_equals', value: '已完成' } } },
  { id: id(106), name: '提交处理结果', type: 'click', effectType: 'SIDE_EFFECT', input: { target: { framePath: [], candidates: [{ by: 'role', value: 'button', name: '提交' }] } }, policy: { retryLimit: 0 } },
]
const scenarios = ['订单履约巡检', '库存状态核对', '客户服务入口检查', '结算明细校验', '采购流程回归'].map((name, index) => ({ id: id(20 + index), name, targetId: targets[index].id, status: index === 4 ? 'disabled' : 'active', latestVersionId: id(50 + index), latestVersionNo: index === 0 ? 3 : 1, stepCount: steps.length, createdAt: timestamp, updatedAt: timestamp }))
const accountBase = { targetId: id(1), hasPassword: true, status: 'active', createdAt: timestamp, updatedAt: timestamp }
const accounts = [
  { ...accountBase, id: id(71), displayName: '运营巡检账号', username: 'ops_inspection' },
  { ...accountBase, id: id(72), displayName: '验收只读账号', username: 'acceptance_reader', hasPassword: false },
]
const permissions = ['target:read', 'target:write', 'target:delete', 'workflow:read', 'workflow:write', 'run:read', 'run:execute']
let mode = 'normal'
let readOnly = false
let hideTargetPermission = false
let longContent = false
let sensitive = false
let delayWrites = false
const requests = []
const unexpected = []
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' })
await context.addCookies([{ name: 'thisisjustarandomstring', value: JSON.stringify('ui-review-fixture'), url: origin }])
await context.route('**/*', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  if (url.origin !== origin) return route.abort()
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') return route.continue()
  requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() })
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
  const failure = () => json({ code: 'UI_REVIEW_UNAVAILABLE', message: '验收样本：暂时无法保存，请稍后重试。', requestId: 'ui-review' }, 503)
  if (request.method() !== 'GET') {
    if (delayWrites) await new Promise((resolve) => setTimeout(resolve, 700))
    return failure()
  }
  if (url.pathname === '/api/me') return json({ account: { id: 'review-user', displayName: '前端验收 · 示例数据', email: 'review@example.test', status: 'active', roles: [], permissions: permissions.filter((p) => (!readOnly || p.endsWith(':read')) && (!hideTargetPermission || p !== 'target:read')), createdAt: timestamp, updatedAt: timestamp } })
  if (url.pathname === '/health') return json({ status: 'ok', service: 'cairn-api', uptimeSeconds: 1, checks: { database: 'up' } })
  if (mode === 'error') return failure()
  if (url.pathname === '/api/targets') return json({ items: mode === 'empty' ? [] : targets.map((item, i) => longContent && i === 0 ? { ...item, name: '跨区域订单与供应链业务协同平台'.repeat(6), entryUrl: `https://example.test/${'orders/'.repeat(30)}` } : item) })
  if (url.pathname === '/api/scenarios') return json({ items: mode === 'empty' ? [] : scenarios })
  for (const target of targets) {
    if (url.pathname === `/api/targets/${target.id}`) return json(target)
    if (url.pathname === `/api/targets/${target.id}/accounts`) return json({ items: mode === 'accounts-empty' ? [] : accounts.map((account) => ({ ...account, targetId: target.id })) })
  }
  const scenario = scenarios.find((item) => url.pathname === `/api/scenarios/${item.id}`)
  if (scenario) return json({ ...scenario, name: longContent ? '订单业务流程状态校验'.repeat(10) : scenario.name, steps: sensitive ? [{ ...steps[1], input: { target: descriptor('密码'), sensitive: true, value: 'fixture-secret-must-not-render' } }] : longContent ? Array.from({ length: 32 }, (_, i) => ({ ...steps[i % steps.length], id: id(1000 + i), name: `${i + 1}. ${'长步骤名称与业务条件'.repeat(10)}` })) : steps })
  unexpected.push(url.pathname)
  return failure()
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const result = { scope: '实际 React、路由、API Schema；请求由 Playwright fixture 隔离。未执行真实后端写入或目标系统自动化。', checks: [], screenshots: [] }
const passed = (name) => { result.checks.push(name); console.log(`PASS: ${name}`) }
async function go(url, heading) {
  await page.goto(`${origin}${url}`)
  await page.getByRole('heading', { name: heading, exact: true }).waitFor()
  await page.locator('main table, main section, main [role=alert]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
}
async function capture(name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  result.screenshots.push(`screenshots/${name}.png`)
}
async function bounds(name) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('main, main section, main aside, main input, main button, [role=dialog]')].filter((el) => {
    if (el.closest('[data-slot=table-container]')) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)
  }).map((el) => ({ tag: el.tagName, text: (el.textContent ?? '').slice(0, 40), width: el.getBoundingClientRect().width })))
  assert.deepEqual(bad, [], `${name}: 内容越过视口`)
}
try {
  await go('/targets', '目标系统')
  await page.getByRole('button', { name: '查看零售运营平台概览' }).waitFor()
  assert.equal(await page.locator('main tbody tr').count(), 5)
  assert.equal(await page.getByRole('button', { name: '新建目标系统' }).evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(36, 92, 229)')
  await capture('targets')
  await page.getByLabel('搜索目标系统').fill('supply')
  await page.getByRole('heading', { name: '供应链协同系统', exact: true }).waitFor()
  assert.equal(await page.locator('main tbody tr').count(), 1)
  await page.getByLabel('搜索目标系统').fill('no-matching-system')
  await page.getByRole('heading', { name: '没有匹配的目标系统' }).waitFor()
  assert.equal(await page.getByRole('complementary', { name: '系统概览' }).count(), 0)
  await page.getByRole('button', { name: '清除筛选' }).click()
  await page.getByRole('button', { name: '已停用', exact: true }).click()
  await page.getByRole('heading', { name: '旧版采购系统', exact: true }).waitFor()
  assert.equal(await page.locator('main tbody tr').count(), 1)
  passed('目标搜索、状态筛选、空结果与概览保持同一对象')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const beforeCancel = requests.filter((r) => r.method === 'POST').length
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(requests.filter((r) => r.method === 'POST').length, beforeCancel)
  await page.waitForFunction(() => document.activeElement?.textContent === '删除', null, { timeout: 2000 })
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '删除', '确认框取消后恢复入口焦点')
  passed('删除取消不发出写请求')

  await go(`/targets/${id(1)}`, targets[0].name)
  await page.getByText('ops_inspection', { exact: true }).waitFor()
  assert.equal(await page.locator('a[href="/targets"][data-active="true"]').count(), 1)
  await capture('target-detail')
  await page.getByRole('button', { name: '添加目标账号' }).click()
  await page.getByLabel('显示名', { exact: true }).fill('新验收账号')
  await page.getByLabel('登录名', { exact: true }).fill('new_review_user')
  const save = page.getByRole('button', { name: '保存', exact: true })
  const width = (await save.boundingBox()).width
  delayWrites = true
  await save.click()
  await page.waitForFunction(() => document.querySelector('button[aria-busy=true]'))
  assert.equal((await save.boundingBox()).width, width)
  assert.equal(await save.locator('svg').evaluate((el) => getComputedStyle(el).animationName), 'none')
  assert.equal(await save.isDisabled(), true)
  await page.waitForFunction(() => !document.querySelector('button[aria-busy=true]'))
  assert.equal(await page.getByLabel('登录名', { exact: true }).inputValue(), 'new_review_user')
  const write = requests.findLast((r) => r.method === 'POST')
  assert.equal(write.path, `/api/targets/${id(1)}/accounts`)
  assert.equal(write.body.username, 'new_review_user')
  await capture('account-error')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.textContent === '添加目标账号', null, { timeout: 2000 })
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '添加目标账号', '关闭弹窗后焦点回到入口')
  passed('账号绑定、保存失败保留输入、Loading 不跳宽且减少动效生效')

  await go('/scenarios', '场景')
  await page.getByRole('link', { name: '订单履约巡检', exact: true }).waitFor()
  await capture('scenarios')
  await page.getByLabel('搜索场景').fill('供应链')
  await page.getByRole('link', { name: '库存状态核对', exact: true }).waitFor()
  assert.equal(await page.locator('main tbody tr').count(), 1)
  passed('场景按目标系统名称搜索，状态与最新版本对应实际 DTO')
  await go(`/scenarios/${id(20)}`, '订单履约巡检')
  await page.getByRole('button', { name: /确认订单已完成/ }).click()
  await page.getByRole('region', { name: '步骤属性' }).getByRole('heading', { name: '确认订单已完成' }).waitFor()
  assert.ok((await page.locator('#step-properties').textContent()).includes('已完成'))
  assert.equal(await page.locator('main ol > li').count(), 6)
  assert.equal(await page.locator('a[href="/scenarios"][data-active="true"]').count(), 1)
  assert.ok((await page.locator('#step-properties').textContent()).includes('文本等于「已完成」'))
  await capture('scenario-detail')
  await page.getByRole('button', { name: /提交处理结果/ }).click()
  assert.ok((await page.locator('#step-properties').textContent()).includes('不能直接重放'))
  await page.getByRole('button', { name: '运行场景' }).click()
  await page.getByRole('dialog').waitFor()
  assert.ok((await page.getByRole('dialog').textContent()).includes('订单履约巡检'))
  assert.ok(requests.some((r) => r.path === `/api/targets/${id(1)}/accounts`))
  await page.keyboard.press('Escape')
  passed('步骤顺序、选择、断言条件、副作用提示与场景运行入口')
  sensitive = true
  await page.reload()
  await page.locator('#step-properties').waitFor()
  assert.ok(!(await page.locator('main').textContent()).includes('fixture-secret-must-not-render'))
  sensitive = false
  passed('敏感 Fill 输入在属性与结构化定义中均遮蔽')

  for (const width of [1366, 1440, 1920, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const [url, heading, name] of [['/targets', '目标系统', 'targets'], [`/targets/${id(1)}`, targets[0].name, 'target-detail'], ['/scenarios', '场景', 'scenarios'], [`/scenarios/${id(20)}`, '订单履约巡检', 'scenario-detail']]) {
      await go(url, heading)
      await bounds(`${name}/${width}`)
      if (width === 390) await capture(`${name}-narrow`)
    }
  }
  longContent = true
  await go('/targets', '目标系统')
  await bounds('长系统名称与 URL')
  await go(`/scenarios/${id(20)}`, '订单业务流程状态校验'.repeat(10))
  await bounds('32 个长名称步骤')
  assert.equal(await page.locator('main ol > li').count(), 32)
  longContent = false
  passed('四个真实路由 × 五档宽度，长名称 / URL / 32 步骤无整体横向溢出')

  await page.setViewportSize({ width: 1440, height: 1000 })
  readOnly = true
  await go('/targets', '目标系统')
  await page.getByRole('button', { name: '查看零售运营平台概览' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '新建目标系统' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).count(), 0)
  hideTargetPermission = true
  const start = requests.length
  await go(`/scenarios/${id(20)}`, '订单履约巡检')
  assert.equal(await page.getByRole('button', { name: '运行场景' }).count(), 0)
  assert.ok(!requests.slice(start).some((r) => r.path.startsWith('/api/targets')))
  readOnly = false
  hideTargetPermission = false
  passed('只读用户无写入口；无目标读取权限时不额外请求目标资料')
  for (const [url, title] of [['/targets', '目标系统'], ['/scenarios', '场景']]) {
    mode = 'empty'
    await page.goto(`${origin}${url}`)
    await page.getByRole('heading', { name: title === '场景' ? '还没有场景' : '还没有目标系统' }).waitFor()
    mode = 'error'
    await page.reload()
    await page.getByText(`无法加载${title}`, { exact: true }).waitFor()
    mode = 'normal'
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.locator('main tbody tr').first().waitFor()
  }
  passed('列表空态、接口错误与原位重试恢复')
  assert.deepEqual(errors, [], '浏览器未捕获错误')
  assert.deepEqual(unexpected, [], '未覆盖的 API 请求')
  await writeFile(path.join(import.meta.dirname, 'results.json'), JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
  console.error('URL:', page.url(), 'Page errors:', errors, 'Unexpected API:', unexpected)
  throw error
} finally {
  await browser.close()
}
