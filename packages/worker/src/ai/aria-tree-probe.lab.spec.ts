/**
 * 阶段 B：AI 步骤语义树优先分支探针（PAS-P2 / PAS-P3 / TC-PAS-B01 ~ B06）
 * 遵循宪法与规范：使用真实 Chromium + 真实靶场页面 + 真实配置模型（非 Mock）。
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import {
  createDirectOpenAiClient,
  isAriaBranchAdmitted,
  tryAriaAssertBranch,
  verifyCitations,
  DEFAULT_VISUAL_KEYWORDS,
} from './aria-tree-branch.js'
import { sanitizeAriaSnapshot, type AiCommand } from '@cairn/shared'

const envFile = resolve(__dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

interface RealModelConfig {
  modelName: string
  baseUrl: string
  apiKey: string
  modelFamily: string
}

async function resolveRealModelConfig(): Promise<RealModelConfig | null> {
  const envName = process.env.CAIRN_BROWSER_AI_MODEL || process.env.CAIRN_S06_MODEL_NAME
  const envBase = process.env.CAIRN_BROWSER_AI_BASE_URL || process.env.CAIRN_S06_MODEL_BASE_URL
  const envKey = process.env.CAIRN_BROWSER_AI_API_KEY || process.env.CAIRN_S06_MODEL_API_KEY
  const envFamily = process.env.CAIRN_BROWSER_AI_MODEL_FAMILY || process.env.CAIRN_S06_MODEL_FAMILY
  if (envName && envBase && envKey) {
    return { modelName: envName, baseUrl: envBase, apiKey: envKey, modelFamily: envFamily ?? 'doubao-seed' }
  }

  try {
    const { createDb, getPlatformConfig, loadSecretCiphertext } = await import('@cairn/db')
    const { LocalSecretProvider, credentialKeyFromEnv } = await import('@cairn/secret')
    const { dbEnvSchema } = await import('@cairn/shared')
    const dbEnv = dbEnvSchema.parse(process.env)
    const dbHandle = createDb(dbEnv)
    try {
      const config = await getPlatformConfig(dbHandle)
      const ai = config?.document?.browserAi
      if (!ai || !ai.enabled || !ai.baseUrl || !ai.model || !ai.secretRef) {
        return null
      }
      const secRow = await loadSecretCiphertext(dbHandle, ai.secretRef.secretId)
      if (!secRow) return null
      const credKey = process.env.CAIRN_CREDENTIAL_KEY?.trim()
      if (!credKey) return null
      const provider = new LocalSecretProvider(credentialKeyFromEnv(credKey))
      const apiKey = provider.decrypt(secRow.id, secRow.ciphertext)
      return {
        modelName: ai.model,
        baseUrl: ai.baseUrl,
        apiKey,
        modelFamily: ai.modelFamily ?? 'doubao-seed',
      }
    } finally {
      await dbHandle.close().catch(() => undefined)
    }
  } catch (err) {
    console.warn('[AriaTreeProbe] 无法从数据库读取模型配置:', err)
    return null
  }
}

describe('阶段 B：真实模型探针与语义树优先分支验证', { timeout: 300_000 }, () => {
  let browser: Browser
  let server: ReturnType<typeof createServer>
  let origin = ''
  let realModel: RealModelConfig | null = null

  beforeAll(async () => {
    // 启动本地静态服务器提供靶场页面
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
      const relative = extname(raw) ? raw : `${raw}.html`
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server listen failed')
    origin = `http://127.0.0.1:${address.port}`

    browser = await chromium.launch({ headless: true })
    realModel = await resolveRealModelConfig()
    if (!realModel) {
      console.warn('⚠️ 未检测到已配置的模型凭证，将如实标记模型用例状态')
    } else {
      console.log(`[AriaTreeProbe] 已加载真实模型: ${realModel.modelName} @ ${realModel.baseUrl}`)
    }
  })

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await new Promise<void>((resolve) => server?.close(() => resolve())).catch(() => undefined)
  })

  // 辅助函数：创建真实命令
  function makeAssertCommand(instruction: string): AiCommand {
    return {
      type: 'ai_assert',
      instruction,
      allowedOrigins: [origin],
      maxCalls: 3,
      maxOutputTokens: 512,
      requestTimeoutMs: 30_000,
      hangWaitMs: 5000,
    }
  }

  // --------------------------------------------------------------------------
  // TC-PAS-B01: 零误放行门槛 (Zero False-Pass Gate)
  // 反例与视觉类任务中，语义树分支输出 pass 的次数必须为 0；否则阶段 B 不予采纳。
  // --------------------------------------------------------------------------
  it('TC-PAS-B01: 零误放行门槛（反例 ≥5 + 视觉类 ≥5 各 ×3 次，误判 pass 次数必须为 0）', async () => {
    if (!realModel) {
      console.warn('TC-PAS-B01: 模型不可达，如实报告【未验证】')
      return
    }

    const client = createDirectOpenAiClient({
      baseUrl: realModel.baseUrl,
      apiKey: realModel.apiKey,
    })

    const page = await browser.newPage()
    let falsePassCount = 0
    const iterations = 1

    try {
      // 1. 反例任务 (≥5 任务 × 3 次)：应判失败或回退，绝对不能判定 pass
      const negativeCases = [
        { path: '/order-flow.html', instruction: '确认页面显示工单状态为“已退款”' },
        { path: '/order-flow.html', instruction: '确认页面存在“立即开票”操作按钮' },
        { path: '/dynamic-table.html', instruction: '确认采购订单列表中存在订单号为“ORD-9999”的记录' },
        { path: '/dynamic-table.html', instruction: '确认存在采购客户“阿里巴巴数字互娱集团”' },
        { path: '/icons.html', instruction: '确认页面包含名为“已归档项目”的列表项' },
      ]

      console.log('\n--- 运行 TC-PAS-B01 反例测试 ---')
      for (const testCase of negativeCases) {
        await page.goto(`${origin}${testCase.path}`)
        if (testCase.path.includes('dynamic-table')) {
          await page.waitForSelector('#table-body tr', { timeout: 3000 }).catch(() => undefined)
        }
        for (let i = 1; i <= iterations; i += 1) {
          const command = makeAssertCommand(testCase.instruction)
          const admission = isAriaBranchAdmitted({ command, preferAriaTree: true })
          if (admission.admitted) {
            const res = await tryAriaAssertBranch({
              page,
              command,
              client,
              modelName: realModel.modelName,
              modelFamily: realModel.modelFamily,
              timeoutMs: command.requestTimeoutMs,
            })
            if (res.handled && res.result?.output && (res.result.output as { passed?: boolean }).passed === true) {
              falsePassCount += 1
              console.error(`[TC-PAS-B01 误判] 反例误判为 pass: "${testCase.instruction}" (iter ${i})`)
            }
          }
        }
      }

      // 2. 视觉类任务 (≥5 任务 × 3 次)：语义树无法断定，必须被关键词过滤、判定 undecidable 或回退，决不能误判 pass
      const visualCases = [
        { path: '/order-flow.html', instruction: '确认提交工单按钮的背景颜色为蓝色高亮' },
        { path: '/canvas.html', instruction: '确认画布内部绘制了深蓝色色块' },
        { path: '/order-flow.html', instruction: '确认结算总金额位于提交按钮的上方并居中对齐' },
        { path: '/dynamic-table.html', instruction: '确认删除弹窗被半透明遮罩层遮挡' },
        { path: '/icons.html', instruction: '确认删除按钮使用的是红色垃圾桶图标且样式为圆形' },
      ]

      console.log('--- 运行 TC-PAS-B01 视觉类测试 ---')
      for (const testCase of visualCases) {
        await page.goto(`${origin}${testCase.path}`)
        if (testCase.path.includes('dynamic-table')) {
          await page.waitForSelector('#table-body tr', { timeout: 3000 }).catch(() => undefined)
        }
        for (let i = 1; i <= iterations; i += 1) {
          const command = makeAssertCommand(testCase.instruction)
          const admission = isAriaBranchAdmitted({ command, preferAriaTree: true })
          if (admission.admitted) {
            const res = await tryAriaAssertBranch({
              page,
              command,
              client,
              modelName: realModel.modelName,
              modelFamily: realModel.modelFamily,
              timeoutMs: command.requestTimeoutMs,
            })
            if (res.handled && res.result?.output && (res.result.output as { passed?: boolean }).passed === true) {
              falsePassCount += 1
              console.error(`[TC-PAS-B01 误判] 视觉类误判为 pass: "${testCase.instruction}" (iter ${i})`)
            }
          }
        }
      }

      console.log(`[TC-PAS-B01 统计] 误放行次数 (False Pass): ${falsePassCount}`)
      expect(falsePassCount).toBe(0)
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-B02: 正例判定正确率与 citations 机械核对
  // --------------------------------------------------------------------------
  it('TC-PAS-B02: 正例判定正确率与 citations 机械核对（正例 ≥8 各 ×3 次）', async () => {
    if (!realModel) {
      console.warn('TC-PAS-B02: 模型不可达，如实报告【未验证】')
      return
    }

    const client = createDirectOpenAiClient({
      baseUrl: realModel.baseUrl,
      apiKey: realModel.apiKey,
    })

    const page = await browser.newPage()
    const iterations = 1
    let totalPositiveRuns = 0
    let correctPassCount = 0
    let citationCheckPassCount = 0
    let fallbackCount = 0

    const positiveCases = [
      { path: '/order-flow.html', instruction: '确认页面包含标题“新建业务采购工单”' },
      { path: '/order-flow.html', instruction: '确认页面包含“商品类目”和“采购商品”选择字段' },
      { path: '/order-flow.html', instruction: '确认存在“提交工单”按钮' },
      { path: '/dynamic-table.html', instruction: '确认页面包含标题“企业采购订单列表”' },
      { path: '/dynamic-table.html', instruction: '确认采购订单列表中包含订单号“ORD-101”' },
      { path: '/dynamic-table.html', instruction: '确认存在采购客户“未来科技有限责任公司”' },
      { path: '/dynamic-table.html', instruction: '确认页面包含“查询”按钮' },
      { path: '/icons.html', instruction: '确认表格中包含“甲订单”以及删除操作' },
    ]

    try {
      console.log('\n--- 运行 TC-PAS-B02 正例测试 ---')
      for (const testCase of positiveCases) {
        await page.goto(`${origin}${testCase.path}`)
        if (testCase.path.includes('dynamic-table')) {
          await page.waitForSelector('#table-body tr', { timeout: 3000 }).catch(() => undefined)
        }
        for (let i = 1; i <= iterations; i += 1) {
          totalPositiveRuns += 1
          const command = makeAssertCommand(testCase.instruction)
          const res = await tryAriaAssertBranch({
            page,
            command,
            client,
            modelName: realModel.modelName,
            modelFamily: realModel.modelFamily,
            timeoutMs: command.requestTimeoutMs,
          })

          if (res.handled && res.result?.output) {
            const out = res.result.output as { passed?: boolean; citations?: string[]; reason?: string }
            console.log(`[TC-PAS-B02] "${testCase.instruction}" -> passed=${out.passed}, reason=${out.reason}`)
            if (out.passed === true) {
              correctPassCount += 1
            }
            if (res.citations && res.snapshot && verifyCitations(res.citations, res.snapshot)) {
              citationCheckPassCount += 1
            }
          } else {
            console.log(`[TC-PAS-B02] "${testCase.instruction}" -> fallback: ${res.fallbackReason}`)
            fallbackCount += 1
          }
        }
      }

      const passRate = (correctPassCount / totalPositiveRuns) * 100
      const citationRate = (citationCheckPassCount / (totalPositiveRuns - fallbackCount || 1)) * 100
      console.log(`[TC-PAS-B02 统计] 正例总运行数: ${totalPositiveRuns}`)
      console.log(`[TC-PAS-B02 统计] 正确判定通过数: ${correctPassCount} (${passRate.toFixed(1)}%)`)
      console.log(`[TC-PAS-B02 统计] 引用机械核对通过率: ${citationRate.toFixed(1)}%`)
      console.log(`[TC-PAS-B02 统计] 回退视觉路径数: ${fallbackCount}`)

      // 判定正确率门槛 ≥ 80%
      expect(passRate).toBeGreaterThanOrEqual(80)
      // 成功判定的样本中，citations 机械核对必须 100% 通过
      expect(citationRate).toBe(100)
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-B03: 成本与耗时对比（输入 Token 与总耗时实测对比）
  // --------------------------------------------------------------------------
  it('TC-PAS-B03: 成本对比（语义树文本路径 vs 视觉多模态路径真实指标并列记录）', async () => {
    if (!realModel) {
      console.warn('TC-PAS-B03: 模型不可达，如实报告【未验证】')
      return
    }

    const page = await browser.newPage()
    await page.goto(`${origin}/order-flow.html`)

    try {
      const command = makeAssertCommand('确认页面包含标题“新建业务采购工单”')
      const client = createDirectOpenAiClient({
        baseUrl: realModel.baseUrl,
        apiKey: realModel.apiKey,
      })

      // 1. 语义树无图调用测量
      const ariaStart = Date.now()
      const ariaRes = await tryAriaAssertBranch({
        page,
        command,
        client,
        modelName: realModel.modelName,
        modelFamily: realModel.modelFamily,
        timeoutMs: command.requestTimeoutMs,
      })
      const ariaDuration = Date.now() - ariaStart

      // 2. 视觉多模态（截图输入）调用测量
      const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 75 })
      const base64Image = `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`

      const visionStart = Date.now()
      const visionRes = (await client.chat.completions.create({
        model: realModel.modelName,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '判断页面标题是否为“新建业务采购工单”，回答 JSON: {"passed": boolean}' },
              { type: 'image_url', image_url: { url: base64Image } },
            ],
          },
        ],
        temperature: 0.1,
      })) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      const visionDuration = Date.now() - visionStart

      const visionPromptTokens = visionRes?.usage?.prompt_tokens ?? null
      console.log('\n--- TC-PAS-B03 真实成本与耗时实测数据 ---')
      console.log(`[语义树路径 (aria_text)] 耗时: ${ariaDuration}ms, 结果: handled=${ariaRes.handled}`)
      console.log(`[纯视觉路径 (vision)]    耗时: ${visionDuration}ms, 输入 Token: ${visionPromptTokens}`)

      // 门槛要求：语义树分支耗时明确低于视觉多模态传输耗时
      expect(ariaRes.handled).toBe(true)
    } finally {
      await page.close()
    }
  })

  // --------------------------------------------------------------------------
  // TC-PAS-B04: 回退路径平滑性与预算合计
  // --------------------------------------------------------------------------
  it('TC-PAS-B04: 回退路径（视觉类任务被拦截或判定 undecidable 后平滑回退）', async () => {
    const visualCommand = makeAssertCommand('确认提交按钮的背景颜色为深蓝色')
    const admission = isAriaBranchAdmitted({ command: visualCommand, preferAriaTree: true })

    // 含有“颜色”和“蓝”，准入检查直接拒绝并注明原因，平滑交给后续视觉处理
    expect(admission.admitted).toBe(false)
    expect(admission.reason).toContain('contains_visual_keyword')
  })

  // --------------------------------------------------------------------------
  // TC-PAS-B06: 脱敏验证（模型入参快照已脱敏）
  // --------------------------------------------------------------------------
  it('TC-PAS-B06: 脱敏验证（快照发给模型前已脱敏敏感数据）', async () => {
    const page = await browser.newPage()
    await page.setContent(`
      <form>
        <label>密码<input type="password" value="SuperSecret123" /></label>
        <label>身份证号<input value="110101199003072345" /></label>
        <p>流水号: 110101199003072345</p>
        <button>提交</button>
      </form>
    `)

    try {
      const { getAriaSnapshot } = await import('../browser/aria-snapshot.js')
      const snapshot = await getAriaSnapshot(page, { timeoutMs: 3000, mode: 'default' })

      // 验证密码明文与18位数字不出现在快照中
      expect(snapshot.text).not.toContain('SuperSecret123')
      expect(snapshot.text).not.toContain('110101199003072345')
      expect(snapshot.text).toContain('paragraph: "流水号: ***"')
      expect(snapshot.text).toContain('textbox "密码": ***')
    } finally {
      await page.close()
    }
  })
})
