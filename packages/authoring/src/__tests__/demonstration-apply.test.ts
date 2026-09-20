import { describe, expect, it } from 'vitest'
import { type ApplyDemonstrationBody, type ScenarioAuthoringDocumentV2, type Step } from '@cairn/shared'
import { parseDemonstrationFile } from '../demonstration-adapters.js'
import { applyDemonstrationToDocument, previewDemonstration } from '../demonstration.js'
import { classifyValidationSample, validationRunDigests } from '../validation.js'

const id = '00000000-0000-4000-8000-000000000001'
const stepId = '00000000-0000-4000-8000-000000000002'
function fixture() {
  const source = parseDemonstrationFile({ targetId: id, captureId: id, profile: 'midscene-yaml-flow@1', text: 'web: {url: https://example.test}\ntasks:\n- name: 查询\n  flow:\n  - aiTap: 查询\n  - aiAssert: 已显示结果' })
  const preview = previewDemonstration({ source, scenarioId: id, recordingDraftId: id, baseRevision: 1, placement: { kind: 'replace', nodeId: stepId }, remainingCapacity: 199 })
  const body: ApplyDemonstrationBody = { ...preview, idempotencyKey: 'apply-test', decisions: preview.suggestions.map((s, i) => i === 0 ? { id: s.id, disposition: 'discard', reason: '沿用当前页面' } : { id: s.id, disposition: 'accept' }) }
  // API inputs are strict and exclude response metadata.
  delete (body as unknown as Record<string, unknown>).scenarioId
  delete (body as unknown as Record<string, unknown>).targetId
  for (const key of ['importProfile', 'suggestions', 'remainingCapacity']) delete (body as unknown as Record<string, unknown>)[key]
  const document: ScenarioAuthoringDocumentV2 = { authoringSchemaVersion: 2, schemaVersion: 1, inputs: [], nodes: [{ kind: 'step', step: { id: stepId, name: '原步骤', type: 'click', effectType: 'SIDE_EFFECT', input: { target: { framePath: [], candidates: [{ by: 'text', value: '查询' }] } }, policy: { retryLimit: 0 } } }] }
  return { preview, body, document }
}

describe('demonstration decisions and conservative validation', () => {
  it('reteaches one action while retaining identity, policy, references and ordered outcomes', () => {
    const { document, body, preview } = fixture()
    const result = applyDemonstrationToDocument(document, preview, body)
    expect(result.document.nodes).toHaveLength(1)
    expect(result.document.nodes[0]).toMatchObject({ step: { id: stepId, name: '原步骤', type: 'ai_action', policy: { retryLimit: 0 } }, outcomes: [{ provenance: 'imported', severity: 'MUST' }] })
    expect(document.nodes[0]).toMatchObject({ step: { type: 'click' } })
  })
  it('rejects missing/duplicate decisions, dangling assertion location and incompatible outputs', () => {
    const { document, body, preview } = fixture()
    expect(() => applyDemonstrationToDocument(document, preview, { ...body, decisions: body.decisions.slice(1) })).toThrow()
    expect(() => applyDemonstrationToDocument(document, preview, { ...body, decisions: [body.decisions[0]!, body.decisions[0]!, body.decisions[2]!] })).toThrow()
    expect(() => applyDemonstrationToDocument(document, preview, { ...body, decisions: body.decisions.map((d, i) => i === 1 ? { id: d.id, disposition: 'discard', reason: '不执行' } : d) })).toThrow(/前序/)
    document.nodes[0] = { kind: 'step', step: { id: stepId, name: '读值', type: 'echo', effectType: 'READ_ONLY', outputKey: 'result', input: { value: 'a' } } as Step }
    expect(() => applyDemonstrationToDocument(document, preview, body)).toThrow(/输出/)
  })
  const passed = { matchesSubject: true, hasContext: true, status: 'SUCCEEDED', outcomeStatus: 'PASS', evidenceStatus: 'COMPLETE', fullyExecuted: true, interventions: [], requiredConditions: 1, conditionStatuses: ['PASS'] }
  it('only passes complete matching business samples', () => {
    expect(classifyValidationSample(passed).state).toBe('sample_passed')
    for (const patch of [{ requiredConditions: 0 }, { fullyExecuted: false }, { interventions: ['debug_overlay'] }, { evidenceStatus: 'PENDING' }, { evidenceStatus: 'INCOMPLETE' }, { conditionStatuses: ['UNKNOWN'] }, { conditionStatuses: ['PASS', 'WARN'] }, { status: 'CANCELLED' }, { hasContext: false }]) expect(classifyValidationSample({ ...passed, ...patch }).state).toBe('inconclusive')
    expect(classifyValidationSample({ ...passed, matchesSubject: false }).state).toBe('stale')
    expect(classifyValidationSample({ ...passed, status: 'RUNNING' }).state).toBe('running')
    expect(classifyValidationSample({ ...passed, conditionStatuses: ['FAIL'] }).state).toBe('failed')
  })
  it('keeps inputs separate from immutable execution scope, excluding credentials from input digests', () => {
    const snapshot = { schemaVersion: 1, runId: id, targetId: id, scenarioId: id, scenarioVersionId: id, steps: [], input: { query: 'a', password: 'one' }, policy: { retryLimit: 0, timeoutMs: 1000 }, createdAt: '2026-09-19T00:00:00.000Z' } as Parameters<typeof validationRunDigests>[0]
    const original = validationRunDigests(snapshot)
    expect(validationRunDigests({ ...snapshot, input: { query: 'a', password: 'two' } })).toEqual(original)
    const changed = validationRunDigests({ ...snapshot, input: { query: 'b' } })
    expect(changed.executionScopeDigest).toBe(original.executionScopeDigest)
    expect(changed.inputDigest).not.toBe(original.inputDigest)
    expect(validationRunDigests({ ...snapshot, targetAccountId: stepId }).executionScopeDigest).not.toBe(original.executionScopeDigest)
  })
})
