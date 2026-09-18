import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  createRuntimeInvariant,
  type EvidenceMetadata,
  type OutcomeResultDto,
  type RunSnapshot,
} from '@cairn/shared'
import { OutcomeConditionList } from './outcome-axis'

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
