// 用与 packages/worker/src/browser/runtime.ts 相同的定位语义，验证候选模块的定位与时序假设。
// locatorForCandidate: role→getByRole(name, exact:Boolean(name)) / text→exact / css→locator
// scopeForAnchor(row): scope.locator('tr, [role="row"], li').filter({ hasText })
// Resolver: matches>1 → AMBIGUOUS, 0 → NOT_FOUND
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '../../packages/worker/package.json'))
const { chromium } = require('playwright')
const { createModuleLab } = await import(new URL('./server.mjs', import.meta.url).href)

const { server, getState } = createModuleLab()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const out = {}
const locator = (scope, c) => c.by === 'role' ? scope.getByRole(c.value, { name: c.name, exact: Boolean(c.name) })
  : c.by === 'text' ? scope.getByText(c.value, { exact: true }) : scope.locator(c.value)
const rowScope = (page, text) => page.locator('tr, [role="row"], li').filter({ hasText: text })
const outcome = async (loc) => { const n = await loc.count(); return n === 0 ? 'NOT_FOUND' : n > 1 ? `AMBIGUOUS(${n})` : 'OK' }

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
const login = async () => {
  await page.goto(`${origin}/front/login`)
  await page.fill('input.input-account[type=text]', 'labuser')
  await page.fill('input.input-account[type=password]', 'labpass')
  await page.click('button.el-button--primary[type=submit]')
  await page.waitForURL(/allInstance/)
}
const search = async (kw) => {
  await page.goto(`${origin}/front/database/dbInstance`)
  await page.locator('input[placeholder="请输入设备名称"]').fill(kw)
  await page.getByRole('button', { name: '搜 索', exact: true }).click()
  await page.locator('.el-loading-mask').waitFor({ state: 'hidden' })
}
await login()

// L1 登录框定位：DPM 上 primary 按钮不唯一，必须带 [type=submit]
await page.goto(`${origin}/front/login`)
out.L1_login_primary_without_submit = await outcome(page.locator('button.el-button--primary'))
out.L1_login_primary_with_submit = await outcome(page.locator('button.el-button--primary[type=submit]'))
await login()

// L2 面包屑末级可唯一断言（列表页与详情页）
await page.goto(`${origin}/front/database/dbInstance`)
out.L2_breadcrumb_last = await outcome(page.locator('.el-breadcrumb__item:last-child .el-breadcrumb__inner'))
out.L2_breadcrumb_text = await page.locator('.el-breadcrumb__item:last-child .el-breadcrumb__inner').innerText()
// 侧栏与面包屑同名 → 全页面按文本定位“数据库实例”会歧义
out.L2_text_instance_page_wide = await outcome(page.getByText('数据库实例', { exact: true }))

// L3 模糊查询：行锚点是大小写不敏感子串
await search('Mysql_主')
out.L3_total = await page.locator('.el-pagination__total').innerText()
out.L3_row_anchor_Mysql_zhu = await outcome(rowScope(page, 'Mysql_主'))
out.L3_row_anchor_then_cell = await outcome(rowScope(page, 'Mysql_主').locator('td:nth-child(2)'))
out.L3_exact_gridcell = await outcome(locator(page, { by: 'role', value: 'gridcell', name: 'Mysql_主' }))
await search('Postgres12')
out.L3_clean_row_anchor_cell = await outcome(rowScope(page, 'Postgres12').locator('td:nth-child(2)'))
out.L3_clean_cell_text = await rowScope(page, 'Postgres12').locator('td:nth-child(2)').innerText()

// L4 结果到位：延迟查询下不等待加载遮罩就读“共 N 条”
await fetch(`${origin}/lab/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchDelayMs: 1500 }) })
await page.goto(`${origin}/front/database/dbInstance`)
out.L4_total_before = await page.locator('.el-pagination__total').innerText()
await page.locator('input[placeholder="请输入设备名称"]').fill('Mysql_主')
await page.getByRole('button', { name: '搜 索', exact: true }).click()
out.L4_total_without_wait = await page.locator('.el-pagination__total').innerText()
await page.locator('.el-loading-mask').waitFor({ state: 'hidden' })
out.L4_total_after_wait = await page.locator('.el-pagination__total').innerText()

// L5 查询接口失败：旧数据仍在，含“条”的后置断言仍然通过
await fetch(`${origin}/lab/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchDelayMs: 0, searchFail: true }) })
await page.goto(`${origin}/front/database/dbInstance`)
await page.locator('input[placeholder="请输入设备名称"]').fill('Postgres12')
await page.getByRole('button', { name: '搜 索', exact: true }).click()
await page.locator('.el-loading-mask').waitFor({ state: 'hidden' })
out.L5_total_after_failed_search = await page.locator('.el-pagination__total').innerText()
out.L5_assert_contains_条 = out.L5_total_after_failed_search.includes('条')
out.L5_error_message_visible = await page.locator('.el-message').isVisible()

// L6 界面变体：按钮改名后旧定位 NOT_FOUND
await fetch(`${origin}/lab/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ searchFail: false, ui: 'v2' }) })
await page.goto(`${origin}/front/database/dbInstance`)
out.L6_v1_button = await outcome(locator(page, { by: 'role', value: 'button', name: '搜 索' }))
out.L6_v2_button = await outcome(locator(page, { by: 'role', value: 'button', name: '查 询' }))
await fetch(`${origin}/lab/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: 'v1' }) })

// L7 副作用：处置执行两次会重复；前置条件“未处置”可静态断言
await page.goto(`${origin}/front/alerter/alarmAnalysis`)
const dispose = async () => {
  await rowScope(page, 'db2_hadr_primay').getByRole('button', { name: '处 置', exact: true }).click()
  await page.getByRole('button', { name: '确 定', exact: true }).click()
  await page.waitForTimeout(300)
}
out.L7_status_before = await rowScope(page, 'db2_hadr_primay').locator('.alarm-status').innerText()
await dispose()
out.L7_status_after_first = await rowScope(page, 'db2_hadr_primay').locator('.alarm-status').innerText()
await dispose()
out.L7_dispose_log_len = getState().disposeLog.length
out.L7_dialog_confirm_unique = await outcome(locator(page, { by: 'role', value: 'button', name: '确 定' }))

// L8 会话失效：目标系统会话被清空后，受保护页面返回登录页
await fetch(`${origin}/lab/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expireSessions: true }) })
await page.goto(`${origin}/front/database/dbInstance`)
out.L8_url_after_expire = page.url().replace(origin, '')
out.L8_search_box = await outcome(page.locator('input[placeholder="请输入设备名称"]'))

console.log(JSON.stringify(out, null, 2))
await browser.close()
server.close()
