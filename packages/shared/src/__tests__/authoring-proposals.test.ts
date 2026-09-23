import { describe, it, expect } from 'vitest'
import {
  authoringEditProposalSchema,
  outcomeAssistProposalSchema,
  demonstrationSemanticProposalSchema,
  datasetProfileSchema,
  dataMappingProposalSchema,
  SYNC_PREFLIGHT_MAX_ROWS,
  applyDemonstrationBodySchema,
} from '../index.js'

describe('Authoring proposals schemas (AI-03 Phase 1)', () => {
  it('validates C1 AuthoringEditProposal with module and step nodes', () => {
    const proposal = {
      proposalId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '22222222-2222-4222-8222-222222222222',
      expectedDraftRevision: 3,
      diffSummary: '新增登录模块与查询步骤',
      nodes: [
        {
          kind: 'module',
          invocationId: '33333333-3333-4333-8333-333333333333',
          moduleId: '44444444-4444-4444-8444-444444444444',
          implementationKey: 'default',
          inputBindings: {},
          outputBindings: {},
        },
        {
          kind: 'step',
          step: {
            id: '55555555-5555-4555-8555-555555555555',
            name: '点击搜索',
            type: 'click',
            effectType: 'READ_ONLY',
            input: {
              target: {
                candidates: [{ by: 'css', value: '#search' }],
              },
            },
          },
        },
      ],
      missingSlots: [
        { key: 'password', label: '登录密码', reason: '需要用户在环境变量中配置' },
      ],
      diagnostics: [],
      proposalDigest: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
    }
    const parsed = authoringEditProposalSchema.parse(proposal)
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.missingSlots[0].key).toBe('password')
  })

  it('validates C2 OutcomeAssistProposal', () => {
    const proposal = {
      proposalId: '11111111-1111-4111-8111-111111111112',
      businessIntent: '核对回执订单号与金额',
      candidateOutcomes: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          scope: 'scenario',
          meaning: '回执单号展示',
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'manual',
          rule: {
            kind: 'deterministic',
            target: {
              candidates: [{ by: 'text', value: '订单处理成功' }],
            },
            expect: { kind: 'visible' },
          },
        },
      ],
      candidateOutputs: [
        {
          summaryTemplate: '巡检完成，处理订单 ${order_count} 笔',
          metrics: [
            {
              key: 'order_count',
              name: '订单数',
              fromContextKey: 'orderCount',
              unit: '笔',
            },
          ],
          dataRowFields: [],
        },
      ],
      uncoveredRequirements: ['需人工确认退款容差'],
      unsupportedRequirements: [],
      proposalDigest: 'b'.repeat(64),
      createdAt: new Date().toISOString(),
    }
    const parsed = outcomeAssistProposalSchema.parse(proposal)
    expect(parsed.candidateOutcomes).toHaveLength(1)
    expect(parsed.candidateOutputs).toHaveLength(1)
  })

  it('validates C3 DemonstrationSemanticProposal and applyDemonstrationBody with modelProposalDigest', () => {
    const proposal = {
      recordingDraftId: '11111111-1111-4111-8111-111111111113',
      factDigest: 'c'.repeat(64),
      modelProposalDigest: 'd'.repeat(64),
      businessGroups: [
        {
          groupId: 'grp-login',
          title: '系统登录',
          effectType: 'READ_ONLY',
          sourceIds: ['act-1', 'act-2'],
        },
      ],
      sourceMap: [
        { sourceId: 'act-1', groupId: 'grp-login', disposition: 'accept' },
        { sourceId: 'act-2', groupId: 'grp-login', disposition: 'accept' },
      ],
      paramCandidates: [
        { sourceId: 'act-2', name: 'username', type: 'string', sampleValue: 'admin' },
      ],
      unknownActions: [],
      createdAt: new Date().toISOString(),
    }
    const parsed = demonstrationSemanticProposalSchema.parse(proposal)
    expect(parsed.businessGroups[0].sourceIds).toEqual(['act-1', 'act-2'])

    // applyDemonstrationBody with modelProposalDigest
    const applyBody = {
      protocolVersion: 'demonstration@1',
      recordingDraftId: '11111111-1111-4111-8111-111111111113',
      idempotencyKey: '11111111-1111-4111-8111-111111111114',
      baseRevision: 1,
      placement: { kind: 'start' },
      factDigest: 'c'.repeat(64),
      suggestionDigest: 'e'.repeat(64),
      modelProposalDigest: 'd'.repeat(64),
      adapterVersion: 'demonstration-adapters@1',
      ruleVersion: 'demonstration-rules@1',
      decisions: [
        { id: 'act-1', disposition: 'accept' },
      ],
    }
    const parsedApply = applyDemonstrationBodySchema.parse(applyBody)
    expect(parsedApply.modelProposalDigest).toBe('d'.repeat(64))
  })

  it('validates C4.1 DatasetProfile and DataMappingProposal', () => {
    expect(SYNC_PREFLIGHT_MAX_ROWS).toBe(2000)

    const profile = {
      datasetId: '11111111-1111-4111-8111-111111111115',
      totalRows: 1500,
      analyzedRows: 1500,
      isSampled: false,
      columns: [
        {
          name: 'order_id',
          inferredType: 'string',
          nullCount: 0,
          nullRate: 0,
          distinctCount: 1500,
          minLength: 10,
          maxLength: 10,
          sampleAnomalies: [],
        },
      ],
      algorithmVersion: 'dataset-profiler@1',
      createdAt: new Date().toISOString(),
    }
    const parsedProfile = datasetProfileSchema.parse(profile)
    expect(parsedProfile.columns[0].inferredType).toBe('string')

    const mapping = {
      datasetId: '11111111-1111-4111-8111-111111111115',
      binding: {
        orderId: { source: 'column', columnName: 'order_id' },
      },
      unresolvedInputs: [],
      confidence: 0.95,
      sampleEvaluations: [
        { rowIndex: 0, values: { orderId: 'ORD1234567' } },
      ],
      createdAt: new Date().toISOString(),
    }
    const parsedMapping = dataMappingProposalSchema.parse(mapping)
    expect(parsedMapping.confidence).toBe(0.95)
  })
})
