import { BadRequestException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { computeStepDefinitionDigest, type AiTaskEvent, type DemonstrationDetail } from '@cairn/shared'
import { DomainError } from '@cairn/db'
import { RunsService } from './runs.service'

const mocks = vi.hoisted(() => ({
  authorizeTargetRequest: vi.fn(),
  getRun: vi.fn(),
  getScenario: vi.fn(),
  listAiTaskEvents: vi.fn(),
  createDemonstration: vi.fn(),
}))

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    authorizeTargetRequest: mocks.authorizeTargetRequest,
    getRun: mocks.getRun,
    getScenario: mocks.getScenario,
    listAiTaskEvents: mocks.listAiTaskEvents,
    createDemonstration: mocks.createDemonstration,
  }
})

describe('RunsService.createSolidificationDraft', () => {
  mocks.authorizeTargetRequest.mockResolvedValue(undefined)
  const runId = '66666666-6666-4666-8666-666666666666'
  const attemptId = '77777777-7777-4777-8777-777777777777'
  const stepRunId = '88888888-8888-4888-8888-888888888888'
  const stepId = '22222222-2222-4222-8222-222222222222'
  const scenarioId = '33333333-3333-4333-8333-333333333333'
  const targetId = '11111111-1111-4111-8111-111111111111'

  const actor = {
    id: 'acc-admin',
    displayName: 'Admin',
    email: 'admin@example.com',
    status: 'active' as const,
    roles: [],
    permissions: [],
  }

  const baseRun = {
    id: runId,
    scenarioId,
    targetId,
    snapshot: {
      steps: [
        {
          id: stepId,
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          name: 'AI 点击提交',
          input: { instruction: '点击提交按钮' },
        },
      ],
    },
    stepRuns: [
      {
        id: stepRunId,
        stepId,
        scopePath: '',
        status: 'SUCCEEDED',
        attempts: [
          {
            id: attemptId,
            attemptNo: 1,
            status: 'SUCCEEDED',
          },
        ],
      },
    ],
  }

  const sampleEvent: AiTaskEvent = {
    agentInstanceId: 'agent-1',
    ordinal: 1,
    phase: 'completed',
    actionName: 'Tap',
    sdkVersion: '1.0.0',
    elementDescription: '提交按钮',
    binding: {
      status: 'bound',
      candidates: [
        {
          by: 'role',
          value: 'button',
          name: '提交',
        },
      ],
      redirected: false,
      dataDependent: false,
    },
    valueProvenance: {
      kind: 'literal',
    },
    pageBefore: {
      url: 'https://example.com/form',
      urlPattern: 'https://example.com/form',
      documentEpoch: 1,
      readyState: 'complete',
      timestamp: '2026-09-24T10:00:00.000Z',
    },
    timestamp: '2026-09-24T10:00:01.000Z',
  }

  it('目标越权时不读取运行或创建草案', async () => {
    mocks.getRun.mockClear()
    mocks.createDemonstration.mockClear()
    mocks.authorizeTargetRequest.mockRejectedValueOnce(new DomainError('not_found', 'TARGET_NOT_FOUND', '目标不存在或无权访问'))
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toMatchObject({
      response: { code: 'TARGET_NOT_FOUND' },
    })
    expect(mocks.getRun).not.toHaveBeenCalled()
    expect(mocks.createDemonstration).not.toHaveBeenCalled()
  })

  it('运行记录不存在时抛出 NotFoundException', async () => {
    mocks.getRun.mockResolvedValueOnce(null)
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('步骤尝试不存在时抛出 NotFoundException', async () => {
    mocks.getRun.mockResolvedValueOnce(baseRun)
    const service = new RunsService({} as any)
    await expect(
      service.createSolidificationDraft(runId, 'non-existent-attempt', actor),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('模块内部步骤（scopePath 不为空）拒绝固化', async () => {
    mocks.getRun.mockResolvedValueOnce({
      ...baseRun,
      stepRuns: [
        {
          ...baseRun.stepRuns[0],
          scopePath: 'mod-1#sub',
        },
      ],
    })
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('步骤类型不是 ai_action 时拒绝', async () => {
    mocks.getRun.mockResolvedValueOnce({
      ...baseRun,
      snapshot: {
        steps: [
          {
            id: stepId,
            type: 'click',
            name: '普通点击',
            input: {},
          },
        ],
      },
    })
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('Attempt 未成功时拒绝', async () => {
    mocks.getRun.mockResolvedValueOnce({
      ...baseRun,
      stepRuns: [
        {
          ...baseRun.stepRuns[0],
          attempts: [
            {
              id: attemptId,
              attemptNo: 1,
              status: 'FAILED',
            },
          ],
        },
      ],
    })
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('无 AI 动作事实时拒绝', async () => {
    mocks.getRun.mockResolvedValueOnce(baseRun)
    mocks.listAiTaskEvents.mockResolvedValueOnce({ events: [], observation: null })
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('轨迹不完整或固化等级为 blocked 时拒绝', async () => {
    mocks.getRun.mockResolvedValueOnce(baseRun)
    mocks.listAiTaskEvents.mockResolvedValueOnce({
      events: [sampleEvent],
      observation: {
        traceIntegrity: 'partial',
        solidifiableLevel: 'blocked',
        solidifiableReasons: ['TRAJECTORY_INCOMPLETE'],
      },
    })
    const service = new RunsService({} as any)
    await expect(service.createSolidificationDraft(runId, attemptId, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('合格轨迹成功生成确定性录制草稿，返回草稿详情与诊断', async () => {
    const expectedDigest = computeStepDefinitionDigest(baseRun.snapshot.steps[0] as any)
    mocks.getRun.mockResolvedValueOnce(baseRun)
    mocks.listAiTaskEvents.mockResolvedValueOnce({
      events: [sampleEvent],
      observation: {
        traceIntegrity: 'complete',
        solidifiableLevel: 'full',
        solidifiableReasons: [],
        stepDefinitionDigest: expectedDigest,
      },
    })
    mocks.getScenario.mockResolvedValueOnce({
      id: scenarioId,
      draft: {
        revision: 1,
        document: {
          authoringSchemaVersion: 2,
          schemaVersion: 1,
          nodes: [
            {
              kind: 'step',
              step: {
                id: stepId,
                type: 'ai_action',
                effectType: 'SIDE_EFFECT',
                name: 'AI 点击提交',
                input: { instruction: '点击提交按钮' },
              },
            },
          ],
        },
      },
    })
    mocks.createDemonstration.mockResolvedValueOnce({
      recordingDraftId: 'rec-draft-12345',
    } as DemonstrationDetail)

    const service = new RunsService({} as any)
    const result = await service.createSolidificationDraft(runId, attemptId, actor)

    expect(result).toEqual({
      recordingDraftId: 'rec-draft-12345',
      scenarioId,
      sourceNodeId: stepId,
      sourceNodePresent: true,
      definitionChanged: false,
      diagnostics: [],
    })
    expect(mocks.createDemonstration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: `solidify-${attemptId}`,
        name: expect.stringContaining('AI 点击提交'),
        acknowledgedOmittedConfig: true,
      }),
      actor,
    )
  })

  it('步骤定义发生漂移时标记 definitionChanged 并附 SOURCE_DEFINITION_CHANGED 诊断', async () => {
    mocks.getRun.mockResolvedValueOnce(baseRun)
    mocks.listAiTaskEvents.mockResolvedValueOnce({
      events: [sampleEvent],
      observation: {
        traceIntegrity: 'complete',
        solidifiableLevel: 'full',
        solidifiableReasons: [],
        stepDefinitionDigest: 'old-sha256-digest',
      },
    })
    mocks.getScenario.mockResolvedValueOnce({
      id: scenarioId,
      draft: {
        revision: 2,
        document: {
          authoringSchemaVersion: 2,
          schemaVersion: 1,
          nodes: [
            {
              kind: 'step',
              step: {
                id: stepId,
                type: 'ai_action',
                effectType: 'SIDE_EFFECT',
                name: 'AI 点击提交（已改提示词）',
                input: { instruction: '修改后的指令' },
              },
            },
          ],
        },
      },
    })
    mocks.createDemonstration.mockResolvedValueOnce({
      recordingDraftId: 'rec-draft-67890',
    } as DemonstrationDetail)

    const service = new RunsService({} as any)
    const result = await service.createSolidificationDraft(runId, attemptId, actor)

    expect(result.definitionChanged).toBe(true)
    expect(result.diagnostics).toContain('SOURCE_DEFINITION_CHANGED')
    expect(result.sourceNodePresent).toBe(true)
  })
})
