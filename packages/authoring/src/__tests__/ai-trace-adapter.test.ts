import { describe, expect, it } from 'vitest'
import {
  aiTraceToDemonstrationSource,
  suggestDemonstration,
  previewDemonstration,
  applyDemonstrationToDocument,
} from '../index.js'
import type { AiTaskEvent, ScenarioAuthoringDocumentV2 } from '@cairn/shared'

describe('AI 动作轨迹转示教草稿与固化（AP-1）', () => {
  const attemptId = '00000000-0000-4000-8000-000000000001'
  const runId = '00000000-0000-4000-8000-000000000002'
  const stepRunId = '00000000-0000-4000-8000-000000000003'
  const targetId = '00000000-0000-4000-8000-000000000004'
  const scenarioId = '00000000-0000-4000-8000-000000000005'
  const stepId = '00000000-0000-4000-8000-000000000006'

  const mockEvents: AiTaskEvent[] = [
    {
      attemptId,
      runId,
      stepRunId,
      agentInstanceId: 'agent-1',
      ordinal: 0,
      phase: 'completed',
      source: 'action_edge',
      actionName: 'Navigate',
      sdkVersion: '1.12.6',
      binding: {
        status: 'not_applicable',
        redirected: false,
        candidates: [],
        dataDependent: false,
      },
      valueProvenance: { kind: 'none' },
      pageBefore: {
        url: 'https://example.com/login',
        urlPattern: 'https://example.com/login',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:00.000Z',
      },
      pageAfter: {
        url: 'https://example.com/login',
        urlPattern: 'https://example.com/login',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:01.000Z',
      },
      writeSignalCount: 0,
      writeSignalPaths: [],
      durationMs: 500,
    },
    {
      attemptId,
      runId,
      stepRunId,
      agentInstanceId: 'agent-1',
      ordinal: 1,
      phase: 'completed',
      source: 'action_edge',
      actionName: 'Input',
      elementDescription: '用户名输入框',
      binding: {
        status: 'bound',
        redirected: false,
        candidates: [{ by: 'role', value: 'textbox', name: '用户名' }],
        dataDependent: false,
      },
      valueProvenance: { kind: 'input', source: 'username' },
      pageBefore: {
        url: 'https://example.com/login',
        urlPattern: 'https://example.com/login',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:02.000Z',
      },
      pageAfter: {
        url: 'https://example.com/login',
        urlPattern: 'https://example.com/login',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:03.000Z',
      },
      writeSignalCount: 0,
      writeSignalPaths: [],
      durationMs: 200,
    },
    {
      attemptId,
      runId,
      stepRunId,
      agentInstanceId: 'agent-1',
      ordinal: 2,
      phase: 'completed',
      source: 'action_edge',
      actionName: 'Tap',
      elementDescription: '登录按钮',
      binding: {
        status: 'bound',
        redirected: true,
        candidates: [{ by: 'role', value: 'button', name: '登录' }],
        dataDependent: false,
      },
      valueProvenance: { kind: 'none' },
      pageBefore: {
        url: 'https://example.com/login',
        urlPattern: 'https://example.com/login',
        documentEpoch: 1,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:04.000Z',
      },
      pageAfter: {
        url: 'https://example.com/dashboard',
        urlPattern: 'https://example.com/dashboard',
        documentEpoch: 2,
        readyState: 'complete',
        timestamp: '2026-09-26T10:00:06.000Z',
      },
      writeSignalCount: 1,
      writeSignalPaths: ['POST /api/auth/login'],
      durationMs: 1200,
    },
  ]

  it('aiTraceToDemonstrationSource 纯函数正确生成示教来源对象', () => {
    const source = aiTraceToDemonstrationSource({
      attemptId,
      runId,
      stepRunId,
      targetId,
      scenarioId,
      stepId,
      stepName: 'AI 登录步骤',
      instruction: '输入用户名并点击登录',
      events: mockEvents,
    })

    expect(source.importProfile).toBe('cairn-ai-trace@1')
    expect(source.channel).toBe('run')
    expect(source.producerKind).toBe('cairn_run')
    expect(source.actorKind).toBe('ai')
    expect(source.authorship).toBe('ai')
    expect(source.facts).toHaveLength(3)

    // 检查第 1 步 Navigate
    expect(source.facts[0]?.action).toBe('navigate')
    // 检查第 2 步 Input 带引用来源
    expect(source.facts[1]?.action).toBe('fill')
    expect(source.facts[1]?.data.value).toEqual({ state: 'reference', from: 'username' })
    expect(source.facts[1]?.data.target?.candidates[0]?.by).toBe('role')
    // 检查第 3 步 Tap
    expect(source.facts[2]?.action).toBe('click')
    expect(source.facts[2]?.data.target?.candidates[0]?.value).toBe('button')
    expect(source.facts[2]?.data.target?.candidates[0]?.name).toBe('登录')
  })

  it('suggestDemonstration 能够正确将 AI 轨迹映射为确定性步骤', () => {
    const source = aiTraceToDemonstrationSource({
      attemptId,
      runId,
      stepRunId,
      targetId,
      scenarioId,
      stepId,
      events: mockEvents,
    })

    const suggestions = suggestDemonstration(source)
    expect(suggestions).toHaveLength(3)
    expect(suggestions[0]?.status).toBe('mapped')
    expect(suggestions[0]?.step?.type).toBe('navigate')

    expect(suggestions[1]?.status).toBe('mapped')
    expect(suggestions[1]?.step?.type).toBe('fill')
    expect((suggestions[1]?.step?.input as any).from).toBe('username')

    expect(suggestions[2]?.status).toBe('mapped')
    expect(suggestions[2]?.step?.type).toBe('click')
  })

  it('applyDemonstrationToDocument 支持 replace_sequence 放置并将 AI 步骤替换为多步', () => {
    const source = aiTraceToDemonstrationSource({
      attemptId,
      runId,
      stepRunId,
      targetId,
      scenarioId,
      stepId,
      events: mockEvents,
    })

    const originalDoc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId,
            name: '执行 AI 登录',
            type: 'ai_action',
            effectType: 'SIDE_EFFECT',
            input: { instruction: '登录系统' },
          },
          outcomes: [
            {
              id: '00000000-0000-4000-8000-000000000099',
              scope: 'step',
              meaning: '必须跳转到仪表盘',
              rule: { kind: 'ai', instruction: '页面已跳转到仪表盘' },
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
            },
          ],
        },
      ],
    }

    const preview = previewDemonstration({
      source,
      recordingDraftId: attemptId,
      scenarioId,
      baseRevision: 1,
      placement: { kind: 'replace_sequence', nodeId: stepId },
      remainingCapacity: 100,
    })

    const decisions = preview.suggestions.map((s) => ({
      id: s.id,
      disposition: 'accept' as const,
    }))

    const applied = applyDemonstrationToDocument(originalDoc, preview, {
      protocolVersion: 'demonstration@1',
      idempotencyKey: 'test-apply-key-1',
      recordingDraftId: attemptId,
      baseRevision: 1,
      factDigest: preview.factDigest,
      suggestionDigest: preview.suggestionDigest,
      adapterVersion: preview.adapterVersion,
      ruleVersion: preview.ruleVersion,
      placement: { kind: 'replace_sequence', nodeId: stepId },
      decisions,
    })

    // 原单步应被替换为 3 步
    expect(applied.document.nodes).toHaveLength(3)
    const [stepNav, stepFill, stepClick] = applied.document.nodes as any[]
    expect(stepNav.step.type).toBe('navigate')
    expect(stepFill.step.type).toBe('fill')
    expect(stepClick.step.type).toBe('click')

    // 检查溯源：三个步骤均打上 ai_solidification origin
    expect(stepNav.origin).toMatchObject({
      kind: 'ai_solidification',
      sourceStepId: stepId,
      attemptId,
    })
    expect(stepFill.origin).toMatchObject({
      kind: 'ai_solidification',
      sourceStepId: stepId,
    })
    expect(stepClick.origin).toMatchObject({
      kind: 'ai_solidification',
      sourceStepId: stepId,
    })

    // 检查原步骤的 outcomeContract 转移到了最后一步
    expect(stepNav.outcomes).toBeUndefined()
    expect(stepFill.outcomes).toBeUndefined()
    expect(stepClick.outcomes).toHaveLength(1)
    expect(stepClick.outcomes[0].meaning).toBe('必须跳转到仪表盘')
  })

  it('replace_sequence 拒绝被引用的原步骤（避免上下文断链）', () => {
    const source = aiTraceToDemonstrationSource({
      attemptId,
      runId,
      stepRunId,
      targetId,
      scenarioId,
      stepId,
      events: mockEvents,
    })

    const docWithOutput: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: stepId,
            name: '执行 AI 登录',
            type: 'ai_action',
            effectType: 'SIDE_EFFECT',
            input: { instruction: '登录' },
            outputKey: 'user_token',
          },
        },
      ],
    }

    const preview = previewDemonstration({
      source,
      recordingDraftId: attemptId,
      scenarioId,
      baseRevision: 1,
      placement: { kind: 'replace_sequence', nodeId: stepId },
      remainingCapacity: 100,
    })

    expect(() =>
      applyDemonstrationToDocument(docWithOutput, preview, {
        protocolVersion: 'demonstration@1',
        idempotencyKey: 'test-apply-key-2',
        recordingDraftId: attemptId,
        baseRevision: 1,
        factDigest: preview.factDigest,
        suggestionDigest: preview.suggestionDigest,
        adapterVersion: preview.adapterVersion,
        ruleVersion: preview.ruleVersion,
        placement: { kind: 'replace_sequence', nodeId: stepId },
        decisions: preview.suggestions.map((s) => ({ id: s.id, disposition: 'accept' })),
      }),
    ).toThrow('声明了输出「user_token」')
  })
})
