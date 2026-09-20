#!/usr/bin/env node
// Real Web/API/ObjectStore probe. Uses only synthetic sources and its own Target/Scenarios.
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const require = createRequire(resolve('packages/worker/package.json'))
const { chromium } = require('playwright')
const expect = (locator) => ({
  toBeVisible: () => locator.waitFor({ state: 'visible' }),
  toBeDisabled: async () => {
    for (let i = 0; i < 30; i++) {
      if (await locator.isDisabled()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Expected disabled control')
  },
  not: { toBeVisible: () => locator.waitFor({ state: 'hidden' }) },
})
const apiOrigin = process.env.CAIRN_PROBE_API ?? 'http://localhost:3030'
const webOrigin = process.env.CAIRN_PROBE_WEB ?? 'http://localhost:5173'
const email = process.env.CAIRN_PROBE_EMAIL ?? 'admin'
const password = process.env.CAIRN_PROBE_PASSWORD ?? 'cairn-admin'
const output = resolve('.run/demonstration-phase-one')
await mkdir(output, { recursive: true })
let token
async function api(path, body) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${result.message}`)
  return result
}
token = (await api('/auth/login', { email, password })).accessToken
const target = await api('/targets', {
  code: `difile${Date.now().toString(36)}`,
  name: `示教文件探针 ${Date.now()}`,
  entryUrl: 'https://example.test',
})
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(15_000)
const checks = []
page.on('response', async (response) => {
  if (response.url().includes('/recordings/') && response.status() >= 400)
    console.log(
      `HTTP ${response.status()} ${new URL(response.url()).pathname}: ${(await response.json().catch(() => ({}))).message ?? 'error'}`,
    )
})
function check(name, value) {
  if (!value) throw new Error(name)
  checks.push(name)
  console.log(`PASS ${name}`)
}
try {
  await page.goto(`${webOrigin}/sign-in`)
  await page.getByRole('textbox', { name: /^账号$/ }).fill(email)
  await page.getByLabel(/^密码$/).fill(password)
  await page.getByRole('button', { name: /^登录$/ }).click()
  await page.waitForURL((url) => !url.pathname.includes('sign-in'))
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 120
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 300, 120)
    ctx.fillStyle = '#000'
    ctx.fillText('Synthetic review image', 20, 60)
    return canvas.toDataURL('image/png')
  })
  for (const kind of ['yaml', 'json']) {
    const sourceText =
      kind === 'yaml'
        ? 'web:\n  url: https://example.test\n  cookies: secret-cookie-do-not-send\ntasks:\n  - flow:\n      - aiInput: 订单号\n        value: SO-1\n      - aiTap: 查询\n      - aiAssert: 出现结果\n      - aiWaitFor: 结果稳定'
        : JSON.stringify([
            {
              hashId: 'local-click',
              type: 'click',
              elementDescription: '查询按钮',
              timestamp: 1,
              pageInfo: { width: 1440, height: 900 },
              screenshotBefore: dataUrl,
            },
          ])
    await page.goto(`${webOrigin}/recordings`)
    await page.getByRole('button', { name: '导入录制文件', exact: true }).click()
    await page.getByRole('combobox', { name: '导入目标系统' }).click()
    await page.getByRole('option', { name: target.name, exact: true }).click()
    await page.getByRole('combobox', { name: '来源格式', exact: true }).click()
    await page
      .getByRole('option', {
        name: kind === 'yaml' ? 'Midscene Web YAML' : 'Midscene 录制 JSON',
        exact: true,
      })
      .click()
    const file = page.getByLabel('录制文件（JSON、JSONL 或 YAML）')
    if (kind === 'yaml') {
      await file.setInputFiles({
        name: 'unsupported.js',
        mimeType: 'text/javascript',
        buffer: Buffer.from('throw new Error("must not execute")'),
      })
      await expect(page.getByRole('alert')).toBeVisible()
      check(
        '不执行 JS，错误后仍可更换文件',
        await page.getByRole('button', { name: '保存录制草稿' }).isDisabled(),
      )
    }
    await file.setInputFiles({
      name: `private-file-token-do-not-send.${kind}`,
      mimeType: 'text/plain',
      buffer: Buffer.from(sourceText),
    })
    await page.getByRole('region', { name: '示教来源检查' }).waitFor()
    if (kind === 'yaml') {
      await expect(page.getByRole('button', { name: '保存录制草稿' })).toBeDisabled()
      await page
        .getByRole('checkbox', { name: '我已了解，账号认证与运行策略将使用平台配置。' })
        .check()
    } else {
      await page.getByText('附加截图（可选，默认不上传）', { exact: true }).click()
      await page.getByRole('button', { name: '检查第 1 条前截图' }).click()
      await expect(page.getByRole('button', { name: '确认这张截图' })).toBeDisabled()
      await page
        .getByRole('checkbox', { name: '我已检查整张图片，确认密码、个人资料等敏感内容已遮挡。' })
        .check()
      await page.getByRole('button', { name: '确认这张截图' }).click()
      await page.getByText(/已确认 1 张/).waitFor()
    }
    await page.screenshot({ path: `${output}/${kind}-file-desktop.png`, fullPage: true })
    const outgoing = page.waitForRequest(
      (request) =>
        request.url().endsWith('/api/recordings/demonstrations') && request.method() === 'POST',
    )
    await page.getByRole('button', { name: '保存录制草稿' }).click()
    const wire = (await outgoing).postData()
    check(
      `${kind} 上传包不含原文件名、原配置秘密或内嵌原图`,
      !wire.includes('private-file-token') &&
        !wire.includes('secret-cookie') &&
        !wire.includes('data:image'),
    )
    await page.waitForURL(/\/recordings\/[a-f0-9-]+$/)
    const recordingId = new URL(page.url()).pathname.split('/').at(-1)
    const saved = await api(`/recordings/${recordingId}/demonstration`)
    check(
      `${kind} 来源已持久化且不冒充生产者版本`,
      saved.source.producerVersion === null && saved.source.importProfile.includes(kind),
    )
    if (kind === 'json') {
      check('处理后图片已提交真实对象存储', saved.artifacts[0]?.status === 'available')
      const response = await fetch(
        `${apiOrigin}/api/recordings/${recordingId}/artifacts/${saved.artifacts[0].id}/content`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      check(
        '授权读取实际图片字节',
        response.ok &&
          (await response.arrayBuffer()).byteLength === saved.source.assetManifest[0].byteSize,
      )
    }
    const stepId = crypto.randomUUID()
    const scenario = await api('/scenarios', {
      targetId: target.id,
      name: `文件探针 ${kind} ${Date.now()}`,
      steps: [
        {
          id: stepId,
          name: '原有起点',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'start' },
        },
      ],
    })
    await page.goto(`${webOrigin}/scenarios/${scenario.id}?import=${recordingId}`)
    await page.getByRole('heading', { name: '示教回填预览' }).waitFor()
    if (kind === 'json') {
      await page.getByRole('combobox', { name: '回填位置' }).click()
      await page.getByRole('option', { name: '重新示教「原有起点」', exact: true }).click()
    }
    await page.getByText(/项来源 · 已处理/).waitFor()
    await page
      .getByRole('button', { name: '接受', exact: true })
      .first()
      .waitFor({ state: 'visible' })
    await page.getByText('正在生成预览…', { exact: true }).waitFor({ state: 'hidden' })
    for (const button of await page.getByRole('button', { name: '接受', exact: true }).all())
      if (await button.isEnabled()) await button.click()
    if (kind === 'json')
      await page.getByText('1 项来源 · 已处理 1 项 · 尚需处理 0 项', { exact: true }).waitFor()
    if (kind === 'yaml') {
      await page.getByRole('button', { name: '确认为成功条件', exact: true }).click()
      const unsupported = page
        .locator('[data-slot="sheet-content"] li')
        .filter({ hasText: '无法自动转换，需要处理' })
      await unsupported.getByRole('button', { name: '舍弃', exact: true }).click()
      await unsupported.getByLabel('舍弃原因').fill('另行配置等待')
      await page.getByText('将输入作为参数（可选）', { exact: true }).click()
      await page.getByLabel('参数键').fill('orderNo')
      await page.getByLabel('参数名称').fill('订单号')
      await page.getByRole('button', { name: '确认参数绑定' }).click()
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${output}/${kind}-review-mobile.png`, fullPage: true })
    const dialog = page.getByRole('dialog')
    check(
      `${kind} 窄屏回填不横向溢出`,
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    )
    await page
      .getByRole('button', { name: kind === 'json' ? '替换所选步骤' : /确认回填 \d+ 项/ })
      .click()
    await expect(dialog).not.toBeVisible()
    const latest = await api(`/scenarios/${scenario.id}`)
    const nodes = latest.draft.document.nodes
    check(
      `${kind} 回填写入版本化 V2 草稿`,
      latest.draft.revision === 2 && nodes.some((node) => node.step?.type === 'ai_action'),
    )
    if (kind === 'json')
      check('单步重新示教保留原步骤 ID', nodes.length === 1 && nodes[0].step.id === stepId)
    else
      check(
        '参数与成功条件一并落库',
        latest.draft.document.inputs.some((input) => input.key === 'orderNo') &&
          nodes.some((node) => node.outcomes?.[0]?.provenance === 'imported'),
      )
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true })
  console.error(await page.getByRole('alert').allTextContents())
  throw error
} finally {
  await browser.close()
}
console.log(`${checks.length}/${checks.length} passed; screenshots: ${output}`)
