import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  createRuntimeInvariant,
  type EvidenceMetadata,
  type OutcomeResultDto,
  type RunSnapshot,
} from '@cairn/shared'
import { OutcomeAxisSummary, OutcomeConditionList } from './outcome-axis'

const invariant = createRuntimeInvariant('auth_validity', '00000000-0000-4000-8000-000000000001')

const snapshot = {
  runtimeInvariantManifest: { entries: [invariant] },
} as RunSnapshot

const failRow: OutcomeResultDto = {
  id: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
  stepRunId: '00000000-0000-4000-8000-000000000004',
  attemptId: '00000000-0000-4000-8000-000000000005',
  contractId: invariant.id,
  scope: 'scenario',
  meaning: invariant.meaning,
  severity: invariant.severity,
  onViolation: invariant.onViolation,
  provenance: 'runtime_invariant',
  verdict: 'FAIL',
  expected: { kind: 'auth_validity', status: 'authenticated' },
  actual: { status: 'recovered' },
  evaluatedAt: '2026-09-17T00:00:00.000Z',
}

describe('OutcomeConditionList 运行期约束', () => {
  it('与成功条件分列，并展示 Expected / Actual', async () => {
    const screen = await render(
      <OutcomeConditionList runId={failRow.runId} run={{ snapshot, outcomeResults: [failRow] }} />,
    )
    await expect.element(screen.getByRole('list', { name: '运行期约束判定' })).toBeInTheDocument()
    expect(screen.container.textContent).toMatch(/运行期间登录保持有效/)
    expect(screen.container.textContent).toMatch(/期望/)
    expect(screen.container.textContent).toMatch(/实际/)
    expect(screen.container.textContent).toMatch(/recovered/)
    expect(screen.container.textContent).not.toMatch(/"kind":"auth_validity"/)
  })

  it('结果行无 evidenceId 时回退 Attempt 截图', async () => {
    const screenshot: EvidenceMetadata = {
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000010',
      runId: failRow.runId,
      stepRunId: failRow.stepRunId,
      attemptId: failRow.attemptId,
      type: 'screenshot',
      status: 'missing',
      createdAt: '2026-09-17T00:00:00.000Z',
      missingReason: 'capture_failed',
    }
    const screen = await render(
      <OutcomeConditionList
        runId={failRow.runId}
        run={{ snapshot, outcomeResults: [failRow] }}
        evidenceItems={[screenshot]}
      />,
    )
    expect(screen.container.textContent).toMatch(/截图/)
  })
})

describe('OutcomeConditionList 成功条件', () => {
  it('期望展示对象存在而不是 JSON', async () => {
    const contractId = '00000000-0000-4000-8000-000000000021'
    const screen = await render(
      <OutcomeConditionList
        runId='00000000-0000-4000-8000-000000000022'
        run={{
          snapshot: {
            outcomeManifest: {
              entries: [
                {
                  contractId,
                  scope: 'step',
                  meaning: '内存使用率有数据',
                  severity: 'MUST',
                  onViolation: 'halt',
                  provenance: 'manual',
                  stepId: '00000000-0000-4000-8000-000000000023',
                  rule: { kind: 'deterministic', expect: { kind: 'exists' } },
                },
              ],
            },
          } as RunSnapshot,
          outcomeResults: [],
        }}
      />,
    )
    expect(screen.container.textContent).toMatch(/内存使用率有数据/)
    expect(screen.container.textContent).toMatch(/对象存在/)
    expect(screen.container.textContent).not.toMatch(/"kind":"exists"/)
  })
})

describe('OutcomeAxisSummary', () => {
  it('有成功条件且未评价时说还没评完，而不是没有条件', async () => {
    const screen = await render(
      <OutcomeAxisSummary executionLabel='执行挂起' outcomeStatus='NOT_EVALUATED' hasContracts />,
    )
    expect(screen.container.textContent).toMatch(/业务条件还没评完/)
    expect(screen.container.textContent).not.toMatch(/这次运行没有成功条件/)
  })

  it('确实没有成功条件时仍说这次没有成功条件', async () => {
    const screen = await render(
      <OutcomeAxisSummary executionLabel='执行完成' outcomeStatus='NOT_EVALUATED' hasContracts={false} />,
    )
    expect(screen.container.textContent).toMatch(/这次运行没有成功条件/)
    expect(screen.container.textContent).not.toMatch(/还没评完/)
  })
})
