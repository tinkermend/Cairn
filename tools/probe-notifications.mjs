#!/usr/bin/env node
// Real browser -> isolated API/database -> notification dispatcher -> local TLS SMTP receiver.
// Requires built workspace packages. Never uses the running stack's application database or recipients.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { randomUUID, createHmac } from 'node:crypto'
import { createServer } from 'node:https'
const apiRequire = createRequire(resolve('packages/api/package.json'))
const workerRequire = createRequire(resolve('packages/worker/package.json'))
apiRequire('reflect-metadata')
const { Test } = apiRequire('@nestjs/testing')
const { AppModule } = apiRequire('./dist/app.module.js')
const { DB_HANDLE } = apiRequire('./dist/db/db.module.js')
const { CHANGE_HINT } = apiRequire('./dist/observe/change-hint.module.js')
const { config } = apiRequire('./dist/config/env.js')
const { LocalSecretProvider, credentialKeyFromEnv } = apiRequire(
  './dist/secrets/local-secret-provider.js',
)
const db = apiRequire('@cairn/db')
const fixture = apiRequire('@cairn/db/testing')
const { NOTIFICATION_WORKER_PROTOCOL } = apiRequire('@cairn/shared')
const { deliverNotifications } = workerRequire('./dist/runtime/notification-delivery.js')
const { chromium } = workerRequire('playwright')
const { SMTPServer } = workerRequire('smtp-server')
const root = process.cwd(),
  output = resolve('.run/notifications-phase-one')
await mkdir(output, { recursive: true })
const tlsDirectory = await mkdtemp(join(tmpdir(), 'cairn-notification-probe-'))
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,DNS:notification.test,IP:127.0.0.1',
    '-keyout',
    join(tlsDirectory, 'key.pem'),
    '-out',
    join(tlsDirectory, 'cert.pem'),
  ],
  { stdio: 'ignore' },
)
const cert = await readFile(join(tlsDirectory, 'cert.pem')),
  key = await readFile(join(tlsDirectory, 'key.pem'))
const originalCAs = getCACertificates()
setDefaultCACertificates([...originalCAs, cert.toString()])
const hooks = []
const webhook = createServer({ key, cert }, (req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c.toString()
  })
  req.on('end', () => {
    hooks.push({
      body,
      timestamp: req.headers['x-cairn-timestamp'],
      signature: req.headers['x-cairn-signature'],
    })
    res.writeHead(204)
    res.end()
  })
})
await new Promise((resolve) => webhook.listen(0, '127.0.0.1', resolve))
const webhookPort = webhook.address().port
const messages = []
let disconnectAfterData = false
const smtp = new SMTPServer({
  key,
  cert,
  secure: false,
  logger: false,
  onAuth(_auth, _session, cb) {
    cb(null, { user: 'notification-fixture' })
  },
  onRcptTo(address, _session, cb) {
    cb(
      address.address.startsWith('reject')
        ? Object.assign(new Error('fixture recipient rejected'), { responseCode: 550 })
        : undefined,
    )
  },
  onData(stream, session, cb) {
    let body = ''
    stream.on('data', (chunk) => {
      body += chunk.toString()
    })
    stream.on('end', () => {
      messages.push({ recipients: session.envelope.rcptTo.map((r) => r.address), body })
      if (disconnectAfterData) {
        for (const c of smtp.connections) c.close()
        return
      }
      cb()
    })
  },
})
smtp.on('error', () => undefined)
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve))
const smtpPort = smtp.server.address().port
const handle = await fixture.openIsolatedDb(
  `cairn_notification_ui_${randomUUID().replaceAll('-', '')}`,
)
let app, web, browser, token, page
const checks = []
const check = (name, condition = true) => {
  assert.ok(condition, name)
  checks.push(name)
  console.log(`PASS ${name}`)
}
try {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_HANDLE)
    .useValue(handle)
    .overrideProvider(CHANGE_HINT)
    .useValue({
      driver: 'none',
      realtime: false,
      namespace: 'notification-test',
      publish: async () => {},
      subscribe: async () => {},
      ping: async () => true,
      close: async () => {},
    })
    .compile()
  app = module.createNestApplication({ logger: false })
  app.setGlobalPrefix('api', { exclude: ['health'] })
  await app.listen(0, '127.0.0.1')
  const origin = await app.getUrl()
  async function api(path, body, bearer = token, expectedStatus) {
    const res = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await res.json().catch(() => ({}))
    if (expectedStatus) {
      assert.equal(res.status, expectedStatus, `${path}: ${json.message}`)
      return json
    }
    assert.ok(res.ok, `${path}: HTTP ${res.status} ${json.message}`)
    return json
  }
  token = (
    await api('/auth/login', {
      email: config.CAIRN_BOOTSTRAP_ADMIN_EMAIL,
      password: config.CAIRN_BOOTSTRAP_ADMIN_PASSWORD,
    })
  ).accessToken
  const target = await api('/targets', {
    code: 'notification-probe',
    name: '通知验收目标',
    entryUrl: 'https://example.test',
  })
  const scenario = await api('/scenarios', {
    targetId: target.id,
    name: '订单状态检查与结果通知的中文长名称验收场景',
    steps: [
      {
        id: randomUUID(),
        name: '回显结果',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: 'sensitive-fixture-must-not-be-notified' },
      },
    ],
  })
  const worker = { workerId: 'notification-ui-worker', instanceId: randomUUID() }
  await db.registerWorker(handle, {
    ...worker,
    capacity: 1,
    lostAfterSeconds: 3600,
    protocolCapabilities: [NOTIFICATION_WORKER_PROTOCOL],
  })
  const dispatch = () =>
    deliverNotifications({
      db: handle,
      ...worker,
      secrets: new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
      smtpDestinations: [`localhost:${smtpPort}`],
      resolveDestination: async (url) => {
        assert.equal(new URL(url).hostname, 'notification.test')
        return [{ address: '127.0.0.1', family: 4 }]
      },
    })
  const port = Number(process.env.CAIRN_NOTIFICATION_PROBE_WEB_PORT ?? 5197),
    webOrigin = `http://127.0.0.1:${port}`
  web = spawn(
    'pnpm',
    [
      '--filter',
      '@cairn/web',
      'exec',
      'vite',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: root,
      env: { ...process.env, CAIRN_API_ORIGIN: origin },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let webError = ''
  web.stderr.on('data', (c) => {
    webError += c.toString()
  })
  for (let i = 0; ; i++) {
    if (web.exitCode !== null) throw new Error(`Vite failed: ${webError.slice(-1200)}`)
    try {
      if ((await fetch(webOrigin)).ok) break
    } catch {}
    if (i > 80) throw new Error('Vite startup timeout')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(15_000)
  const jsErrors = []
  page.on('pageerror', (error) => jsErrors.push(error.message))
  await page.goto(`${webOrigin}/sign-in`)
  await page.getByRole('textbox', { name: /^账号$/ }).fill(config.CAIRN_BOOTSTRAP_ADMIN_EMAIL)
  await page.getByLabel(/^密码$/).fill(config.CAIRN_BOOTSTRAP_ADMIN_PASSWORD)
  await page.getByRole('button', { name: /^登录$/ }).click()
  await page.waitForURL((url) => !url.pathname.includes('sign-in'))
  await page.goto(`${webOrigin}/notifications?tab=channels`)
  await page.getByRole('checkbox', { name: '启用通知', exact: true }).check()
  await page.getByRole('textbox', { name: '控制台地址' }).fill('https://console.example.test')
  await page.getByRole('textbox', { name: '变更原因', exact: true }).fill('通知隔离验收')
  await page.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await page.getByText('通知设置已保存', { exact: true }).waitFor()
  await page.getByRole('button', { name: '配置邮件发送' }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'SMTP 主机' }).fill('localhost')
  await dialog.getByRole('spinbutton', { name: '端口' }).fill(String(smtpPort))
  await dialog.getByRole('textbox', { name: '用户名', exact: true }).fill('fixture')
  await dialog.getByLabel('密码', { exact: true }).fill('synthetic-only-password')
  await dialog.getByRole('textbox', { name: '发件人邮箱' }).fill('sender@example.test')
  await dialog.getByRole('textbox', { name: '变更原因' }).fill('隔离 TLS 邮件服务器')
  await dialog.getByRole('button', { name: '保存邮件配置' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '添加渠道' }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '渠道名称' }).fill('验收邮件渠道')
  await dialog.getByRole('combobox', { name: '发送方式' }).selectOption('email')
  await dialog
    .getByRole('textbox', { name: '收件人', exact: false })
    .fill('accepted@example.test reject@example.test')
  await dialog.getByRole('checkbox', { name: '通知验收目标', exact: true }).check()
  await dialog.getByRole('textbox', { name: '变更原因' }).fill('授权合成目标')
  await dialog.getByRole('button', { name: '保存渠道' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '测试发送', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '操作原因' }).fill('真实 SMTP 接收验证')
  await dialog.getByRole('button', { name: '确认发送' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await dispatch()
  check(
    'UI 保存 SMTP 与邮件渠道，真实接收端只有一个被接受收件人',
    messages.length === 1 && messages[0].recipients.join() === 'accepted@example.test',
  )
  await page.getByRole('tab', { name: '通知记录', exact: true }).click()
  await page.getByRole('button', { name: '查看详情' }).first().click()
  dialog = page.getByRole('dialog')
  await dialog.getByText('对方已接受', { exact: true }).waitFor()
  await dialog.getByText('发送失败', { exact: true }).waitFor()
  await page.screenshot({
    path: join(output, 'partial-delivery-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  check('页面逐收件人展示部分成功与失败')
  await dialog.getByRole('button', { name: '再次发送', exact: true }).click()
  await dialog.getByRole('textbox', { name: '处理原因' }).fill('只重试拒收地址')
  await dialog.getByRole('button', { name: '确认发送', exact: true }).click()
  await dispatch()
  check('人工重试失败收件人不重复已接受地址', messages.length === 1)
  await page.keyboard.press('Escape')
  await page.goto(`${webOrigin}/notifications?tab=results&scenarioId=${scenario.id}`)
  await page.getByRole('checkbox', { name: '启用结果通知', exact: true }).check()
  await page.getByRole('combobox', { name: '通知条件' }).selectOption('all_finished')
  await page.getByRole('checkbox', { name: /验收邮件渠道/ }).check()
  await page.getByRole('textbox', { name: '变更原因' }).fill('正式运行结果通知')
  await page.getByRole('button', { name: '保存结果通知' }).click()
  await page.getByText('场景通知设置已保存', { exact: true }).waitFor()
  const run = await api('/runs', { scenarioId: scenario.id })
  await api(`/runs/${run.id}/cancel`, {})
  await db.prepareNotificationEvents(handle, { now: new Date(Date.now() + 61_000) })
  await dispatch()
  check(
    '正式 Run 终态产生真实邮件，正文不含原始输入',
    messages.length === 2 && !messages[1].body.includes('sensitive-fixture-must-not-be-notified'),
  )
  await page.goto(`${webOrigin}/notifications?tab=records&runId=${run.id}`)
  await page.getByRole('button', { name: '查看详情' }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByText('执行已取消', { exact: true }).waitFor()
  await dialog.getByText('未评价业务结果', { exact: true }).waitFor()
  check('运行详情保留执行、业务结果、证据三轴')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: join(output, 'records-390.png'),
    fullPage: true,
    animations: 'disabled',
  })
  check(
    '390px 页面无横向溢出',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  )
  await page.goto(`${webOrigin}/notifications?tab=channels`)
  await page.getByRole('button', { name: '添加渠道' }).click()
  dialog = page.getByRole('dialog')
  await page.keyboard.press('Tab')
  check(
    '键盘焦点保持在渠道弹窗',
    await dialog.evaluate((el) => el.contains(document.activeElement)),
  )
  await page.screenshot({
    path: join(output, 'channel-form-390.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  disconnectAfterData = true
  const uncertain = await api('/runs', { scenarioId: scenario.id })
  await api(`/runs/${uncertain.id}/cancel`, {})
  await db.prepareNotificationEvents(handle, { now: new Date(Date.now() + 61_000) })
  await dispatch()
  await dispatch()
  check('SMTP 正文接收后断连不自动重发', messages.length === 3)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${webOrigin}/notifications?tab=records&runId=${uncertain.id}`)
  await page.getByRole('button', { name: '查看详情' }).click()
  dialog = page.getByRole('dialog')
  const unknownDelivery = dialog
    .locator('section')
    .filter({ has: page.getByText('结果不明', { exact: true }) })
  await unknownDelivery.getByRole('button', { name: '再次发送', exact: true }).click()
  await dialog.getByRole('textbox', { name: '处理原因' }).fill('核对接收器后的单次人工重发')
  check(
    '结果不明必须确认重复风险才能再次发送',
    await dialog.getByRole('button', { name: '确认发送', exact: true }).isDisabled(),
  )
  await dialog.getByRole('checkbox', { name: /原发送可能已被接受/ }).check()
  await page.screenshot({
    path: join(output, 'unknown-confirmation-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  disconnectAfterData = false
  await dialog.getByRole('button', { name: '确认发送', exact: true }).click()
  await dispatch()
  check(
    '人工确认仅重发未知收件人，Message-ID 保持稳定',
    messages.length === 4 &&
      /Message-ID: ([^\r\n]+)/.exec(messages[2].body)?.[1] ===
        /Message-ID: ([^\r\n]+)/.exec(messages[3].body)?.[1],
  )
  await page.keyboard.press('Escape')
  const beforeHook = await api('/notifications/channels')
  const withHook = await api('/notifications/channels', {
    expectedRevision: beforeHook.revision,
    reason: '真实 Webhook 协议验收',
    name: '验收 Webhook',
    kind: 'webhook',
    enabled: true,
    allowAlerts: true,
    targetIds: [target.id],
    format: 'cairn.notification@1',
    replay: 'manual_on_unknown',
    url: `https://notification.test:${webhookPort}/notify`,
    signingKey: 'synthetic-signature-key',
  })
  const hook = withHook.channels.find((c) => c.kind === 'webhook')
  await api(`/notifications/channels/${hook.id}/test`, {
    idempotencyKey: randomUUID(),
    reason: 'TLS 字节签名验收',
  })
  await dispatch()
  check(
    '真实 API、数据库与 HTTPS Webhook 完整链路，签名匹配接收字节',
    hooks.length === 1 &&
      hooks[0].signature ===
        `v1=${createHmac('sha256', 'synthetic-signature-key').update(`${hooks[0].timestamp}.${hooks[0].body}`).digest('hex')}` &&
      JSON.parse(hooks[0].body).protocol === 'cairn.notification@1',
  )
  const current = await api('/notifications/channels'),
    channel = current.channels[0]
  await api(
    '/notifications/settings',
    {
      expectedRevision: current.revision - 1,
      reason: '旧修订反例',
      enabled: true,
      consoleBaseUrl: current.consoleBaseUrl,
    },
    token,
    409,
  )
  const metadata = JSON.stringify(current)
  check(
    '管理接口不返回秘密或完整邮箱',
    !metadata.includes('synthetic-only-password') &&
      !metadata.includes('accepted@example.test') &&
      !metadata.includes('secretRef'),
  )
  const roles = await api('/rbac/roles'),
    viewer = roles.items.find((r) => r.key === 'viewer')
  const viewerAccount = await api('/console/accounts', {
    email: 'notification-viewer',
    displayName: '受限验收账号',
    password: 'SyntheticViewer123!',
    roleIds: [viewer.id],
    targetScopes: [{ roleId: viewer.id, mode: 'none', targetIds: [] }],
  })
  const viewerToken = (
    await api('/auth/login', { email: 'notification-viewer', password: 'SyntheticViewer123!' }, '')
  ).accessToken
  const records = await api('/notifications/events?type=run', undefined, viewerToken)
  check('无目标授权看不到运行通知', records.items.length === 0)
  await api(
    `/notifications/channels/${channel.id}/test`,
    { idempotencyKey: randomUUID(), reason: '越权反例' },
    viewerToken,
    403,
  )
  await api('/notifications/channels', undefined, viewerToken, 404)
  check('直调测试发送与渠道读取越权被拒绝')
  const stream = await fetch(`${origin}/api/notifications/stream?type=run`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  const initialFrame = await reader.read()
  check(
    'SSE 初始快照遵守 Target 范围',
    !initialFrame.done && new TextDecoder().decode(initialFrame.value).includes('"items":[]'),
  )
  await api(`/console/accounts/${viewerAccount.id}`, { status: 'disabled' })
  let closed = false
  while (!closed) {
    closed = (await reader.read()).done
  }
  check('账号停用后 SSE 在下一次授权复核时关闭', closed)
  await page.goto(`${webOrigin}/platform-config?tab=alerting`)
  await page.waitForURL(
    (url) => url.pathname.includes('notifications') && url.searchParams.get('tab') === 'alerts',
  )
  check('旧告警入口重定向到统一通知页')
  check('通知真实页面无未捕获 JavaScript 错误', jsErrors.length === 0)
  await writeFile(
    join(output, 'checks.json'),
    JSON.stringify(
      {
        checks,
        receivedMessages: messages.length,
        receivedWebhooks: hooks.length,
        virtualClock:
          'The queued Run cancellation evidence wait was advanced by 61 seconds; SMTP and HTTP were real.',
      },
      null,
      2,
    ),
  )
  await rm(join(output, 'failure.png'), { force: true })
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png'), fullPage: true, animations: 'disabled' })
      .catch(() => {})
  throw error
} finally {
  await browser?.close()
  web?.kill('SIGTERM')
  await app?.close()
  if (!app) await handle.close()
  await new Promise((resolve) => smtp.close(resolve))
  await new Promise((resolve) => webhook.close(resolve))
  setDefaultCACertificates(originalCAs)
  await rm(tlsDirectory, { recursive: true, force: true })
}
