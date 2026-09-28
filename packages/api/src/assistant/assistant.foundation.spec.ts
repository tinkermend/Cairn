import { describe, expect, it, vi } from 'vitest'
import {
  type ScenarioDocument,
  type AssistantCitationKey,
  citationKey,
  diagnosticFocusSchema,
  matchAssistantCapabilities,
  clarifyAvailableCapabilities,
} from '@cairn/shared'
import { AssistantCapabilityRegistry } from './registry'
import {
  assembleDiagnoseContext,
  assembleRunCompareContext,
  buildAuthoringSlice,
  validateGrounding,
  validateDiagnosisFailureCitations,
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
              outcomeStatus: 'PASS',
              startedAt: '2026-09-20T10:00:00Z',
              finishedAt: '2026-09-20T10:00:02Z',
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
              outcomeStatus: 'FAIL',
              startedAt: '2026-09-21T10:00:00Z',
              finishedAt: '2026-09-21T10:00:05Z',
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
        const { pack } = await assembleRunCompareContext(mockDb, baseRunId, targetRunId, 'test-actor')
        expect(pack.differences.length).toBe(3)
        expect(pack.differences.find((d) => d.stepName === '业务结果')).toMatchObject({
          baseStatus: 'PASS', targetStatus: 'FAIL',
        })
        expect(pack.summary).toContain('业务通过')
        expect(pack.summary).toContain('业务失败')
        expect(pack.summary).toContain('总执行耗时：基准运行 2.00 秒、对比运行 5.00 秒，增加 3.00 秒')

        const loginDiff = pack.differences.find((d) => d.stepId === 'step-login')
        expect(loginDiff?.durationDiffMs).toBe(3000)
        expect(loginDiff?.detail).toContain('对比运行慢 3000 毫秒')
        expect(pack.summary).toContain('耗时差异最大的是「登录」')
        expect(pack.summary).toContain('对比运行慢 3000 毫秒')

        const reversed = (await assembleRunCompareContext(mockDb, targetRunId, baseRunId, 'test-actor')).pack
        expect(reversed.summary).toContain('基准运行慢 3000 毫秒')

        const searchDiff = pack.differences.find((d) => d.stepId === 'step-search')
        expect(searchDiff?.baseStatus).toBe('SUCCEEDED')
        expect(searchDiff?.targetStatus).toBe('FAILED')
        expect(searchDiff?.errorDiff).toContain('ELEMENT_NOT_FOUND')

        expect(pack.facts.some((f) => f.id.includes('step-search'))).toBe(true)

        spy.mockImplementation(async (_db: any, id: string) => {
          const observed = await mockLoadObservation(_db, id)
          return id === targetRunId
            ? { ...observed, run: { ...observed.run, scenarioId: 'sc-2', targetId: 'tgt-2' } }
            : observed
        })
        const unrelated = (await assembleRunCompareContext(mockDb, baseRunId, targetRunId, 'test-actor')).pack
        expect(unrelated.comparability?.comparable).toBe(false)
        expect(unrelated.comparability?.incomparableFactors).toEqual(expect.arrayContaining([
          expect.stringContaining('SCENARIO_MISMATCH'),
          expect.stringContaining('TARGET_MISMATCH'),
        ]))
        expect(unrelated.differences).toEqual([])
        expect(unrelated.facts.map((fact) => fact.id)).toContain('comparability-warning')
        expect(unrelated.summary).toContain('不能可靠地逐步对比')
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('运行诊断中的业务结果轴', () => {
    it('执行成功时仍展示业务检查结论与具体条件，避免把执行成功当作业务通过', async () => {
      const runId = '11111111-1111-4111-8111-111111111111'
      const stepRunId = '22222222-2222-4222-8222-222222222222'
      let verdict: 'PASS' | 'FAIL' = 'PASS'
      let placementState: 'not_applicable' | 'owner_at_capacity' = 'not_applicable'
      const dbModule = await import('@cairn/db')
      const spy = vi.spyOn(dbModule, 'loadRunObservation').mockImplementation(async () => ({
        eventSeq: 1,
        evidence: { items: [] },
        run: {
          id: runId,
          scenarioId: 'scenario-1',
          targetId: 'target-1',
          status: 'SUCCEEDED',
          outcomeStatus: verdict,
          evidenceStatus: 'COMPLETE',
          placement: { state: placementState },
          stepRuns: [],
          outcomeResults: [{
            id: '33333333-3333-4333-8333-333333333333',
            stepRunId,
            meaning: '已进入分组管理页',
            severity: 'MUST',
            verdict,
          }],
        },
      }) as any)
      try {
        const pass = (await assembleDiagnoseContext({} as any, runId, { focus: 'failure' }, 'actor')).pack
        expect(pass.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'outcome_status', text: expect.stringContaining('业务结果为 PASS') }),
          expect.objectContaining({ text: expect.stringContaining('「已进入分组管理页」结果为 PASS') }),
        ]))
        expect(pass.facts.some((fact) => fact.id === 'placement')).toBe(false)
        expect(pass.text).not.toContain('not_applicable')

        verdict = 'FAIL'
        const fail = (await assembleDiagnoseContext({} as any, runId, { focus: 'outcome' }, 'actor')).pack
        expect(fail.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'outcome_status', text: expect.stringContaining('业务结果为 FAIL') }),
          expect.objectContaining({ text: expect.stringContaining('「已进入分组管理页」结果为 FAIL') }),
        ]))
        expect(fail.facts.find((fact) => fact.id === 'outcome_status')?.citations).toEqual([`run:${runId}`])

        // Real screenshot questions can arrive with a free-form supervisor focus.
        // Every returned focus must be safe to persist as an AssistantDiagnosis.
        for (const [requested, expected] of [
          ['waiting', 'wait'],
          ['timing', 'duration'],
          ['screenshot', 'evidence_missing'],
          ['screenshot_page_state', 'overview'],
        ]) {
          const { pack } = await assembleDiagnoseContext({} as any, runId, { focus: requested }, 'actor')
          expect(pack.focus).toBe(expected)
          expect(diagnosticFocusSchema.safeParse(pack.focus).success).toBe(true)
          expect(pack.text).not.toContain('not_applicable')
        }
        placementState = 'owner_at_capacity'
        const waiting = (await assembleDiagnoseContext({} as any, runId, { focus: 'waiting' }, 'actor')).pack
        expect(waiting.facts.find((fact) => fact.id === 'placement')?.text).toContain('执行槽已满')
        expect(waiting.text).not.toContain('owner_at_capacity')
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

    it('AIF-11: 使用已保存 outputKey 识别现代步骤的上游来源', () => {
      const modern = {
        ...document,
        steps: document.steps.map((step) => step.id === 'step-extract-token'
          ? { ...step, outputKey: 'authToken', input: { selector: '#auth-token', as: 'text' } }
          : step),
      }
      const slice = buildAuthoringSlice(modern as unknown as Parameters<typeof buildAuthoringSlice>[0], 'step-fill-password')
      expect(slice.slicedDocument.steps.map((step) => step.id)).toContain('step-extract-token')
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

    it('失败原因必须引用失败步骤，点名步骤或错误码时不能错引其他步骤', () => {
      const priorStepId = '11111111-1111-4111-8111-111111111111'
      const failedStepId = '22222222-2222-4222-8222-222222222222'
      const failedStepRunId = '33333333-3333-4333-8333-333333333333'
      const run = { stepRuns: [
        { id: '44444444-4444-4444-8444-444444444444', stepId: priorStepId, name: '打开页面', status: 'SUCCEEDED', attempts: [] },
        { id: failedStepRunId, stepId: failedStepId, name: '点击 Groups 导航', status: 'FAILED', attempts: [
          { id: '55555555-5555-4555-8555-555555555555', error: { code: 'AI_NOT_FOUND' } },
        ] },
      ] } as any
      const wrong = { text: '点击 Groups 导航出现 AI_NOT_FOUND，可能是元素不存在。', citations: [citationKey('step', priorStepId)] }
      const right = { ...wrong, citations: [citationKey('step', failedStepId)] }
      const unnamedWrong = { text: '这次可能是网页加载异常。', citations: [citationKey('step', priorStepId)] }
      const unnamedRight = { ...unnamedWrong, citations: [citationKey('stepRun', failedStepRunId)] }
      const checked = validateDiagnosisFailureCitations([wrong, right, unnamedWrong, unnamedRight], run)
      expect(checked.invalid).toEqual([wrong, unnamedWrong])
      expect(checked.valid).toEqual([right, unnamedRight])
    })

    it('没有失败步骤时即使引用真实 Run 也不能保留根因假设', () => {
      const runId = '66666666-6666-4666-8666-666666666666'
      const guess = { text: '可能是数据库故障导致运行失败。', citations: [citationKey('run', runId)] }
      const run = { status: 'SUCCEEDED', stepRuns: [{
        id: '77777777-7777-4777-8777-777777777777',
        stepId: '88888888-8888-4888-8888-888888888888',
        name: '检查结果', status: 'SUCCEEDED', attempts: [],
      }] } as any
      expect(validateDiagnosisFailureCitations([guess], run)).toEqual({ valid: [], invalid: [guess] })
    })
  })

  describe('AIF-19: 多能力同时命中时澄清歧义', () => {
    it('当问题同时命中诊断和功能导览时，返回 clarify 候选列表而不是臆测', () => {
      const ambiguousQuestion = '对比两次运行，分析本次失败原因'
      const matches = matchAssistantCapabilities(ambiguousQuestion)
      expect(matches.length).toBeGreaterThan(1)

      const clarify = clarifyAvailableCapabilities(matches)
      expect(clarify.type).toBe('clarify')
      if (clarify.type !== 'clarify') throw new Error('Expected clarification')
      expect(clarify.options?.length).toBeGreaterThanOrEqual(2)
      expect(clarify.options?.every((option) => option.kind === 'capability')).toBe(true)
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
        }, 'test-actor')

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
        const { pack } = await assembleDiagnoseContext(mockDb, runId, { stepId: stepRunId }, 'test-actor')
        expect(pack.missingInformation).not.toContain('指定步骤不在该 Run 的 Snapshot 中')
        expect(pack.text).toContain('TIMEOUT')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
