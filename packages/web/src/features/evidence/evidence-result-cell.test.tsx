import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { EvidenceSearchItem } from '@cairn/shared'
import { EvidenceResultCell } from './evidence-result-cell'

const baseItem: EvidenceSearchItem = {
  evidence: {
    schemaVersion: 1,
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    type: 'screenshot',
    status: 'available',
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  targetId: '33333333-3333-4333-8333-333333333333',
  targetName: '目标甲',
  targetNameCurrent: '目标甲',
  targetDeleted: false,
  scenarioId: '44444444-4444-4444-8444-444444444444',
  scenarioName: '场景甲',
  scenarioNameCurrent: '场景甲',
  scenarioDeleted: false,
  scenarioVersionId: '55555555-5555-4555-8555-555555555555',
  scenarioVersionNo: 1,
  scenarioVersionKind: 'published',
  stepName: '登录',
  stepOrdinal: 0,
  attemptNo: 1,
  runStatus: 'SUCCEEDED',
  stepRunStatus: 'FAILED',
  attemptStatus: 'FAILED',
  outcomeStatus: 'PASS',
  runEvidenceStatus: 'COMPLETE',
  displayStatus: 'available',
  displayStatusLabel: '可查看',
  filterBuckets: ['available'],
  overlayProtected: false,
  retainUntil: '2026-09-26T00:00:00.000Z',
  retainUntilUnknown: false,
  byteSize: 12,
  byteSizeUnknown: false,
  errorSummary: null,
  objectLinked: true,
  reasonCode: null,
  reasonUnknown: false,
}

describe('EvidenceResultCell 语义化结果单元格', () => {
  it('重试成功场景：本步失败但运行重试成功，明确标出已重试成功而不是既成功又失败', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          runStatus: 'SUCCEEDED',
          attemptStatus: 'FAILED',
          hitKind: 'attempt_failed',
        }}
      />
    )
    await expect.element(screen.getByText('本步失败')).toBeInTheDocument()
    await expect.element(screen.getByText('已重试成功')).toBeInTheDocument()
  })

  it('执行失败场景：步骤与整次运行均失败，归并为执行失败，不出现多个重复的失败文本', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          runStatus: 'FAILED',
          attemptStatus: 'FAILED',
          hitKind: 'attempt_failed',
        }}
      />
    )
    await expect.element(screen.getByText('执行失败')).toBeInTheDocument()
    await expect.element(screen.getByText('整次运行失败')).toBeInTheDocument()
  })

  it('步骤通过但整次运行后续失败场景：清晰说明本步通过且后续步骤失败', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          runStatus: 'FAILED',
          attemptStatus: 'SUCCEEDED',
          hitKind: 'run_failed',
        }}
      />
    )
    await expect.element(screen.getByText('本步通过')).toBeInTheDocument()
    await expect.element(screen.getByText('后续步骤失败')).toBeInTheDocument()
  })

  it('正常通过场景：显示成功与本步通过', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          runStatus: 'SUCCEEDED',
          attemptStatus: 'SUCCEEDED',
        }}
      />
    )
    await expect.element(screen.getByText('成功')).toBeInTheDocument()
    await expect.element(screen.getByText('本步通过')).toBeInTheDocument()
  })

  it('运行级失败场景：步骤为空，显示运行失败与运行级异常', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          stepOrdinal: null,
          attemptNo: null,
          stepName: null,
          runStatus: 'FAILED',
          attemptStatus: null,
        }}
      />
    )
    await expect.element(screen.getByText('运行失败')).toBeInTheDocument()
    await expect.element(screen.getByText('运行级异常')).toBeInTheDocument()
  })

  it('取消场景：显示已取消与取消说明', async () => {
    const screen = await render(
      <EvidenceResultCell
        item={{
          ...baseItem,
          runStatus: 'CANCELLED',
          attemptStatus: 'CANCELLED',
        }}
      />
    )
    await expect.element(screen.getByText('已取消', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('运行已取消')).toBeInTheDocument()
  })
})
