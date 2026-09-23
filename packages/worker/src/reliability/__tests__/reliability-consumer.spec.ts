import { beforeEach, describe, expect, it, vi } from 'vitest'
import { processReliabilityIncrement } from '../reliability.consumer.js'
import type { Database } from '@cairn/db'

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  loadData: vi.fn(),
  writeEval: vi.fn(),
  reconcile: vi.fn(),
}))

vi.mock('@cairn/db', () => ({
  claimReliabilityEvaluation: mocks.claim,
  loadReliabilityIncrementalData: mocks.loadData,
  writeReliabilityEvaluation: mocks.writeEval,
  reconcileHangingIncidents: mocks.reconcile,
}))

describe('Reliability Consumer (RISA01~RISA08)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips processing when slot cannot be claimed', async () => {
    mocks.claim.mockResolvedValueOnce(null)

    const result = await processReliabilityIncrement({} as Database, {
      workerId: 'worker-1',
      targetId: 't-1',
    })

    expect(result.processed).toBe(false)
    expect(mocks.loadData).not.toHaveBeenCalled()
    expect(mocks.writeEval).not.toHaveBeenCalled()
  })

  it('consumes incremental runs, computes metrics, and writes atomic evaluation', async () => {
    const targetId = 'target-test-1'
    mocks.claim.mockResolvedValueOnce({
      targetId,
      watermarkVector: { runCompletedSeq: 50, mapCommittedSeq: 0, validationSeq: 0 },
      fencingToken: 1,
      leaseOwner: 'worker-1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })

    const runCreatedAt = new Date()
    mocks.loadData.mockResolvedValueOnce({
      maxEventSeq: 75,
      runRows: [
        {
          id: 'run-1',
          eventSeq: 60,
          targetAccountId: 'acc-1',
          scenarioId: 'sc-1',
          scenarioVersionId: 'scv-1',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          createdAt: runCreatedAt,
        },
        {
          id: 'run-2',
          eventSeq: 75,
          targetAccountId: 'acc-1',
          scenarioId: 'sc-1',
          scenarioVersionId: 'scv-1',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          createdAt: runCreatedAt,
        },
      ],
      stepRows: [
        // Step 1: Success primary hit
        {
          stepRunId: 'sr-1',
          runId: 'run-1',
          name: 'Step 1',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          startedAt: new Date(1000),
          finishedAt: new Date(1100), // 100ms
          attemptId: 'att-1',
          attemptNo: 1,
          attemptStatus: 'SUCCEEDED',
          attemptError: null,
          decisionKind: 'primary_hit',
          reasonCode: null,
        },
        // Step 2: Fallback hit
        {
          stepRunId: 'sr-2',
          runId: 'run-1',
          name: 'Step 2',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          startedAt: new Date(2000),
          finishedAt: new Date(2250), // 250ms
          attemptId: 'att-2',
          attemptNo: 1,
          attemptStatus: 'SUCCEEDED',
          attemptError: null,
          decisionKind: 'map_fallback',
          reasonCode: 'map_fallback_used',
        },
        // Step 3: Failed with retry
        {
          stepRunId: 'sr-3',
          runId: 'run-2',
          name: 'Step 3',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          startedAt: new Date(3000),
          finishedAt: new Date(3200),
          attemptId: 'att-3',
          attemptNo: 1,
          attemptStatus: 'FAILED',
          attemptError: { message: 'Element not found' },
          decisionKind: null,
          reasonCode: null,
        },
        {
          stepRunId: 'sr-3',
          runId: 'run-2',
          name: 'Step 3',
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          startedAt: new Date(3200),
          finishedAt: new Date(3500),
          attemptId: 'att-4',
          attemptNo: 2,
          attemptStatus: 'FAILED',
          attemptError: { message: 'Element not found' },
          decisionKind: null,
          reasonCode: null,
        },
      ],
    })

    mocks.writeEval.mockResolvedValueOnce({ id: 'eval-1' })
    mocks.reconcile.mockResolvedValueOnce({ reconciledCount: 0 })

    const result = await processReliabilityIncrement({} as Database, {
      workerId: 'worker-1',
      targetId,
    })

    expect(result.processed).toBe(true)
    expect(result.targetId).toBe(targetId)
    expect(result.sampleCount).toBe(3)

    // Verify writeReliabilityEvaluation was called with advanced watermark
    expect(mocks.writeEval).toHaveBeenCalledOnce()
    const writeArg = mocks.writeEval.mock.calls[0]![1]

    expect(writeArg.targetId).toBe(targetId)
    expect(writeArg.watermarkVector.runCompletedSeq).toBe(75)
    expect(writeArg.featureWindows.length).toBe(1)

    // Only anomalous steps (fallback or failed) produce sparse signals
    expect(writeArg.sparseSignals.length).toBe(2) // sr-2 (fallback) and sr-3 (failed with retry)
    const kinds = writeArg.sparseSignals.map((s: any) => s.kind)
    expect(kinds).toContain('resolution_fallback')
    expect(kinds).toContain('resolution_drift')

    // Incidents clustered by groupingKey
    expect(writeArg.incidents.length).toBeGreaterThanOrEqual(1)
    expect(writeArg.incidents[0].groupingKey).toBeDefined()
    expect(writeArg.incidents[0].status).toBe('DETECTED')

    // Reconcile was called
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })
})
