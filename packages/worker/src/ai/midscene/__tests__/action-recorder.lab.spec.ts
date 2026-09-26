/** AP-0 真实浏览器验收（AP06/AP07）：真实 Midscene + Chromium，仅替换 VL 模型为本地假响应。
 * 验证：派发边参数为逻辑坐标（dpr=1/2 均命中）、元素描述来自 locate.description、
 * 按钮内嵌 span 能绑定 role 候选、表格行中不同操作不会被记成同一绑定、
 * prepared 先于 completed 落库、写请求信号归窗。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createFormalMidsceneAgent, midsceneModelConfig } from '../formal-agent.js'
import { ActionGate } from '../action-gate.js'
import { createFakeChatClient } from '../model-client.js'
import { inspectElementCandidate } from '../../../browser/element-candidate-inspector.js'
import { testAiExecution } from '../../../__tests__/harness.js'
import { appendAiTaskEvent, type AppendAiTaskEventInput } from '@cairn/db'
import { ActionRecorder } from '../action-recorder.js'

const html = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<div style="position:absolute;left:100px;top:100px"><button id="submit" style="width:160px;height:40px"><span>提交订单</span></button></div>
<table style="position:absolute;left:100px;top:300px" border="1">
<tr><td>SO-1001</td><td><a href="#" id="view1">查看</a> <a href="#" id="del1">删除</a></td></tr>
<tr><td>SO-1002</td><td><a href="#" id="view2">查看</a> <a href="#" id="del2">删除</a></td></tr>
</table></body></html>`

const appendSpy = vi.fn()

const RUN = '00000000-0000-4000-8000-000000000001'
const ATT = '00000000-0000-4000-8000-000000000002'
const STEP_RUN = '00000000-0000-4000-8000-000000000003'
const fakeGrant = () => ({
  runId: RUN,
  leaseId: '00000000-0000-4000-8000-000000000004',
  fencingToken: 1,
  holderWorkerId: 'lab-worker',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
})

import * as formalAgentModule from '../formal-agent.js'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    appendAiTaskEvent: (db: unknown, input: AppendAiTaskEventInput) => {
      appendSpy(input)
      return Promise.resolve({ ok: true as const, eventId: `ev-${appendSpy.mock.calls.length}` })
    },
  }
})

describe('AP-0 动作事实：真实 Chromium + Midscene（假模型）', { timeout: 120_000 }, () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })
  afterAll(async () => {
    await browser?.close()
  })

  for (const dpr of [1, 2]) {
    it(`AP06/AP07 dpr=${dpr}：录制链路产出可绑定的动作事实`, async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: dpr,
      })
      const page = await context.newPage()
      await page.setContent(html)
      const writes: string[] = []
      const onRequest = (req: { method(): string; url(): string }) => {
        if (req.method() === 'POST') writes.push(req.url())
      }
      page.on('request', onRequest)

      const recorder = new ActionRecorder({
        page,
        attemptId: ATT,
        runId: RUN,
        stepRunId: STEP_RUN,
        agentInstanceId: 'agent-lab',
        grant: fakeGrant(),
        db: {} as never,
        allowedOrigins: ['https://example.com'],
      })
      const agent = await createFormalMidsceneAgent({
        page,
        gate: new ActionGate(),
        readonly: false,
        recorder,
        modelConfig: midsceneModelConfig({ config: testAiExecution(), apiKey: 'x' }),
        wrapClient: () =>
          createFakeChatClient(async () => {
            const box = (await page.locator('#submit').boundingBox())!
            const vp = page.viewportSize()!
            const bbox = [box.x, box.y, box.x + box.width, box.y + box.height].map((v, i) =>
              Math.round((v / (i % 2 ? vp.height : vp.width)) * 1000),
            )
            return {
              id: 'lab',
              object: 'chat.completion',
              created: 1,
              model: 'cairn-fake',
              choices: [
                { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ bbox }) } },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }
          }),
      })
      appendSpy.mockClear()
      try {
        await agent.aiAtomic({ operation: 'tap', targetDescription: '提交订单按钮' })
      } finally {
        await agent.destroy()
        recorder.destroy()
      }

      const inputs = appendSpy.mock.calls.map((c) => c[0] as AppendAiTaskEventInput)
      expect(inputs.length).toBeGreaterThanOrEqual(2)
      const prepared = inputs.find((e) => e.phase === 'prepared')
      const completed = inputs.find((e) => e.phase === 'completed')
      expect(prepared).toBeDefined()
      expect(completed).toBeDefined()
      // 元素描述来自 locate.description，而不是猜 prompt
      expect(prepared!.elementDescription).toBe('提交订单按钮')
      // 点检命中逻辑坐标：重定向到 button 并绑定 role 候选（dpr=2 也不能落到 <html> 上）
      expect(prepared!.binding.status).toBe('bound')
      expect(prepared!.binding.redirected).toBe(true)
      expect(prepared!.binding.candidates[0]?.by).toBe('role')
      expect(prepared!.binding.candidates[0]?.name).toBe('提交订单')
      // completed 带动作后页面观察；写请求窗口随动作收尾闭合
      expect(completed!.pageAfter).toBeDefined()
      expect(completed!.writeSignalPaths).toEqual([])
      expect(writes).toEqual([])
      await context.close()
    })
  }

  it('AP07 表格行：查看与删除不产生同一绑定；仅行锚点时 unbound', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.setContent(html)
    const results: Record<string, Awaited<ReturnType<typeof inspectElementCandidate>>> = {}
    for (const id of ['view1', 'del1']) {
      const box = (await page.locator(`#${id}`).boundingBox())!
      results[id] = await inspectElementCandidate({
        page,
        point: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        actionName: 'Tap',
      })
    }
    // 同一行两个不同操作：都不能只凭行锚点判 bound，且行锚点本身不冒充元素定位
    expect(results.view1!.status).toBe('unbound')
    expect(results.del1!.status).toBe('unbound')
    expect(results.view1!.candidates).toEqual([])
    expect(results.view1!.anchor?.withinText).toBe('SO-1001')
    expect(results.del1!.anchor?.withinText).toBe('SO-1001')
    await context.close()
  })

  it('AP03 派发失败在动作边补 failed 事件', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.setContent(html)
    const recorder = new ActionRecorder({
      page,
      attemptId: ATT,
      runId: RUN,
      stepRunId: STEP_RUN,
      agentInstanceId: 'agent-lab-fail',
      grant: fakeGrant(),
      db: {} as never,
    })
    appendSpy.mockClear()
    const boom = Object.assign(new Error('element detached'), { code: 'ACTION_DETACHED' })
    const wrapped = (formalAgentModule.wrapActionSpace as typeof import('../formal-agent.js').wrapActionSpace)(
      [{ name: 'Tap', call: async () => { throw boom } }],
      new ActionGate(),
      false,
      recorder,
    )
    await expect(wrapped[0]!.call({ locate: { center: [180, 120], description: '提交订单' } } as never)).rejects.toMatchObject({ code: 'ACTION_DETACHED' })
    const inputs = appendSpy.mock.calls.map((c) => c[0] as AppendAiTaskEventInput)
    const phases = inputs.map((e) => e.phase)
    expect(phases).toContain('prepared')
    const failed = inputs.find((e) => e.phase === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.errorCode).toBe('ACTION_DETACHED')
    recorder.destroy()
    await context.close()
  })
})
