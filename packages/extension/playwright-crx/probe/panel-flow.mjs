#!/usr/bin/env node
/**
 * 识途录制器：真实 Chrome 面板验收。
 *
 * 为什么必须有这个脚本：登录门禁、侧栏接管、录制、删除只在「真实 Chrome + 真实侧栏」下
 * 才会暴露问题。之前三个 bug（`sidePanel.open()` 缺用户手势、侧栏路径不变导致端口不重连、
 * 挂到了 about:blank）全部通过了 vitest 与 vite build。
 *
 * 两处与真实使用的差异，写在这里不藏着：
 * 1. 侧栏无法被自动化打开（`sidePanel.open()` 要用户手势），脚本用扩展页标签顶替侧栏；
 *    真实侧栏由「换路径 → 重载 → 重连」完成接管，这里用重载那一页顶替同一次重连。
 * 2. 被录页面是脚本内置的本地夹具，不打外部站点。
 *
 * 不允许造假：会话必须来自真实登录接口，步骤必须来自真实录制，不许往 storage 塞假步骤。
 *
 * 跑法见 ../README.md。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = resolve(packageRoot, '../../..')

// Playwright 是 worker 的依赖，扩展包本身不该为一个本地探针加运行时依赖。
const require = createRequire(resolve(repoRoot, 'packages/worker/package.json'))
const { chromium } = require('playwright')

const dist = resolve(packageRoot, 'dist')
const apiOrigin = process.env.CAIRN_PROBE_API ?? 'http://localhost:3030'
const email = process.env.CAIRN_PROBE_EMAIL ?? 'admin'
const password = process.env.CAIRN_PROBE_PASSWORD ?? 'cairn-admin'

const FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>录制夹具 · 订单查询</title></head>
<body>
  <h1>订单查询</h1>
  <label for="orderNo">订单号</label>
  <input id="orderNo" name="orderNo">
  <button id="search" type="button">查询</button>
  <button id="extra" type="button">多余按钮</button>
  <p id="result"></p>
  <script>
    document.getElementById('search').onclick = () => {
      document.getElementById('result').textContent = '已查询'
    }
  </script>
</body></html>`

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(dist)) {
  console.error(`没有 ${dist}，先在 ${packageRoot} 跑一次构建`)
  process.exit(2)
}

const health = await fetch(`${apiOrigin}/api/auth/login`, { method: 'POST' }).catch(() => null)
if (!health) {
  console.error(`连不上 ${apiOrigin}，先起本地 API（或用 CAIRN_PROBE_API 指过去）`)
  process.exit(2)
}

const fixture = createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(FIXTURE)
})
await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/orders`

const profile = mkdtempSync(resolve(tmpdir(), 'cairn-probe-'))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host

  const target = await context.newPage()
  await target.goto(fixtureUrl)

  const panel = await context.newPage()
  await panel.setViewportSize({ width: 380, height: 900 })
  await panel.goto(`chrome-extension://${extensionId}/index.html`)

  // 1. 未登录不得挂接：走面板用的同一条消息通道，不用 vendor 的裸 attach。
  const denied = await panel.evaluate(() => chrome.runtime.sendMessage({ event: 'cairnAttach', mode: 'recording' }))
  check('未登录点挂接被拒', denied.ok === false && denied.error.includes('请先登录'), denied.error ?? 'ok')
  check('未登录时没有页面被接管', await panel.locator('#cairn-email').isVisible())

  // 2. 真实登录。目标列表是登录后再拉的，工作台会先渲染出来，所以等列表到位再断言。
  await panel.fill('#cairn-email', email)
  await panel.fill('#cairn-password', password)
  await panel.click('button[type=submit]')
  await panel.waitForSelector('#cairn-target', { timeout: 20_000 })
  const listed = await panel
    .waitForFunction(() => document.querySelectorAll('#cairn-target option').length > 1, undefined, {
      timeout: 20_000,
    })
    .then(() => true)
    .catch(() => false)
  const targetCount = await panel.locator('#cairn-target option').count()
  check('真实登录并拉到目标系统', listed, `${targetCount - 1} 个目标系统`)
  if (listed) await panel.selectOption('#cairn-target', { index: 1 })
  check(
    '未挂接时说清会挂当前标签页',
    (await panel.locator('.cairn-status').innerText()).includes('未挂接'),
  )

  // 3. 面板里点开始录制就能挂上（侧栏换路径重载 → 这里用重载顶替）。
  await panel.locator('.cairn-toolbar button', { hasText: '录制' }).click()
  await panel.waitForTimeout(800)
  await panel.reload()
  await panel.waitForFunction(
    () => document.querySelector('.cairn-toolbar button')?.textContent?.includes('停止录制'),
    undefined,
    { timeout: 20_000 },
  )
  check('面板内挂接完成', true)
  // 重载后目标系统是等接口回来才回填的，等值出现，不看渲染第一帧。
  const restored = await panel
    .waitForFunction(() => Boolean(document.querySelector('#cairn-target')?.value), undefined, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  check('挂接重载后已选目标系统还在', restored, await panel.locator('#cairn-target').inputValue())

  // 4. 真实操作产生真实步骤。
  await target.bringToFront()
  await target.fill('#orderNo', 'SO-9')
  await target.click('#search')
  await target.click('#extra')
  await panel.bringToFront()
  await panel.waitForFunction(() => document.querySelectorAll('.cairn-step').length >= 3, undefined, {
    timeout: 20_000,
  })
  const names = await panel.locator('.cairn-step .cairn-step-name').allInnerTexts()
  check('录到真实步骤', names.length >= 3, names.join(' | '))
  check(
    '在录哪一页写在面板上',
    (await panel.locator('.cairn-status').innerText()).includes('正在录制'),
  )
  check(
    '同名操作有定位摘要可区分',
    (await panel.locator('.cairn-step-target').count()) >= 2,
    `${await panel.locator('.cairn-step-target').count()} 条带定位`,
  )

  // 5. 展开看原始字段。
  await panel.locator('.cairn-step-toggle', { hasText: '展开' }).first().click()
  const raw = await panel.locator('.cairn-step-raw').first().innerText()
  check('展开字段与控制台草稿同名', ['sourceAction', 'candidateStepType', 'input'].every((key) => raw.includes(key)))

  // 6. 删除误录的一步并撤销。
  const before = await panel.locator('.cairn-step').count()
  await panel.locator('.cairn-step-remove').last().click()
  await panel.waitForFunction(
    (count) => document.querySelectorAll('.cairn-step').length === count - 1,
    before,
    { timeout: 10_000 },
  )
  check('删掉误录的一步', true, `${before} → ${before - 1}`)
  const undone = await panel.locator('.cairn-status button', { hasText: '撤销' }).count()
  check('删除给出撤销出口', undone === 1)
  await panel.locator('.cairn-status button', { hasText: '撤销' }).click()
  await panel.waitForFunction((count) => document.querySelectorAll('.cairn-step').length === count, before, {
    timeout: 10_000,
  })
  check('撤销把那一步放回来', true)

  // 7. 退出要回到登录，并且扩展自己不再认为有页面被接管。
  // 不能用 chrome.debugger.getTargets 判断：这一页本来就挂着 Playwright 的调试连接。
  const attachedBefore = await panel.evaluate(() => chrome.runtime.sendMessage({ event: 'cairnStatus' }))
  check('录制中面板问得到被录页面', attachedBefore.attached === true, attachedBefore.url)
  await panel.locator('.cairn-who button', { hasText: '退出' }).click()
  await panel.waitForSelector('#cairn-email', { timeout: 10_000 })
  const attachedAfter = await panel.evaluate(() => chrome.runtime.sendMessage({ event: 'cairnStatus' }))
  check('退出后回登录并释放接管', attachedAfter.attached === false)
} finally {
  await context.close().catch(() => {})
  fixture.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
process.exit(failed.length ? 1 : 0)
