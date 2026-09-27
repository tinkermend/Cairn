import { describe, expect, it } from 'vitest'
import {
  allSuiteMembers,
  effectiveSuiteStages,
  interpolateStageVariables,
  validateStageDependencies,
  suiteDocumentSchema,
  suiteStageSchema,
  signReportToken,
  verifyReportToken,
  buildWechatWorkCard,
  buildFeishuCard,
  buildDingTalkCard,
  type SuiteDocument,
  type SuiteStage,
  type SuiteSummaryBlock,
} from '../index.js'

describe('Suite Stages Schema & Orchestration Contracts', () => {
  const dummyScenarioId = 'a0000000-0000-4000-8000-000000000001'
  const dummyVersionId = 'a0000000-0000-4000-8000-000000000002'

  it('validates suiteStageSchema and parses stage definitions', () => {
    const stage: SuiteStage = {
      id: 'prep',
      name: '准备阶段',
      ordinal: 0,
      executionMode: 'sequential',
      maxConcurrency: 1,
      members: [
        {
          memberId: 'login',
          ordinal: 0,
          scenarioId: dummyScenarioId,
          scenarioVersionId: dummyVersionId,
          displayName: '统一登录',
          input: { username: 'admin' },
        },
      ],
    }
    const parsed = suiteStageSchema.parse(stage)
    expect(parsed.id).toBe('prep')
    expect(parsed.executionMode).toBe('sequential')
  })

  it('supports SuiteDocument with stages and provides backward-compatibility', () => {
    // 1. Backward compatibility: flat members without stages
    const flatDoc: SuiteDocument = {
      schemaVersion: 1,
      groups: [],
      stages: [],
      members: [
        {
          memberId: 'm1',
          ordinal: 0,
          scenarioId: dummyScenarioId,
          scenarioVersionId: dummyVersionId,
          input: {},
        },
      ],
      sharedInput: {},
      executionMode: 'parallel',
      maxConcurrency: 3,
      failurePolicy: 'continue',
      autoGenerateFinalReport: false,
    }
    expect(suiteDocumentSchema.parse(flatDoc)).toBeDefined()
    const effStages = effectiveSuiteStages(flatDoc)
    expect(effStages).toHaveLength(1)
    expect(effStages[0].id).toBe('default')
    expect(effStages[0].members).toHaveLength(1)
    expect(allSuiteMembers(flatDoc)).toHaveLength(1)

    // 2. Document with stages
    const stagedDoc: SuiteDocument = {
      schemaVersion: 1,
      groups: [],
      stages: [
        {
          id: 'stage-1',
          name: '阶段一',
          ordinal: 0,
          executionMode: 'sequential',
          maxConcurrency: 1,
          members: [
            {
              memberId: 's1_m1',
              ordinal: 0,
              scenarioId: dummyScenarioId,
              scenarioVersionId: dummyVersionId,
              input: {},
            },
          ],
        },
        {
          id: 'stage-2',
          name: '阶段二',
          ordinal: 1,
          executionMode: 'parallel',
          maxConcurrency: 5,
          members: [
            {
              memberId: 's2_m1',
              ordinal: 0,
              scenarioId: dummyScenarioId,
              scenarioVersionId: dummyVersionId,
              input: { prevResult: '${stage[stage-1].members[s1_m1].output.metrics.total}' },
            },
          ],
        },
      ],
      members: [],
      sharedInput: {},
      executionMode: 'parallel',
      maxConcurrency: 3,
      failurePolicy: 'continue',
      autoGenerateFinalReport: false,
    }
    expect(suiteDocumentSchema.parse(stagedDoc)).toBeDefined()
    expect(allSuiteMembers(stagedDoc)).toHaveLength(2)
    expect(effectiveSuiteStages(stagedDoc)).toHaveLength(2)
  })

  it('AC03: blocks intra-stage, forward, and non-existent stage variable references', () => {
    const invalidStages: SuiteStage[] = [
      {
        id: 'stage-1',
        name: '阶段一',
        ordinal: 0,
        executionMode: 'parallel',
        maxConcurrency: 2,
        members: [
          {
            memberId: 'm1',
            ordinal: 0,
            scenarioId: dummyScenarioId,
            scenarioVersionId: dummyVersionId,
            // Illegal: referencing m2 in the same stage (intra-stage deadlock risk)
            input: { ref: '${stage[stage-1].members[m2].output.metrics.token}' },
          },
          {
            memberId: 'm2',
            ordinal: 1,
            scenarioId: dummyScenarioId,
            scenarioVersionId: dummyVersionId,
            // Illegal: forward reference to stage-2
            input: { forward: '${stage[stage-2].members[m3].output.summary}' },
          },
        ],
      },
      {
        id: 'stage-2',
        name: '阶段二',
        ordinal: 1,
        executionMode: 'parallel',
        maxConcurrency: 2,
        members: [
          {
            memberId: 'm3',
            ordinal: 0,
            scenarioId: dummyScenarioId,
            scenarioVersionId: dummyVersionId,
            // Illegal: referencing non-existent stage
            input: { ghost: '${stage[ghost-stage].members[ghost-m].output.dataRow.id}' },
          },
        ],
      },
    ]

    const issues = validateStageDependencies(invalidStages)
    expect(issues.length).toBeGreaterThanOrEqual(3)

    const intraIssue = issues.find((i) => i.code === 'INTRA_STAGE_VARIABLE_FORBIDDEN')
    expect(intraIssue).toBeDefined()
    expect(intraIssue?.memberId).toBe('m1')

    const forwardIssue = issues.find((i) => i.code === 'FORWARD_STAGE_VARIABLE_FORBIDDEN')
    expect(forwardIssue).toBeDefined()
    expect(forwardIssue?.memberId).toBe('m2')

    const notFoundIssue = issues.find((i) => i.code === 'STAGE_NOT_FOUND')
    expect(notFoundIssue).toBeDefined()
    expect(notFoundIssue?.memberId).toBe('m3')
  })

  it('AC02: correctly interpolates stage variables from predecessor outputs', () => {
    const stageOutputs: Record<string, Record<string, any>> = {
      'stage-prep': {
        auth_member: {
          status: 'PASS',
          summary: '登录成功并获得令牌',
          metrics: {
            batch_id: 10892,
            is_healthy: true,
          },
          dataRow: {
            session_token: 'secret-token-xyz-123',
          },
        },
      },
    }

    const templateInput = {
      token: '${stage[stage-prep].members[auth_member].output.dataRow.session_token}',
      batchNumber: '${stage[stage-prep].members[auth_member].output.metrics.batch_id}',
      healthy: '${stage[stage-prep].members[auth_member].output.metrics.is_healthy}',
      urlWithToken: 'https://api.example.com/v1?token=${stage[stage-prep].members[auth_member].output.dataRow.session_token}',
      nested: {
        statusText: '前置状态: ${stage[stage-prep].members[auth_member].output.summary}',
      },
    }

    const resolved = interpolateStageVariables(templateInput, stageOutputs)
    // Exact match retains native types
    expect(resolved.token).toBe('secret-token-xyz-123')
    expect(resolved.batchNumber).toBe(10892)
    expect(resolved.healthy).toBe(true)
    // Embedded template string interpolates as string
    expect(resolved.urlWithToken).toBe('https://api.example.com/v1?token=secret-token-xyz-123')
    expect((resolved.nested as any).statusText).toBe('前置状态: 登录成功并获得令牌')
  })

  it('AC05: HMAC short-lived token signing, verification and tampering protection', async () => {
    const secret = 'test-secret-key-1234567890abcdef'
    const nowSec = Math.floor(Date.now() / 1000)
    const payload = {
      suiteRunId: 'a0000000-0000-4000-8000-000000000003',
      reportRevisionId: 'a0000000-0000-4000-8000-000000000004',
      exp: nowSec + 3600,
      scope: 'readonly_report' as const,
    }

    // 1. Sign and verify valid token
    const token = await signReportToken(payload, secret)
    const verified = await verifyReportToken(token, secret)
    expect(verified.suiteRunId).toBe(payload.suiteRunId)
    expect(verified.reportRevisionId).toBe(payload.reportRevisionId)

    // 2. Reject expired token
    const expiredToken = await signReportToken({ ...payload, exp: nowSec - 10 }, secret)
    await expect(verifyReportToken(expiredToken, secret)).rejects.toThrow('TOKEN_EXPIRED')

    // 3. Reject tampered token
    const [data, sig] = token.split('.')
    const tamperedData = Buffer.from(JSON.stringify({ ...payload, suiteRunId: 'a0000000-0000-4000-8000-000000000009' })).toString('base64url')
    const tamperedToken = `${tamperedData}.${sig}`
    await expect(verifyReportToken(tamperedToken, secret)).rejects.toThrow('INVALID_TOKEN_SIGNATURE')

    // 4. Reject invalid format
    await expect(verifyReportToken('invalid-token', secret)).rejects.toThrow('INVALID_TOKEN_FORMAT')
  })

  it('AC04: builds rich notification cards for WeChat Work, Feishu and DingTalk', () => {
    const summaryBlock: SuiteSummaryBlock = {
      type: 'suite_business_summary',
      healthScore: 59,
      healthGrade: 'POOR',
      totalCount: 10,
      normalCount: 9,
      warningCount: 0,
      anomalousCount: 1,
      skippedCount: 0,
      undeterminedCount: 0,
      wallClockMs: 135000,
      childDurationMs: 450000,
      savedPercent: 70,
      gridRows: [],
      aggregatedFindings: [
        {
          severity: 'HIGH',
          category: 'TIMEOUT',
          message: '发现 3 单超时未派发工单',
          memberId: 'm_dispatch',
          displayName: '订单履约中心',
        },
      ],
    }

    const viewUrl = 'https://cairn.example.com/public/reports/view?token=valid.token.sig'

    // 1. WeChat Work Markdown Card
    const wechatCard = buildWechatWorkCard({ summary: summaryBlock, suiteName: '生产环境日常系统巡检', viewUrl })
    expect(wechatCard.msgtype).toBe('markdown')
    expect(wechatCard.markdown.content).toContain('生产环境日常系统巡检')
    expect(wechatCard.markdown.content).toContain('订单履约中心')
    expect(wechatCard.markdown.content).toContain(viewUrl)

    // 2. Feishu Interactive Card
    const feishuCard = buildFeishuCard({ summary: summaryBlock, suiteName: '生产环境日常系统巡检', viewUrl })
    expect(feishuCard.msg_type).toBe('interactive')
    expect(feishuCard.card.header.title.content).toContain('生产环境日常系统巡检')
    expect(feishuCard.card.elements[0].text.content).toContain('59分（差）')
    expect(JSON.stringify(feishuCard.card)).toContain(viewUrl)

    // 3. DingTalk ActionCard
    const dingCard = buildDingTalkCard({ summary: summaryBlock, suiteName: '生产环境日常系统巡检', viewUrl })
    expect(dingCard.msgtype).toBe('actionCard')
    expect(dingCard.actionCard.singleURL).toBe(viewUrl)
    expect(dingCard.actionCard.text).toContain('订单履约中心')
  })

  it('未判定或空集的消息卡不宣称业务健康', () => {
    const base = {
      type: 'suite_business_summary' as const,
      healthScore: null,
      healthGrade: null,
      totalCount: 2,
      normalCount: 0,
      warningCount: 0,
      anomalousCount: 0,
      undeterminedCount: 2,
      skippedCount: 0,
      wallClockMs: 1000,
      childDurationMs: 1000,
      savedPercent: 0,
      gridRows: [],
      aggregatedFindings: [],
    } satisfies SuiteSummaryBlock
    const wechat = buildWechatWorkCard({ summary: base, suiteName: '旧巡检' })
    const feishu = buildFeishuCard({ summary: base, suiteName: '旧巡检' })
    const ding = buildDingTalkCard({ summary: base, suiteName: '旧巡检' })
    expect(wechat.markdown.content).toContain('未评分（业务结果未完整判定）')
    expect(feishu.card.header.template).toBe('blue')
    expect(feishu.card.elements[0].text.content).toContain('无法完整判断')
    expect(ding.actionCard.text).not.toContain('100分')
    const empty = buildWechatWorkCard({ summary: { ...base, totalCount: 0, undeterminedCount: 0 }, suiteName: '空集' })
    expect(empty.markdown.content).toContain('无可判定项目')
    expect(empty.markdown.content).not.toContain('全部通过')

    const mixed = { ...base, totalCount: 3, normalCount: 1, anomalousCount: 1, undeterminedCount: 1 }
    const mixedCards = [
      buildWechatWorkCard({ summary: mixed, suiteName: '混合巡检' }),
      buildFeishuCard({ summary: mixed, suiteName: '混合巡检' }),
      buildDingTalkCard({ summary: mixed, suiteName: '混合巡检' }),
    ]
    for (const card of mixedCards) {
      const serialized = JSON.stringify(card)
      expect(serialized).toContain('发现异常')
      expect(serialized).toContain('未评分')
      expect(serialized).not.toContain('100分')
      expect(serialized).not.toContain('UNDETERMINED')
    }

    // Worker 直接消费已排队的旧消息 payload；缺少新字段时按未核验显示。
    const { undeterminedCount: _removed, ...legacy } = { ...base, healthScore: 100, healthGrade: 'EXCELLENT' as const }
    const oldCard = buildWechatWorkCard({ summary: legacy as unknown as SuiteSummaryBlock, suiteName: '旧消息' })
    expect(oldCard.markdown.content).toContain('历史分类未核验')
    expect(oldCard.markdown.content).not.toContain('100分')
    expect(oldCard.markdown.content).not.toContain('✅')
  })
})
