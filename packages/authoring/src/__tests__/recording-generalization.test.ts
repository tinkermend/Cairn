import { describe, expect, it } from 'vitest'
import { parseDemonstrationFile } from '../demonstration-adapters.js'
import { foldRecordingGeneralization } from '../recording-generalization.js'
import { generateQuickActionRound } from '../recording-rules.js'

const targetId = '00000000-0000-4000-8000-000000000001'
const captureId = '00000000-0000-4000-8000-000000000002'
const recordingDraftId = '00000000-0000-4000-8000-000000000003'
const roundCleanLoginId = '00000000-0000-4000-8000-000000000010'
const roundCleanMisfiresId = '00000000-0000-4000-8000-000000000020'
const roundParamId = '00000000-0000-4000-8000-000000000030'
const roundRelaxId = '00000000-0000-4000-8000-000000000040'
const roundOutcomeId = '00000000-0000-4000-8000-000000000050'

function createSampleSource() {
  const json = JSON.stringify([
    { type: 'navigation', url: 'https://example.test/login', timestamp: 1000, hashId: 'n1', pageInfo: { width: 1200, height: 800 } },
    { type: 'input', elementDescription: 'username', value: 'admin', hashId: 'i1', timestamp: 2000, pageInfo: { width: 1200, height: 800 } },
    { type: 'input', elementDescription: 'password', value: 'secret123', hashId: 'i2', timestamp: 3000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '登录', hashId: 'c1', timestamp: 4000, pageInfo: { width: 1200, height: 800 } },
    { type: 'navigation', actionType: 'NavigationChanged', url: 'https://example.test/orders', hashId: 'n2', timestamp: 5000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '查询', hashId: 'c2', timestamp: 6000, pageInfo: { width: 1200, height: 800 } },
    { type: 'click', elementDescription: '查询', hashId: 'c3', timestamp: 6300, pageInfo: { width: 1200, height: 800 } },
  ])
  return parseDemonstrationFile({ text: json, profile: 'midscene-recorder-json@1', targetId, captureId })
}

describe('recording generalization engine', () => {
  it('folds recording demonstration into deterministic candidate document', () => {
    const source = createSampleSource()
    const res1 = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(res1.ok).toBe(true)
    if (!res1.ok) return

    const res2 = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(res2.ok).toBe(true)
    if (!res2.ok) return

    // 确定性 Digest 严格一致
    expect(res1.candidateDigest).toBe(res2.candidateDigest)
    expect(res1.document.nodes.length).toBeGreaterThan(0)
  })

  it('generates clean_login rule round to strip login sequence when target has auth', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanLoginId,
      action: 'clean_login',
      source,
      currentDocument: baseFold.document,
      targetHasAuth: true,
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.operations.length).toBeGreaterThan(0)
    expect(roundRes.round.operations.every((op) => op.kind === 'remove_step')).toBe(true)
  })

  it('refuses clean_login when target does not have auth configured', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanLoginId,
      action: 'clean_login',
      source,
      currentDocument: baseFold.document,
      targetHasAuth: false,
    })

    expect(roundRes.ok).toBe(false)
    if (!roundRes.ok) {
      expect(roundRes.error.code).toBe('AUTH_NOT_CONFIGURED')
    }
  })

  it('generates clean_misfires rule round for rapid consecutive clicks on same target', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundCleanMisfiresId,
      action: 'clean_misfires',
      source,
      currentDocument: baseFold.document,
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.operations.length).toBe(1)
    expect(roundRes.round.operations[0].kind).toBe('remove_step')
  })

  it('generates parameterize rule round with dataset column sample matching', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const roundRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundParamId,
      action: 'parameterize',
      source,
      currentDocument: baseFold.document,
      targetDatasets: [
        {
          id: 'ds-user',
          name: '用户数据集',
          schema: [
            {
              key: 'username',
              name: '登录账号',
              type: 'string',
              sampleValues: ['admin', 'guest'],
            },
          ],
        },
      ],
    })

    expect(roundRes.ok).toBe(true)
    if (!roundRes.ok) return

    expect(roundRes.round.decisionPatches.length).toBe(1)
    expect(roundRes.round.decisionPatches[0].parameter?.key).toBe('username')
    expect(roundRes.round.decisionPatches[0].parameter?.label).toBe('登录账号')
  })

  it('generates relax_timeout and expect_outcome quick action rounds', () => {
    const source = createSampleSource()
    const baseFold = foldRecordingGeneralization({
      source,
      recordingDraftId,
      baseDecisions: [],
      rounds: [],
    })
    expect(baseFold.ok).toBe(true)
    if (!baseFold.ok) return

    const relaxRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundRelaxId,
      action: 'relax_timeout',
      source,
      currentDocument: baseFold.document,
    })
    expect(relaxRes.ok).toBe(true)
    if (relaxRes.ok) {
      expect(relaxRes.round.operations[0].kind).toBe('set_step_policy')
    }

    const outcomeRes = generateQuickActionRound({
      recordingDraftId,
      roundId: roundOutcomeId,
      action: 'expect_outcome',
      source,
      currentDocument: baseFold.document,
    })
    expect(outcomeRes.ok).toBe(true)
    if (outcomeRes.ok) {
      expect(outcomeRes.round.operations[0].kind).toBe('add_outcome')
    }
  })
})
