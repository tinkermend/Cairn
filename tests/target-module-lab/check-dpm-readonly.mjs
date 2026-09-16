// 真实 DPM 只读核对：与 runtime.ts 相同的定位语义。仅登录、导航、输入查询词、点“搜 索”。
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../packages/worker/package.json', import.meta.url))
const { chromium } = require('playwright')
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 入口与凭据只从环境变量或 tests/target-snc-dpm/catalog.local.json 读，不写进仓库。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..')
let overlay = {}
try {
  overlay = JSON.parse(readFileSync(join(REPO, 'tests/target-snc-dpm/catalog.local.json'), 'utf8'))
} catch {}
const LOGIN_URL = process.env.CAIRN_L3_DPM_LOGIN_URL ?? overlay.loginUrl ?? ''
const USERNAME = process.env.CAIRN_L3_DPM_USERNAME ?? overlay.account?.username ?? ''
const PASSWORD = process.env.CAIRN_L3_DPM_PASSWORD ?? overlay.account?.password ?? ''
if (!LOGIN_URL || !USERNAME || !PASSWORD) {
  throw new Error('缺少 CAIRN_L3_DPM_LOGIN_URL / CAIRN_L3_DPM_USERNAME / CAIRN_L3_DPM_PASSWORD（或 tests/target-snc-dpm/catalog.local.json）')
}
const BASE = new URL(LOGIN_URL).origin
const out = {}
const rowScope = (page, text) => page.locator('tr, [role="row"], li').filter({ hasText: text })
const outcome = async (loc) => { try { const n = await loc.count(); return n === 0 ? 'NOT_FOUND' : n > 1 ? `AMBIGUOUS(${n})` : 'OK' } catch (e) { return `ERR ${e.message.slice(0,60)}` } }
const text = async (loc) => { try { return (await loc.first().innerText()).trim().slice(0, 60) } catch { return null } }

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
await page.goto(LOGIN_URL)
out.D0_login_primary_without_submit = await outcome(page.locator('button.el-button--primary'))
out.D0_login_primary_with_submit = await outcome(page.locator('button.el-button--primary[type=submit]'))
await page.fill('input.input-account[type=text]', USERNAME)
await page.fill('input.input-account[type=password]', PASSWORD)
await page.click('button.el-button--primary[type=submit]')
await page.waitForURL(/\/front\/(?!login)/, { timeout: 30000 })

await page.goto(`${BASE}/front/database/dbInstance`)
await page.locator('input[placeholder="请输入设备名称"]').waitFor({ timeout: 20000 })
await page.waitForTimeout(3000)
out.D1_breadcrumb_last = await outcome(page.locator('.el-breadcrumb__item:last-child .el-breadcrumb__inner'))
out.D1_breadcrumb_text = await text(page.locator('.el-breadcrumb__item:last-child .el-breadcrumb__inner'))
out.D1_pagination_total = await outcome(page.locator('.el-pagination__total'))
out.D1_pagination_text = await text(page.locator('.el-pagination__total'))
out.D1_loading_mask_nodes = await page.locator('.el-loading-mask').count()
out.D1_search_button = await outcome(page.getByRole('button', { name: '搜 索', exact: true }))
out.D1_empty_text_node = await page.locator('.el-table__empty-text').count()

await page.locator('input[placeholder="请输入设备名称"]').fill('Mysql_主')
await page.getByRole('button', { name: '搜 索', exact: true }).click()
await page.waitForTimeout(4000)
out.D2_total_after_search = await text(page.locator('.el-pagination__total'))
out.D2_row_anchor_Mysql_zhu = await outcome(rowScope(page, 'Mysql_主'))
out.D2_row_anchor_then_gridcell = await outcome(rowScope(page, 'Mysql_主').getByRole('gridcell'))
out.D2_exact_gridcell = await outcome(page.getByRole('gridcell', { name: 'Mysql_主', exact: true }))
out.D2_clean_row_anchor = await outcome(rowScope(page, 'Postgres12'))

await page.goto(`${BASE}/front/alerter/alarmAnalysis`)
await page.waitForTimeout(6000)
out.D3_alarm_body_rows = await page.locator('.el-table__body tr.el-table__row').count()
out.D3_first_row_second_cell = await outcome(page.locator('.el-table__body tr.el-table__row:first-child td:nth-child(2)'))
out.D3_first_row_second_cell_text = await text(page.locator('.el-table__body tr.el-table__row:first-child td:nth-child(2)'))
out.D3_columnheader_resource = await outcome(page.getByRole('columnheader', { name: '资源名称', exact: true }))

await page.goto(`${BASE}/front/database/allInstance`)
await page.waitForTimeout(5000)
out.D4_overview_breadcrumb = await text(page.locator('.el-breadcrumb__item:last-child .el-breadcrumb__inner'))
out.D4_pagination_total_on_overview = await page.locator('.el-pagination__total').count()

console.log(JSON.stringify(out, null, 2))
await browser.close()
