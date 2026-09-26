import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import type { EvidenceMetadata } from '@cairn/shared'
import { AiAttemptSummary } from './ai-evidence'

const call: EvidenceMetadata = {
  schemaVersion: 1,
  id: '99999999-9999-4999-8999-999999999999',
  runId: '44444444-4444-4444-8444-444444444444',
  stepRunId: '66666666-6666-4666-8666-666666666666',
  attemptId: '88888888-8888-4888-8888-888888888888',
  type: 'log',
  status: 'available',
  createdAt: '2026-09-13T02:00:09.000Z',
  payload: {
    schemaVersion: 1,
    kind: 'ai_call',
    n: 1,
    phase: 'completed',
    model: 'mock-model',
    startedAt: '2026-09-13T02:00:08.000Z',
    durationMs: 120,
    inputTokens: 10,
    outputTokens: 4,
  },
}

describe('AiAttemptSummary', () => {
  it('展示判断结果与模型用量', async () => {
    const screen = await render(
      <AiAttemptSummary output={{ passed: false, reason: '列表为空' }} evidence={[call]} />,
    )
    await expect.element(screen.getByText('判断 不成立 · 列表为空')).toBeInTheDocument()
    await expect.element(screen.getByText(/模型调用 #1 · mock-model · 120 ms · tokens 10\/4/)).toBeInTheDocument()
  })

  it('展示区分文本 ARIA 与视觉 Midscene 的路线标签', async () => {
    const ariaCall: EvidenceMetadata = {
      ...call,
      id: '11111111-1111-4111-8111-111111111111',
      payload: {
        ...(call.payload as any),
        route: 'aria_text',
        model: 'deepseek-chat',
      },
    }
    const visionCall: EvidenceMetadata = {
      ...call,
      id: '22222222-2222-4222-8222-222222222222',
      payload: {
        ...(call.payload as any),
        n: 2,
        route: 'vision',
        model: 'qwen-vl-max',
      },
    }
    const screen = await render(
      <AiAttemptSummary output={null} evidence={[ariaCall, visionCall]} />,
    )
    await expect.element(screen.getByText(/模型调用 #1 · \[文本 · ARIA\] · deepseek-chat/)).toBeInTheDocument()
    await expect.element(screen.getByText(/模型调用 #2 · \[视觉 · Midscene\] · qwen-vl-max/)).toBeInTheDocument()
  })

  it('展示语义树引用行与回退说明', async () => {
    const screen = await render(
      <AiAttemptSummary
        output={{
          passed: true,
          reason: '标题与按钮均存在',
          citations: ['- heading "采购工单" [level=1]', '- button "提交"'],
          fallbackReason: '视觉关键词回退',
        }}
        evidence={[]}
      />,
    )
    await expect.element(screen.getByText('判断 成立 · 标题与按钮均存在')).toBeInTheDocument()
    await expect.element(screen.getByText('语义树引用行 (Citations):')).toBeInTheDocument()
    await expect.element(screen.getByText('- heading "采购工单" [level=1]')).toBeInTheDocument()
    await expect.element(screen.getByText('- button "提交"')).toBeInTheDocument()
    await expect.element(screen.getByText('回退说明: 视觉关键词回退')).toBeInTheDocument()
  })
})
