#!/usr/bin/env node
/**
 * D2：真实 Chrome + 已加载扩展，走平台绑定 → 领取 → 录制 → 上传 → Studio 回填。
 *
 * 与 probe/panel-flow.mjs 相同的两处限制：自动化打不开工具栏/侧栏，用扩展页标签顶替；
 * 被录页面是本脚本夹具，不打外部站点。会话与步骤不许造假。
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
const require = createRequire(resolve(repoRoot, 'packages/worker/package.json'))
const { chromium } = require('playwright')

const dist = resolve(packageRoot, 'dist')
const apiOrigin = process.env.CAIRN_PROBE_API ?? 'http://localhost:3030'
const webOrigin = process.env.CAIRN_PROBE_WEB ?? 'http://localhost:5173'
const email = process.env.CAIRN_PROBE_EMAIL ?? 'admin'
const password = process.env.CAIRN_PROBE_PASSWORD ?? 'cairn-admin'

const FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>D2 录制夹具 · 订单查询</title></head>
<body>
  <h1>订单查询</h1>
  <label for="orderNo">订单号</label>
  <input id="orderNo" name="orderNo">
  <label><input id="urgent" type="checkbox">加急</label>
  <button id="search" type="button">查询</button>
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

function uuid() {
  return crypto.randomUUID()
}

async function api(path, token, init = {}) {
  const headers = { accept: 'application/json', ...(init.headers ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body ? body.message : text
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${message}`)
  }
  return body
}

if (!existsSync(dist)) {
  console.error(`没有 ${dist}，先在 ${packageRoot} 跑一次构建`)
  process.exit(2)
}

const loginProbe = await fetch(`${apiOrigin}/api/auth/login`, { method: 'POST' }).catch(() => null)
if (!loginProbe) {
  console.error(`连不上 ${apiOrigin}，先起本地 API（或用 CAIRN_PROBE_API 指过去）`)
  process.exit(2)
}

const fixture = createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(FIXTURE)
})
await new Promise((done) => fixture.listen(0, '127.0.0.1', done))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/orders`

const session = await api('/api/auth/login', null, {
  method: 'POST',
  body: JSON.stringify({ email, password }),
})
const token = session.accessToken

if ((await api('/api/recording-bindings/open', token))?.binding) throw new Error('该探针账号已有录制绑定，请先完成它或使用独立探针账号')

const target = await api('/api/targets', token, {
  method: 'POST',
  body: JSON.stringify({
    code: `d2probe${Date.now().toString(36)}`.slice(0, 20),
    name: 'D2 插件闭环夹具',
    entryUrl: fixtureUrl,
  }),
})
const stepId = uuid()
const scenario = await api('/api/scenarios', token, {
  method: 'POST',
  body: JSON.stringify({
    targetId: target.id,
    name: `D2 插件闭环 ${new Date().toISOString().slice(11, 19)}`,
    steps: [
      {
        id: stepId,
        name: '打开订单查询',
        type: 'navigate',
        effectType: 'SIDE_EFFECT',
        input: { url: fixtureUrl },
      },
    ],
  }),
})
const created = await api(`/api/scenarios/${scenario.id}/recording-bindings`, token, {
  method: 'POST',
  body: JSON.stringify({
    revision: scenario.draft.revision,
    insertAnchor: { kind: 'after', stepId },
  }),
})
check('平台签发绑定且只回一次票据', Boolean(created.binding?.id && created.ticket?.length === 64))
check('绑定尚未领取', created.binding.status === 'issued', created.binding.status)

const profile = mkdtempSync(resolve(tmpdir(), 'cairn-d2-probe-'))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
})

try {
  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extensionId = new URL(worker.url()).host

  const panel = await context.newPage()
  await panel.setViewportSize({ width: 380, height: 900 })
  await panel.goto(`chrome-extension://${extensionId}/index.html`)

  const beforeLogin = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ event: 'cairnAttach', mode: 'recording' }),
  )
  check('未登录不能挂接', beforeLogin.ok === false && String(beforeLogin.error).includes('请先登录'))

  await panel.fill('#cairn-email', email)
  await panel.fill('#cairn-password', password)
  await panel.click('button[type=submit]')
  await panel.waitForSelector('#cairn-target', { timeout: 20_000 })

  const bound = await panel
    .waitForFunction(
      (name) => document.body.innerText.includes(`正在为场景「${name}」录制`),
      scenario.name,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('登录后面板领取同一绑定', bound, scenario.name)
  check('绑定后目标系统不可改', await panel.locator('#cairn-target').isDisabled())
  check(
    '未挂接时不说录制中',
    (await panel.locator('.cairn-status').innerText()).includes('未挂接'),
  )

  const claimed = await api('/api/recording-bindings/open', token)
  check('工具栏路径把绑定领成 claimed', claimed.binding?.status === 'claimed', claimed.binding?.status)
  check('领取的是刚签发的绑定', claimed.binding?.id === created.binding.id, claimed.binding?.id)

  const fixturePage = await (async () => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const found = context.pages().find((page) => page.url().includes(String(fixture.address().port)))
      if (found) return found
      await panel.waitForTimeout(250)
    }
    return null
  })()
  check('插件按绑定打开目标入口', Boolean(fixturePage), fixturePage?.url() ?? '没有打开夹具页')
  const targetPage = fixturePage ?? (await context.newPage())
  if (!fixturePage) await targetPage.goto(fixtureUrl)

  await panel.locator('.cairn-toolbar button', { hasText: '录制' }).click()
  await panel.waitForTimeout(800)
  await panel.reload()
  const recording = await panel
    .waitForFunction(
      () => document.querySelector('.cairn-toolbar button')?.textContent?.includes('停止录制'),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('挂接成功后才进入录制中', recording)

  await targetPage.bringToFront()
  await targetPage.fill('#orderNo', 'SO-D2')
  // 录制器会接管点击；不要用 check() 再断言 DOM 状态，否则探针自己先失败。
  await targetPage.click('#urgent', { force: true })
  await targetPage.waitForFunction(() => document.querySelector('#urgent').checked)
  await targetPage.click('#search')
  await targetPage.locator('#result').getByText('已查询', { exact: true }).waitFor()
  await panel.bringToFront()
  await panel.waitForFunction(() => document.querySelectorAll('.cairn-step').length >= 2, undefined, {
    timeout: 20_000,
  })
  const names = await panel.locator('.cairn-step .cairn-step-name').allInnerTexts()
  check('真实操作产生真实步骤', names.length >= 2, names.join(' | '))

  await panel.getByRole('button', { name: '上传到平台' }).click()
  const uploaded = await panel
    .waitForFunction(
      () => document.body.innerText.includes('已上传到场景') && document.body.innerText.includes('尚未回填'),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  check('上传带绑定且区分尚未回填', uploaded)

  const returnLink = panel.locator('a', { hasText: '回到 Studio 预览回填' })
  const href = (await returnLink.count()) ? await returnLink.getAttribute('href') : ''
  check(
    '返回 Studio 带 import 批次',
    Boolean(href && href.includes(`/scenarios/${scenario.id}`) && href.includes('import=')),
    href ?? '',
  )

  const afterUpload = await api('/api/recording-bindings/open', token)
  const draftId = afterUpload.binding?.recordingDraftId
  check('服务端绑定已挂上录制批次', Boolean(draftId), draftId ?? '无批次')

  const web = await context.newPage()
  await web.goto(`${webOrigin}/sign-in`)
  await web.getByRole('textbox', { name: /^账号$/ }).fill(email)
  await web.getByLabel(/^密码$/).fill(password)
  await web.getByRole('button', { name: /^登录$/ }).click()
  await web.waitForURL((url) => !url.pathname.includes('sign-in'), { timeout: 20_000 })
  const preview = await api(`/api/scenarios/${scenario.id}/recording-imports/preview`, token, {
    method: 'POST',
    body: JSON.stringify({
      protocolVersion: 'demonstration@1',
      recordingDraftId: draftId,
      baseRevision: scenario.draft.revision,
      placement: { kind: 'after', nodeId: stepId },
    }),
  })
  const checkItem = preview.suggestions.find((item) => item.action === 'check')
  check(
    'check 没有被错误降级成可接受步骤',
    checkItem?.status === 'unresolved',
    checkItem?.status,
  )

  await web.goto(href || `${webOrigin}/scenarios/${scenario.id}?import=${draftId}`)
  await web.getByRole('heading', { name: '示教回填预览' }).waitFor({ timeout: 20_000 })
  await web.getByText(/项来源 · 已处理/).waitFor({ timeout: 20_000 })
  check('Studio 用 import 打开预览', true)

  const pendingCard = web.locator('[data-slot="sheet-content"] li').filter({ hasText: '无法自动转换，需要处理' }).first()
  await pendingCard.waitFor({ timeout: 10_000 })
  const discardInCard = pendingCard.getByRole('button', { name: '舍弃' })
  if (await discardInCard.count()) await discardInCard.click()
  const reason = pendingCard.getByLabel('舍弃原因')
  await reason.waitFor({ timeout: 10_000 })
  await reason.fill('探针：本期不回填勾选')
  for (const button of await web.getByRole('button', { name: '接受', exact: true }).all()) if (await button.isEnabled()) await button.click()
  const apply = web.getByRole('button', { name: /确认回填 \d+ 项/ })
  await apply.waitFor({ state: 'visible', timeout: 10_000 })
  const applyReady = await web
    .waitForFunction(
      () =>
        [...document.querySelectorAll('button')].some(
          (button) => /确认回填 \d+ 项/.test(button.textContent ?? '') && !button.disabled,
        ),
      undefined,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false)
  check(
    '填了舍弃原因后可以回填',
    applyReady,
    applyReady ? '' : await web.locator('[data-slot="sheet-content"]').innerText().catch(() => web.locator('body').innerText()),
  )
  if (applyReady) await apply.click()
  const appliedToast = applyReady
    ? await web
        .getByText('已回填到当前草稿', { exact: true })
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
    : false
  if (appliedToast) {
    await web.waitForURL((url) => !url.searchParams.get('import'), { timeout: 10_000 }).catch(() => {})
    await web.getByRole('heading', { name: '执行步骤' }).waitFor({ timeout: 10_000 }).catch(() => {})
  }
  let highlightError = ''
  const highlighted = await web
    .locator('[data-imported]')
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch((error) => {
      highlightError = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
      return false
    })
  check('Studio 回填写入当前草稿', appliedToast, `toast=${appliedToast} highlight=${highlighted}`)
  check('回填后高亮新步骤', highlighted, highlightError)

  const latest = await api(`/api/scenarios/${scenario.id}`, token)
  const types = (latest.draft?.document.nodes?.filter((node) => node.kind === 'step').map((node) => node.step) ?? latest.draft?.document.steps ?? []).map((step) => step.type)
  check('回填后仍保留原 navigate', types[0] === 'navigate', types.join(','))
  check(
    '回填插入了可执行确定性步骤',
    types.includes('fill') || types.includes('click') || types.filter((type) => type === 'navigate').length >= 2,
    types.join(','),
  )
  check('勾选没有变成可执行 Step', !types.includes('check') && !types.includes('uncheck'), types.join(','))
} catch (error) {
  check('探针未抛未捕获异常', false, error instanceof Error ? error.message : String(error))
} finally {
  await api(`/api/recording-bindings/${created.binding.id}/close`, token, { method: 'POST' }).catch(() => {})
  await context.close().catch(() => {})
  fixture.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
if (failed.length) {
  console.log('失败项：')
  for (const item of failed) console.log(`- ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
}
process.exit(failed.length ? 1 : 0)
