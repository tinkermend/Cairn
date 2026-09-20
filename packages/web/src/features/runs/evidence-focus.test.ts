import { describe, expect, it } from 'vitest'
import type { RunDetailDto, RunEvidenceListResponse } from '@cairn/shared'
import { resolveRunEvidenceFocus } from './evidence-focus'

const run = {
  id: '44444444-4444-4444-8444-444444444444',
  stepRuns: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      attempts: [{ id: '77777777-7777-4777-8777-777777777777' }],
    },
  ],
} as RunDetailDto

const evidence: RunEvidenceListResponse['items'] = [
  {
    schemaVersion: 1,
    id: '88888888-8888-4888-8888-888888888888',
    runId: run.id,
    stepRunId: '66666666-6666-4666-8666-666666666666',
    attemptId: '77777777-7777-4777-8777-777777777777',
    type: 'screenshot',
    status: 'available',
    createdAt: '2026-09-19T00:00:00.000Z',
  },
]

describe('resolveRunEvidenceFocus', () => {
  it('证据、步骤与尝试必须属于同一来源', () => {
    expect(
      resolveRunEvidenceFocus(run, evidence, {
        evidenceId: '88888888-8888-4888-8888-888888888888',
        stepRunId: '66666666-6666-4666-8666-666666666666',
      }),
    ).toMatchObject({ mismatch: false, evidenceId: evidence[0]?.id })
    expect(
      resolveRunEvidenceFocus(run, evidence, {
        evidenceId: '88888888-8888-4888-8888-888888888888',
        stepRunId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toEqual({ mismatch: true })
    expect(
      resolveRunEvidenceFocus(run, evidence, { evidenceId: '00000000-0000-4000-8000-000000000000' }),
    ).toEqual({ mismatch: true })
  })
})
