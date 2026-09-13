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
})
