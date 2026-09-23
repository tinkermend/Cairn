import { describe, expect, it, vi } from 'vitest'
import {
  type ScenarioDocument,
  type AssistantCitationKey,
  citationKey,
  matchAssistantCapabilities,
  clarifyAvailableCapabilities,
} from '@cairn/shared'
import { AssistantCapabilityRegistry } from './registry'
import {
  assembleRunCompareContext,
  buildAuthoringSlice,
  validateGrounding,
} from './context-assembler'
import { DIAGNOSIS_EVAL_SAMPLES, AUTHORING_EVAL_SAMPLES } from './eval/eval-fixtures'

describe('AI 基座与上下文工程基础测试 (AIF-01 ~ AIF-27)', () => {
  describe('AIF-01 & AIF-02: 注册表与启动完整性断言', () => {
    it('注册表加载现有 5 项能力与 run.compare 切片，共 6 项内置能力', () => {
      const registry = new AssistantCapabilityRegistry()
      const descriptors = registry.listDescriptors()
      expect(descriptors.length).toBeGreaterThanOrEqual(6)

      const ids = descriptors.map((d) => d.id)
      expect(ids).toContain('run.diagnose')
      expect(ids).toContain('run.compare')
      expect(ids).toContain('scenario.explain')
      expect(ids).toContain('scenario.propose-step')
      expect(ids).toContain('scenario.compose_with_knowledge')
      expect(ids).toContain('platform.guide')
    })

    it('AIF-02: 启动完整性断言：注册表构造时校验所有描述符完备性', () => {
      const registry = new AssistantCapabilityRegistry()
      // Calling assertIntegrity directly should succeed for valid builtins
      expect(() => registry.assertIntegrity()).not.toThrow()

      // Missing requiredPermissions throws
      expect(() => {
        registry.register({
          descriptor: {
            id: 'invalid.cap',
            version: '1.0.0',
            label: '无效能力',
            purpose: '测试',
            notApplicable: [],
            requiredPermissions: [], // empty permissions!
            inputSchemaRef: 'inputRef',
            outputSchemaRef: 'outputRef',
            contextProfileRef: 'ref',
            executionMode: 'single_turn',
            sideEffect: 'read_only',
            allowedTools: [],
            policyRef: 'policy',
            promptRef: null,
            validatorRefs: [],
            intentMatchers: [],
            slotBindings: [],
            requiredContextKeys: [],
          },
          handler: async () => ({ kind: 'unsupported', reasonCode: 'TEST', message: 'test' }),
        })
      }).toThrow(/requiredPermissions/)

      // Missing handler throws
      expect(() => {
        registry.register({
          descriptor: {
            id: 'no.handler',
            version: '1.0.0',
            label: '无处理器',
            purpose: '测试',
            notApplicable: [],
            requiredPermissions: ['ai:assist'],
            inputSchemaRef: 'inputRef',
            outputSchemaRef: 'outputRef',
            contextProfileRef: 'ref',
            executionMode: 'single_turn',
            sideEffect: 'read_only',
            allowedTools: [],
            policyRef: 'policy',
            promptRef: null,
            validatorRefs: [],
            intentMatchers: [],
            slotBindings: [],
            requiredContextKeys: [],
          },
          handler: null as any,
        })
      }).toThrow(/handler function/)

      // Duplicate registration throws
      expect(() => {
        registry.register({
          descriptor: {
            id: 'run.diagnose',
            version: '1.0.0', // duplicate of builtin
            label: '重复能力',
            purpose: '测试',
            notApplicable: [],
            requiredPermissions: ['ai:assist'],
            inputSchemaRef: 'inputRef',
            outputSchemaRef: 'outputRef',
            contextProfileRef: 'ref',
            executionMode: 'single_turn',
            sideEffect: 'read_only',
            allowedTools: [],
            policyRef: 'policy',
            promptRef: null,
            validatorRefs: [],
            intentMatchers: [],
            slotBindings: [],
            requiredContextKeys: [],
          },
          handler: async () => ({ kind: 'unsupported', reasonCode: 'TEST', message: 'test' }),
        })
      }).toThrow(/Duplicate capability registration/)
    })
  })

  describe('AIF-03: 新增只读 run.compare 能力切片', () => {
    it('对比两次 Run 的步骤、耗时与失败差异并生成结构化事实', async () => {
      const mockDb: any = {}
      const baseRunId = '11111111-1111-4111-8111-111111111111'
      const targetRunId = '22222222-2222-4222-8222-222222222222'

      const mockLoadObservation = async (_db: any, id: string) => {
        if (id === baseRunId) {
          return {
            eventSeq: 1,
            evidence: { items: [] },
            run: {
              id: baseRunId,
              scenarioId: 'sc-1',
              targetId: 'tgt-1',
              status: 'SUCCEEDED',
              evidenceStatus: 'COMPLETE',
              placement: { state: 'FINISHED' },
              stepRuns: [
                {
                  id: 'sr-1',
                  stepId: 'step-login',
                  name: '登录',
                  status: 'SUCCEEDED',
                  startedAt: '2026-09-20T10:00:00Z',
                  finishedAt: '2026-09-20T10:00:01Z', // 1000ms
                  attempts: [{ id: 'att-1', status: 'SUCCEEDED', finishedAt: '2026-09-20T10:00:01Z' }],
                },
                {
                  id: 'sr-2',
                  stepId: 'step-search',
                  name: '搜索商品',
                  status: 'SUCCEEDED',
                  startedAt: '2026-09-20T10:00:01Z',
                  finishedAt: '2026-09-20T10:00:02Z', // 1000ms
                  attempts: [{ id: 'att-2', status: 'SUCCEEDED', finishedAt: '2026-09-20T10:00:02Z' }],
                },
              ],
            },
          }
        } else {
          return {
            eventSeq: 2,
            evidence: { items: [] },
            run: {
              id: targetRunId,
              scenarioId: 'sc-1',
              targetId: 'tgt-1',
              status: 'FAILED',
              evidenceStatus: 'COMPLETE',
              placement: { state: 'FINISHED' },
              stepRuns: [
                {
                  id: 'sr-3',
                  stepId: 'step-login',
                  name: '登录',
                  status: 'SUCCEEDED',
                  startedAt: '2026-09-21T10:00:00Z',
                  finishedAt: '2026-09-21T10:00:04Z', // 4000ms (+3000ms slower)
                  attempts: [{ id: 'att-3', status: 'SUCCEEDED', finishedAt: '2026-09-21T10:00:04Z' }],
                },
                {
                  id: 'sr-4',
                  stepId: 'step-search',
                  name: '搜索商品',
                  status: 'FAILED', // failed!
                  startedAt: '2026-09-21T10:00:04Z',
                  finishedAt: '2026-09-21T10:00:05Z',
                  attempts: [
                    {
                      id: 'att-4',
                      status: 'FAILED',
                      error: { code: 'ELEMENT_NOT_FOUND', message: 'Element not found' },
                      finishedAt: '2026-09-21T10:00:05Z',
                    },
                  ],
                },
              ],
            },
          }
        }
      }

      // Mock the db function temporarily
      const dbModule = await import('@cairn/db')
      const spy = vi.spyOn(dbModule, 'loadRunObservation').mockImplementation(mockLoadObservation as any)

      try {
        const { pack } = await assembleRunCompareContext(mockDb, baseRunId, targetRunId)
        expect(pack.differences.length).toBe(2)

        const loginDiff = pack.differences.find((d) => d.stepId === 'step-login')
        expect(loginDiff?.durationDiffMs).toBe(3000)

        const searchDiff = pack.differences.find((d) => d.stepId === 'step-search')
        expect(searchDiff?.baseStatus).toBe('SUCCEEDED')
        expect(searchDiff?.targetStatus).toBe('FAILED')
        expect(searchDiff?.errorDiff).toContain('ELEMENT_NOT_FOUND')

        expect(pack.facts.some((f) => f.id.includes('step-search'))).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('AIF-11, AIF-16, AIF-17: 草稿切片提取、脱敏与硬限制预检', () => {
    const document: ScenarioDocument = {
      schemaVersion: 1,
      inputs: {},
      steps: [
        {
          id: 'step-open',
          name: '打开页面',
          type: 'open',
          input: { url: 'https://example.com' },
        },
        {
          id: 'step-extract-token',
          name: '提取凭据',
          type: 'extract',
          input: { selector: '#auth-token', variable: 'authToken' },
        },
        {
          id: 'step-fill-password',
          name: '输入密码',
          type: 'fill',
          input: {
            selector: '#password',
            value: 'SuperSecret1234!',
            sensitive: true,
            from: 'authToken',
          },
        },
        {
          id: 'step-unrelated',
          name: '无关步骤',
          type: 'click',
          input: { selector: '#footer-link' },
        },
      ],
    }

    it('AIF-11: 仅提取目标步骤及其直接上游依赖，剔除无关步骤', () => {
      const slice = buildAuthoringSlice(document, 'step-fill-password')
      const stepIds = slice.slicedDocument.steps.map((s) => s.id)

      expect(stepIds).toContain('step-fill-password')
      expect(stepIds).toContain('step-extract-token') // upstream dependency via 'from'
      expect(stepIds).not.toContain('step-unrelated') // pruned!
    })

    it('AIF-16: 敏感字段脱敏：密码等敏感值遮盖为 [REDACTED]', () => {
      const slice = buildAuthoringSlice(document, 'step-fill-password')
      const fillStep = slice.slicedDocument.steps.find((s) => s.id === 'step-fill-password')

      expect(slice.redactedFieldCount).toBeGreaterThan(0)
      expect((fillStep?.input as any).value).toBe('[REDACTED]')
      expect(JSON.stringify(slice.slicedDocument)).not.toContain('SuperSecret1234!')
    })

    it('AIF-17: 组装前硬限制预检：超过限制时在组装阶段直接拒绝并提示收窄', () => {
      // Set limit lower than the slice character length
      expect(() => {
        buildAuthoringSlice(document, 'step-fill-password', 50)
      }).toThrow(/超过大模型硬限制/)
    })
  })

  describe('AIF-15: Grounding 事实引用校验', () => {
    it('过滤虚假/未在事实包中引用的假设，保留真实验证的假设', () => {
      const validCitations: AssistantCitationKey[] = [
        citationKey('run', '11111111-1111-4111-8111-111111111111'),
        citationKey('step', '22222222-2222-4222-8222-222222222222'),
      ]

      const hypotheses = [
        {
          text: '按钮被遮挡导致点击超时',
          citations: [
            citationKey('run', '11111111-1111-4111-8111-111111111111'),
            citationKey('step', '22222222-2222-4222-8222-222222222222'),
          ],
        },
        {
          text: '编造的第三方接口超时',
          citations: [citationKey('step', '33333333-3333-4333-8333-333333333333') as AssistantCitationKey],
        },
        {
          text: '无引用假设',
          citations: [] as AssistantCitationKey[],
        },
      ]

      const { valid, invalid } = validateGrounding(hypotheses, validCitations)
      expect(valid.length).toBe(1)
      expect(valid[0]!.text).toBe('按钮被遮挡导致点击超时')
      expect(invalid.length).toBe(2)
    })
  })

  describe('AIF-19: 多能力同时命中时澄清歧义', () => {
    it('当问题同时命中诊断和功能导览时，返回 clarify 候选列表而不是臆测', () => {
      const ambiguousQuestion = '对比两次运行，分析本次失败原因'
      const matches = matchAssistantCapabilities(ambiguousQuestion)
      expect(matches.length).toBeGreaterThan(1)

      const clarify = clarifyAvailableCapabilities(matches)
      expect(clarify.type).toBe('clarify')
      expect(clarify.options?.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('AIF-20: 单能力提示词版本运行时独立回滚', () => {
    it('支持单独切换并回滚某个能力的提示词版本而不重启进程', () => {
      const registry = new AssistantCapabilityRegistry()
      const capId = 'run.diagnose'

      // Initially on v1
      expect(registry.get(capId)?.activePromptVersion).toBe('v1')

      // Update to v2
      registry.setPromptVersion(capId, 'v2')
      expect(registry.get(capId)?.activePromptVersion).toBe('v2')

      // Other capabilities remain unaffected
      expect(registry.get('run.compare')?.activePromptVersion).toBe('v1')

      // Rollback
      const rolledBack = registry.rollbackPromptVersion(capId)
      expect(rolledBack).toBe('v1')
      expect(registry.get(capId)?.activePromptVersion).toBe('v1')
    })
  })

  describe('AIF-14: 评测样本版本管理与 Holdout 隔离', () => {
    it('评测样本区分常规集与 Holdout 集', () => {
      const devSamples = DIAGNOSIS_EVAL_SAMPLES.filter((s) => !s.metadata.holdout)
      const holdoutSamples = DIAGNOSIS_EVAL_SAMPLES.filter((s) => s.metadata.holdout)

      expect(devSamples.length).toBeGreaterThan(0)
      expect(holdoutSamples.length).toBeGreaterThan(0)
      expect(holdoutSamples[0]!.id).toContain('holdout')
    })

    it('作者样本包含脱敏校验期望', () => {
      const redactionSample = AUTHORING_EVAL_SAMPLES.find((s) => s.id.includes('redaction'))
      expect(redactionSample).toBeDefined()
      expect(redactionSample?.expectedAssertions[0]?.value).toBe('[REDACTED]')
    })
  })

  describe('AIF-22 & AIF-24: 显式取消与状态流转', () => {
    it('显式取消端点终止活跃任务并落 CANCELLED 状态', async () => {
      const mockDb: any = {}
      const turnId = '33333333-3333-4333-8333-333333333333'
      const actorId = 'acc-1'

      const dbModule = await import('@cairn/db')
      const cancelSpy = vi.spyOn(dbModule, 'cancelAssistantTurn').mockResolvedValue({
        id: turnId,
        conversationId: 'conv-1',
        clientTurnId: 'turn-1',
        parentTurnId: null,
        question: '测试取消',
        capabilityId: 'run.diagnose',
        status: 'CANCELLED',
        deadlineAt: '2026-09-20T10:00:00Z',
        createdAt: '2026-09-20T10:00:00Z',
        updatedAt: '2026-09-20T10:00:00Z',
        eventSeq: 1,
      } as any)
      const eventSpy = vi.spyOn(dbModule, 'recordAssistantTurnEvent').mockResolvedValue(undefined as any)

      try {
        const { AssistantAsyncRunner } = await import('./async-runner.js')
        const mockHints: any = {
          namespace: 'test',
          publish: vi.fn(async () => {}),
        }
        const mockConfig: any = {
          get: async () => ({ document: { platformAi: {} } }),
          resolvePlatformAiAccess: async () => null,
        }
        const mockTargets: any = {}
        const registry = new AssistantCapabilityRegistry()

        const runner = new AssistantAsyncRunner(
          mockDb,
          mockHints,
          mockConfig,
          mockTargets,
          registry,
        )

        const cancelResult = await runner.cancel(turnId, actorId)
        expect(cancelResult.turnId).toBe(turnId)
        expect(cancelResult.state).toBe('CANCELLED')
        expect(cancelSpy).toHaveBeenCalledWith(mockDb, { turnId, ownerAccountId: actorId })
      } finally {
        cancelSpy.mockRestore()
        eventSpy.mockRestore()
      }
    })
  })

  describe('AIF-28: 深度上下文与 @Quote 引用事实装配', () => {
    it('assembleDiagnoseContext 正确消费 quote 并将其注入事实文本作为聚焦锚点', async () => {
      const mockDb: any = {}
      const runId = '11111111-1111-4111-8111-111111111111'
      const dbModule = await import('@cairn/db')
      const stepId = '22222222-2222-4222-8222-222222222222'
      const spy = vi.spyOn(dbModule, 'loadRunObservation').mockResolvedValue({
        eventSeq: 1,
        evidence: { items: [] },
        run: {
          id: runId,
          scenarioId: 'sc-1',
          targetId: 'tgt-1',
          status: 'FAILED',
          evidenceStatus: 'COMPLETE',
          placement: { state: 'FINISHED' },
          stepRuns: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              stepId,
              name: '点击按钮',
              status: 'FAILED',
              startedAt: '2026-09-20T10:00:00Z',
              finishedAt: '2026-09-20T10:00:05Z',
              attempts: [
                {
                  id: '44444444-4444-4444-8444-444444444444',
                  status: 'FAILED',
                  finishedAt: '2026-09-20T10:00:05Z',
                  error: { code: 'TIMEOUT', category: 'TIMEOUT', retryable: false, safeMessage: 'timeout' },
                },
              ],
            },
          ],
        } as any,
      } as any)

      try {
        const { assembleDiagnoseContext } = await import('./context-assembler.js')
        const { pack } = await assembleDiagnoseContext(mockDb, runId, {
          quote: {
            type: 'step_failure',
            targetId: stepId,
            title: '步骤 #1: 点击按钮',
            summary: 'locator.click: Timeout 5000ms',
          },
        })

        expect(pack.text).toContain('[用户显式引用的焦点对象]')
        expect(pack.text).toContain('步骤 #1: 点击按钮')
        expect(pack.text).toContain('locator.click: Timeout 5000ms')
        const quoteFact = pack.facts.find((f) => f.id === 'focused_quote')
        expect(quoteFact).toBeDefined()
      } finally {
        spy.mockRestore()
      }
    })

    it('assembleDiagnoseContext 接受 StepRun id 作为步骤焦点', async () => {
      const mockDb: any = {}
      const runId = '11111111-1111-4111-8111-111111111111'
      const dbModule = await import('@cairn/db')
      const stepId = '22222222-2222-4222-8222-222222222222'
      const stepRunId = '33333333-3333-4333-8333-333333333333'
      const spy = vi.spyOn(dbModule, 'loadRunObservation').mockResolvedValue({
        eventSeq: 1,
        evidence: { items: [] },
        run: {
          id: runId,
          scenarioId: 'sc-1',
          targetId: 'tgt-1',
          status: 'FAILED',
          evidenceStatus: 'COMPLETE',
          placement: { state: 'FINISHED' },
          stepRuns: [
            {
              id: stepRunId,
              stepId,
              name: '点击按钮',
              status: 'FAILED',
              startedAt: '2026-09-20T10:00:00Z',
              finishedAt: '2026-09-20T10:00:05Z',
              attempts: [
                {
                  id: '44444444-4444-4444-8444-444444444444',
                  status: 'FAILED',
                  finishedAt: '2026-09-20T10:00:05Z',
                  error: { code: 'TIMEOUT', category: 'TIMEOUT', retryable: false, safeMessage: 'timeout' },
                },
              ],
            },
          ],
        } as any,
      } as any)

      try {
        const { assembleDiagnoseContext } = await import('./context-assembler.js')
        const { pack } = await assembleDiagnoseContext(mockDb, runId, { stepId: stepRunId })
        expect(pack.missingInformation).not.toContain('指定步骤不在该 Run 的 Snapshot 中')
        expect(pack.text).toContain('TIMEOUT')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
