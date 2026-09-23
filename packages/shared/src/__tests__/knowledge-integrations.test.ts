import { describe, expect, it } from 'vitest'
import {
  scenarioInputsToJsonSchema,
  previewOccurrences,
  knowledgeInsightSchema,
  changeImpactSchema,
  insightReviewSchema,
  operationsQuestionSchema,
  operationsDiagnosisSchema,
  scheduleProposalSchema,
  operationsActionProposalSchema,
  externalToolDescriptorSchema,
  externalToolCallSchema,
  externalToolReceiptSchema,
  externalToolResultSchema,
  type ScenarioInputDecl,
} from '../index.js'

describe('AI-04 Knowledge Integrations & Contracts', () => {
  describe('D1: Knowledge Insight & Change Impact Contracts', () => {
    it('validates a structured KnowledgeInsight', () => {
      const insight = {
        insightId: '00000000-0000-4000-8000-000000000001',
        kind: 'failure_mode',
        title: '支付验证码二次弹窗阻断',
        claims: ['近期 40 次支付失败中，有 35 次出现图形验证码拦截', '现有规则未包含二次滑块处理'],
        sourceRefs: [
          { kind: 'run', id: '00000000-0000-4000-8000-000000000010', attemptId: '1' },
          { kind: 'run', id: '00000000-0000-4000-8000-000000000011', attemptId: '1' },
        ],
        applicability: {
          targetId: '00000000-0000-4000-8000-000000000002',
          scenarioVersionRef: 'v1.2.0',
          observedWindow: 'last_7_days',
        },
        unknowns: ['未在非工作时间采样验证'],
        suggestedAction: {
          actionType: 'create_knowledge_candidate',
          destination: { candidateKind: 'failure_mode' },
          payload: { autoRetry: false },
        },
      }
      const parsed = knowledgeInsightSchema.parse(insight)
      expect(parsed.kind).toBe('failure_mode')
      expect(parsed.claims).toHaveLength(2)
    })

    it('validates ChangeImpact schema', () => {
      const impact = {
        impactId: '00000000-0000-4000-8000-000000000003',
        fromRef: 'map@v1',
        toRef: 'map@v2',
        changedAssets: [
          { assetType: 'locator', assetId: 'btn-submit', changeType: 'modified' },
        ],
        confirmedRefs: ['scenario-order-create', 'scenario-order-pay'],
        possibleRefs: ['scenario-refund'],
        scanCoverage: {
          totalScanned: 15,
          gaps: ['3 个停用场景未扫描'],
        },
      }
      const parsed = changeImpactSchema.parse(impact)
      expect(parsed.confirmedRefs).toHaveLength(2)
      expect(parsed.scanCoverage.totalScanned).toBe(15)
    })

    it('validates InsightReview schema', () => {
      const review = {
        insightId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        decision: 'accept',
        destination: { candidateId: '00000000-0000-4000-8000-000000000005' },
        requestKey: 'req-review-001',
      }
      const parsed = insightReviewSchema.parse(review)
      expect(parsed.decision).toBe('accept')
    })
  })

  describe('D2: Operations Assistant & Schedule Proposals', () => {
    it('validates OperationsQuestion and OperationsDiagnosis', () => {
      const question = {
        kind: 'queue_backlog',
        scope: { targetId: '00000000-0000-4000-8000-000000000001' },
        window: '24h',
        referenceTime: new Date().toISOString(),
        requestKey: 'op-question-123',
      }
      expect(operationsQuestionSchema.parse(question).kind).toBe('queue_backlog')

      const diagnosis = {
        diagnosisId: '00000000-0000-4000-8000-000000000004',
        kind: 'queue_backlog',
        observations: ['当前队列中有 12 个任务等待 Worker 槽位', 'Worker-01 处于失联维护状态'],
        hypotheses: ['Worker 节点离线导致可用槽位不足 50%'],
        evidenceRefs: ['worker:worker-01:heartbeat_timeout'],
        missingChecks: ['尚未检查 Worker 物理宿主机负载'],
        suggestedActions: [
          { actionKey: 'schedule.pause', label: '暂停非关键任务调度', safe: true },
        ],
      }
      const parsedDiag = operationsDiagnosisSchema.parse(diagnosis)
      expect(parsedDiag.observations).toHaveLength(2)
    })

    it('validates ScheduleProposal with timezone and preview', () => {
      const proposal = {
        proposalId: '00000000-0000-4000-8000-000000000006',
        definition: { name: '每日早巡检' },
        baselineRevision: 1,
        ownerRefs: ['account-admin'],
        inputDigest: 'abcdef0123456789',
        timezone: 'Asia/Shanghai',
        preview: [
          '2026-09-24T02:00:00.000Z',
          '2026-09-25T02:00:00.000Z',
        ],
        unknowns: [],
      }
      const parsed = scheduleProposalSchema.parse(proposal)
      expect(parsed.timezone).toBe('Asia/Shanghai')
      expect(parsed.preview).toHaveLength(2)
    })

    it('enforces Action Allowlist on OperationsActionProposal', () => {
      const validAction = {
        proposalId: '00000000-0000-4000-8000-000000000007',
        actionKey: 'schedule.pause',
        resources: [
          { kind: 'schedule', id: '00000000-0000-4000-8000-000000000008', name: '夜间批量分析' },
        ],
        preconditions: ['调度当前处于 ACTIVE 状态'],
        expectedRevision: 2,
        impact: '将暂停后续定时触发，在途任务不受影响',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }
      expect(operationsActionProposalSchema.parse(validAction).actionKey).toBe('schedule.pause')

      // 验证非法动作（不在白名单内）被拒绝
      const invalidAction = {
        ...validAction,
        actionKey: 'run.cancel_batch', // 严禁批量撤销
      }
      expect(() => operationsActionProposalSchema.parse(invalidAction)).toThrow()

      // 验证多资源（批量操作）被拒绝
      const batchAction = {
        ...validAction,
        resources: [
          { kind: 'schedule', id: '00000000-0000-4000-8000-000000000008' },
          { kind: 'schedule', id: '00000000-0000-4000-8000-000000000009' },
        ],
      }
      expect(() => operationsActionProposalSchema.parse(batchAction)).toThrow()
    })

    it('pure function previewOccurrences deterministically computes future occurrences', () => {
      const fixedNow = new Date('2026-09-23T10:00:00.000Z')
      const occurrences = previewOccurrences({
        cronExpr: '0 2 * * 1-5', // 每个工作日凌晨 2:00 (Asia/Shanghai 为 UTC+8，即前一天 18:00 UTC)
        timezone: 'Asia/Shanghai',
        referenceTime: fixedNow,
        count: 5,
      })

      expect(occurrences).toHaveLength(5)
      for (const occ of occurrences) {
        expect(typeof occ).toBe('string')
        expect(new Date(occ).getTime()).toBeGreaterThan(fixedNow.getTime())
      }
    })
  })

  describe('D3: External Tool Descriptor & Gateway Pure Functions', () => {
    it('pure function scenarioInputsToJsonSchema converts scenario inputs to JSONSchema7', () => {
      const inputs: ScenarioInputDecl[] = [
        {
          key: 'orderId',
          label: '订单编号',
          type: 'string',
          required: true,
          description: '待查询的业务订单号',
        },
        {
          key: 'retryCount',
          label: '重试次数',
          type: 'number',
          required: false,
        },
        {
          key: 'isPriority',
          label: '是否加急',
          type: 'boolean',
        },
        {
          key: 'apiKey',
          label: '接口密钥',
          type: 'string',
          required: true,
        },
        {
          key: 'attachment',
          label: '证明文件',
          type: 'file',
        },
        {
          key: 'extraConfig',
          label: '附加配置',
          type: 'json',
        },
      ]

      const jsonSchema = scenarioInputsToJsonSchema(inputs) as any
      expect(jsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#')
      expect(jsonSchema.type).toBe('object')
      expect(jsonSchema.required).toEqual(['orderId', 'apiKey'])
      expect(jsonSchema.properties.orderId).toEqual({
        type: 'string',
        description: '待查询的业务订单号',
      })
      expect(jsonSchema.properties.retryCount).toEqual({
        type: 'number',
        description: '重试次数',
      })
      expect(jsonSchema.properties.isPriority).toEqual({
        type: 'boolean',
        description: '是否加急',
      })
      expect(jsonSchema.properties.apiKey).toEqual({
        type: 'string',
        format: 'password',
        description: '接口密钥',
      })
      expect(jsonSchema.properties.attachment).toEqual({
        type: 'string',
        format: 'uri',
        description: '证明文件',
      })
      expect(jsonSchema.properties.extraConfig).toEqual({
        type: 'object',
        description: '附加配置',
      })
      expect(jsonSchema.additionalProperties).toBe(false)
    })

    it('validates ExternalToolDescriptor and ExternalToolCall', () => {
      const descriptor = {
        key: 'scenario.order-sync',
        descriptorVersion: '1.0.0',
        scenarioVersionRef: 'scenario-001@v3',
        description: '同步指定订单状态至 ERP 系统',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }
      expect(externalToolDescriptorSchema.parse(descriptor).key).toBe('scenario.order-sync')

      const call = {
        key: 'scenario.order-sync',
        descriptorVersion: '1.0.0',
        arguments: { orderId: 'ORD-999' },
        targetAccountId: '00000000-0000-4000-8000-000000000020',
        requestKey: 'call-key-001',
        async: false,
      }
      expect(externalToolCallSchema.parse(call).arguments).toEqual({ orderId: 'ORD-999' })
    })

    it('validates ExternalToolReceipt and ExternalToolResult', () => {
      const receipt = {
        callId: '00000000-0000-4000-8000-000000000030',
        runId: '00000000-0000-4000-8000-000000000031',
        status: 'ACCEPTED',
        pollUrl: '/open/v1/runs/00000000-0000-4000-8000-000000000031',
        sseStreamUrl: '/open/v1/runs/00000000-0000-4000-8000-000000000031/events',
        createdAt: new Date().toISOString(),
      }
      expect(externalToolReceiptSchema.parse(receipt).status).toBe('ACCEPTED')

      const result = {
        callId: '00000000-0000-4000-8000-000000000030',
        runId: '00000000-0000-4000-8000-000000000031',
        statusRefs: { runId: '00000000-0000-4000-8000-000000000031' },
        executionStatus: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        evidenceStatus: 'COMPLETE',
        output: { syncCount: 1 },
        unknowns: [],
      }
      expect(externalToolResultSchema.parse(result).executionStatus).toBe('SUCCEEDED')
    })
  })
})
