import { BadRequestException, NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adjustPlatformConfig,
  aiPathObservations,
  aiTaskEvents,
  attempts,
  consoleAccounts,
  grantAdminScope,
  newId,
  openIsolatedDb,
  runs,
  scenarios,
  stepRuns,
  type DbHandle,
} from '@cairn/db/testing'
import { registerPlatformAiSecret } from '@cairn/db'
import {
  computeStepDefinitionDigest,
  DEMONSTRATION_ADAPTER_VERSION,
  DEMONSTRATION_PROTOCOL,
  DEMONSTRATION_RULE_VERSION,
  DEV_CREDENTIAL_KEY,
  normalizeAuthoringDocument,
  walkAuthoringNodes,
  type Step,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { RunsService } from '../runs/runs.service'
import { ScenariosService } from './scenarios.service'
import { TargetsService } from '../targets/targets.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_solidify`

describe('AI 步骤固化端到端全链路（AP-1 集成测试）', { timeout: 35_000 }, () => {
  let handle: DbHandle
  let targets: TargetsService
  let scenariosService: ScenariosService
  let runsService: RunsService
  let actor: RequestAccount
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: actorId, displayName: 'solid-tester', email: `solid-${actorId}@example.com`, status: 'active' },
    ])
    await grantAdminScope(handle.db, actorId)
    actor = {
      id: actorId,
      displayName: 'solid-tester',
      email: `solid-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:read', 'target:write', 'workflow:read', 'workflow:write', 'run:read', 'run:execute', 'ai:execute'],
    }

    const secretId = newId()
    await registerPlatformAiSecret(handle, {
      id: secretId,
      baseUrl: 'https://model.example/v1',
      ciphertext: Buffer.from('encrypted'),
      actor: { id: actorId },
    })

    await adjustPlatformConfig(
      handle,
      { id: actorId },
      (document) => ({
        ...document,
        browserAi: {
          ...document.browserAi,
          enabled: true,
          baseUrl: 'https://model.example/v1',
          model: 'demo',
          modelFamily: 'openai',
          secretRef: { provider: 'local', secretId },
        },
      }),
      '测试：启用 Browser AI 支持 ai_action 步骤编译',
    )
    targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    scenariosService = new ScenariosService(handle)
    runsService = new RunsService(handle)

    const target = await targets.createTarget(
      {
        code: `st${newId().replaceAll('-', '').slice(0, 10)}`,
        name: 'AI 固化测试目标',
        entryUrl: 'https://shop.example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    targetId = target.id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function seedScenarioWithAiStep() {
    const navStep: Step = {
      id: newId(),
      name: '访问结算页',
      type: 'navigate',
      effectType: 'SIDE_EFFECT',
      input: { url: 'https://shop.example.com/checkout' },
    }

    const aiStep: Step = {
      id: newId(),
      name: '智能点击支付并填写优惠券',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: '点击支付按钮并填写优惠券' },
    }

    const created = await scenariosService.create(
      {
        targetId,
        name: `固化场景 ${newId()}`,
        steps: [navStep, aiStep],
      },
      actor,
    )

    // 给 aiStep 挂上业务成功判定 (Outcome)
    const draftDoc = normalizeAuthoringDocument(created.draft!.document)
    const stepNodes = walkAuthoringNodes(draftDoc)
    const aiNode = stepNodes.find((n) => n.node.kind === 'step' && n.node.step.id === aiStep.id)
    if (aiNode && aiNode.node.kind === 'step') {
      aiNode.node.outcomes = [
        {
          id: newId(),
          scope: 'step',
          meaning: '支付成功提示出现',
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'manual',
          rule: {
            kind: 'deterministic',
            target: { framePath: [], candidates: [{ by: 'text', value: '支付成功' }] },
            expect: { kind: 'visible' },
          },
        },
      ]
      await scenariosService.saveDraft(
        created.id,
        {
          revision: created.draft!.revision,
          document: draftDoc,
        },
        actor,
      )
    }

    const reloaded = await scenariosService.get(created.id, actor)
    return { scenario: reloaded, navStep, aiStep }
  }

  async function seedExecutionFacts(input: {
    scenarioId: string
    scenarioVersionId: string
    aiStep: Step
    traceIntegrity?: 'complete' | 'missing'
    attemptStatus?: 'SUCCEEDED' | 'FAILED'
  }) {
    const runId = newId()
    const stepRunId = newId()
    const attemptId = newId()
    const traceIntegrity = input.traceIntegrity ?? 'complete'
    const attemptStatus = input.attemptStatus ?? 'SUCCEEDED'
    const stepDigest = computeStepDefinitionDigest(input.aiStep)

    // 1. 写入 Run
    await handle.db.insert(runs).values({
      id: runId,
      targetId,
      scenarioId: input.scenarioId,
      scenarioVersionId: input.scenarioVersionId,
      createdByConsoleAccountId: actor.id,
      status: attemptStatus === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      snapshot: {
        schemaVersion: 1,
        runId,
        targetId,
        scenarioId: input.scenarioId,
        scenarioVersionId: input.scenarioVersionId,
        steps: [input.aiStep],
        input: {},
        aiExecution: {
          adapter: 'midscene',
          adapterVersion: '1',
          sdkVersion: '1.12.6',
          routeId: 'browser-default',
          configVersion: '1',
          modelBaseUrl: 'https://model.example/v1',
          modelName: 'demo',
          modelFamily: 'openai',
          promptVersion: '1',
          policyVersion: '1',
          maxCalls: 10,
          maxOutputTokens: 2048,
          requestTimeoutMs: 30000,
          hangWaitMs: 5000,
        },
        createdAt: new Date().toISOString(),
      } as any,
      snapshotDigest: 'test-digest',
      context: {},
      stepRuns: [
        {
          id: stepRunId,
          stepId: input.aiStep.id,
          name: input.aiStep.name,
          ordinal: 0,
          scopePath: '',
          status: attemptStatus,
          resolvedStepSnapshot: {
            stepDefinitionDigest: stepDigest,
          },
          attempts: [
            {
              id: attemptId,
              attemptNo: 1,
              status: attemptStatus,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          ],
        },
      ] as any,
    })

    // 2. 写入 StepRun & Attempt
    await handle.db.insert(stepRuns).values({
      id: stepRunId,
      runId,
      stepId: input.aiStep.id,
      name: input.aiStep.name,
      ordinal: 0,
      scopePath: '',
      status: attemptStatus,
      startedAt: new Date(),
      finishedAt: new Date(),
    })

    await handle.db.insert(attempts).values({
      id: attemptId,
      stepRunId,
      attemptNo: 1,
      status: attemptStatus,
      startedAt: new Date(),
      finishedAt: new Date(),
    })

    // 3. 写入 AI 轨迹观测
    await handle.db.insert(aiPathObservations).values({
      attemptId,
      runId,
      stepRunId,
      stepId: input.aiStep.id,
      scenarioId: input.scenarioId,
      targetId,
      stepDefinitionDigest: stepDigest,
      namespaceDigest: 'ns-test',
      solidifiableLevel: 'recommended',
      traceIntegrity,
      actionCount: 2,
      modelCalls: 2,
      inputTokens: 500,
      outputTokens: 100,
      durationMs: 800,
      stepResult: attemptStatus,
    })

    // 4. 写入 2 条真实动作事实
    await handle.db.insert(aiTaskEvents).values([
      {
        id: newId(),
        attemptId,
        runId,
        stepRunId,
        agentInstanceId: 'agent-1',
        ordinal: 0,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Tap',
        sdkVersion: '1.0.0',
        elementDescription: '去支付按钮',
        bindingJson: {
          status: 'bound',
          candidates: [{ by: 'role', value: 'button', name: '去支付' }],
          redirected: false,
          dataDependent: false,
        },
        valueProvenanceJson: { kind: 'none' },
        pageBeforeJson: {
          url: 'https://shop.example.com/checkout',
          urlPattern: 'https://shop.example.com/checkout',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: new Date().toISOString(),
        },
        durationMs: 300,
      },
      {
        id: newId(),
        attemptId,
        runId,
        stepRunId,
        agentInstanceId: 'agent-1',
        ordinal: 1,
        phase: 'completed',
        source: 'action_edge',
        actionName: 'Input',
        sdkVersion: '1.0.0',
        elementDescription: '优惠券输入框',
        bindingJson: {
          status: 'bound',
          candidates: [{ by: 'role', value: 'textbox', name: '优惠券' }],
          redirected: false,
          dataDependent: false,
        },
        valueProvenanceJson: { kind: 'literal', value: 'DISCOUNT2026' },
        pageBeforeJson: {
          url: 'https://shop.example.com/checkout',
          urlPattern: 'https://shop.example.com/checkout',
          documentEpoch: 1,
          readyState: 'complete',
          timestamp: new Date().toISOString(),
        },
        durationMs: 400,
      },
    ])

    return { runId, stepRunId, attemptId }
  }

  it('端到端全链路：生成固化草稿 -> 示教预览 -> 回填应用 replace_sequence -> 校验 AST 替换与 outcomes 转移', async () => {
    const { scenario, aiStep } = await seedScenarioWithAiStep()
    const { runId, attemptId } = await seedExecutionFacts({
      scenarioId: scenario.id,
      scenarioVersionId: scenario.published.versionId,
      aiStep,
    })

    // 1. 调用 API 生成固化示教草案
    const draftResult = await runsService.createSolidificationDraft(runId, attemptId, actor)
    expect(draftResult.recordingDraftId).toBeDefined()
    expect(draftResult.sourceNodeId).toBe(aiStep.id)
    expect(draftResult.sourceNodePresent).toBe(true)
    expect(draftResult.definitionChanged).toBe(false)
    const suggestedPlacement = {
      kind: 'replace_sequence' as const,
      nodeId: draftResult.sourceNodeId,
    }

    // 验证草稿生成的幂等性
    const draftAgain = await runsService.createSolidificationDraft(runId, attemptId, actor)
    expect(draftAgain.recordingDraftId).toBe(draftResult.recordingDraftId)

    // 2. 调用 API 预览示教导入
    const preview = (await scenariosService.previewRecordingImport(
      scenario.id,
      {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        recordingDraftId: draftResult.recordingDraftId,
        baseRevision: scenario.draft!.revision,
        placement: suggestedPlacement,
      },
      actor,
    )) as any
    expect(preview.suggestions).toHaveLength(2)
    const [sugTap, sugInput] = preview.suggestions
    expect(sugTap!.step?.type).toBe('click')
    expect(sugInput!.step?.type).toBe('fill')
    expect(sugInput!.parameter?.value).toBe('DISCOUNT2026')

    // 3. 构建全部 accept 的决定并应用示教回填
    const decisions = preview.suggestions.map((s: any) => ({
      id: s.id,
      disposition: 'accept' as const,
    }))

    const applyKey = `apply-solid-${newId().slice(0, 8)}`
    const applyResult = await scenariosService.applyRecordingImport(
      scenario.id,
      {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        idempotencyKey: applyKey,
        baseRevision: scenario.draft!.revision,
        recordingDraftId: draftResult.recordingDraftId,
        placement: suggestedPlacement,
        factDigest: preview.factDigest,
        suggestionDigest: preview.suggestionDigest,
        adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
        ruleVersion: DEMONSTRATION_RULE_VERSION,
        decisions,
      },
      actor,
    )

    expect(applyResult.receipt.newRevision).toBe(scenario.draft!.revision + 1)
    expect(applyResult.receipt.insertedStepIds).toHaveLength(2)

    // 4. 深度验证场景草稿的最新 AST
    const updated = await scenariosService.get(scenario.id, actor)
    const nodes = walkAuthoringNodes(updated.draft!.document)

    // 原来 2 个节点（navigate + ai_action），ai_action 被 2 个确定性步骤替换，总计应为 3 个节点
    expect(nodes).toHaveLength(3)
    const [n1, n2, n3] = nodes

    // 第 1 步依然是 navigate
    expect(n1!.node.kind).toBe('step')
    if (n1!.node.kind === 'step') {
      expect(n1!.node.step.type).toBe('navigate')
      expect(n1!.node.origin).toBeUndefined()
    }

    // 第 2 步是固化出的 click
    expect(n2!.node.kind).toBe('step')
    if (n2!.node.kind === 'step') {
      expect(n2!.node.step.type).toBe('click')
      expect(n2!.node.origin).toEqual({
        kind: 'ai_solidification',
        sourceStepId: aiStep.id,
        runId: draftResult.recordingDraftId,
        attemptId: draftResult.recordingDraftId,
        instruction: '点击支付按钮并填写优惠券',
      })
      // 第 2 步不应该承载原 ai_action 的 outcomes
      expect(n2!.node.outcomes).toBeUndefined()
    }

    // 第 3 步是固化出的 fill
    expect(n3!.node.kind).toBe('step')
    if (n3!.node.kind === 'step') {
      expect(n3!.node.step.type).toBe('fill')
      expect(n3!.node.origin).toEqual({
        kind: 'ai_solidification',
        sourceStepId: aiStep.id,
        runId: draftResult.recordingDraftId,
        attemptId: draftResult.recordingDraftId,
        instruction: '点击支付按钮并填写优惠券',
      })
      // 第 3 步作为序列末位，必须承接原 ai_action 的 outcomes 业务判定！
      expect(n3!.node.outcomes).toHaveLength(1)
      expect(n3!.node.outcomes![0]!.meaning).toBe('支付成功提示出现')
    }

    // 5. 验证幂等性：使用相同的 idempotencyKey 再次提交 apply
    const idempotencyAgain = await scenariosService.applyRecordingImport(
      scenario.id,
      {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        idempotencyKey: applyKey,
        baseRevision: scenario.draft!.revision,
        recordingDraftId: draftResult.recordingDraftId,
        placement: suggestedPlacement,
        factDigest: preview.factDigest,
        suggestionDigest: preview.suggestionDigest,
        adapterVersion: DEMONSTRATION_ADAPTER_VERSION,
        ruleVersion: DEMONSTRATION_RULE_VERSION,
        decisions,
      },
      actor,
    )
    expect(idempotencyAgain.receipt.id).toBe(applyResult.receipt.id)
  })

  it('防御与边界：轨迹不完整时阻断生成', async () => {
    const { scenario, aiStep } = await seedScenarioWithAiStep()
    const { runId, attemptId } = await seedExecutionFacts({
      scenarioId: scenario.id,
      scenarioVersionId: scenario.published.versionId,
      aiStep,
      traceIntegrity: 'missing',
    })

    await expect(
      runsService.createSolidificationDraft(runId, attemptId, actor),
    ).rejects.toThrow(BadRequestException)
  })

  it('防御与边界：Attempt 失败时阻断生成', async () => {
    const { scenario, aiStep } = await seedScenarioWithAiStep()
    const { runId, attemptId } = await seedExecutionFacts({
      scenarioId: scenario.id,
      scenarioVersionId: scenario.published.versionId,
      aiStep,
      attemptStatus: 'FAILED',
    })

    await expect(
      runsService.createSolidificationDraft(runId, attemptId, actor),
    ).rejects.toThrow(BadRequestException)
  })

  it('防御与边界：原步骤在草稿中被删除时标识不在草稿中', async () => {
    const { scenario, aiStep, navStep } = await seedScenarioWithAiStep()
    const { runId, attemptId } = await seedExecutionFacts({
      scenarioId: scenario.id,
      scenarioVersionId: scenario.published.versionId,
      aiStep,
    })

    // 在草稿中删除该 aiStep，只留 navStep
    const draftDoc = normalizeAuthoringDocument(scenario.draft!.document)
    draftDoc.nodes = draftDoc.nodes.filter(
      (c) => !(c.kind === 'step' && c.step.id === aiStep.id),
    )
    await scenariosService.saveDraft(
      scenario.id,
      {
        revision: scenario.draft!.revision,
        document: draftDoc,
      },
      actor,
    )

    const draftResult = await runsService.createSolidificationDraft(runId, attemptId, actor)
    expect(draftResult.sourceNodePresent).toBe(false)
    expect(draftResult.definitionChanged).toBe(true)
    expect(draftResult.diagnostics).toContain('STEP_NOT_IN_DRAFT')
  })

  it('防御与边界：原步骤定义被修改时感知漂移 (definitionChanged: true)', async () => {
    const { scenario, aiStep } = await seedScenarioWithAiStep()
    const { runId, attemptId } = await seedExecutionFacts({
      scenarioId: scenario.id,
      scenarioVersionId: scenario.published.versionId,
      aiStep,
    })

    // 修改草稿中的 aiStep instruction
    const draftDoc = normalizeAuthoringDocument(scenario.draft!.document)
    const nodes = walkAuthoringNodes(draftDoc)
    const targetNode = nodes.find((n) => n.node.kind === 'step' && n.node.step.id === aiStep.id)
    if (targetNode && targetNode.node.kind === 'step') {
      targetNode.node.step.input = { instruction: '点击支付按钮并修改发票' }
    }
    await scenariosService.saveDraft(
      scenario.id,
      {
        revision: scenario.draft!.revision,
        document: draftDoc,
      },
      actor,
    )

    const draftResult = await runsService.createSolidificationDraft(runId, attemptId, actor)
    expect(draftResult.sourceNodePresent).toBe(true)
    expect(draftResult.definitionChanged).toBe(true)
    expect(draftResult.diagnostics).toContain('SOURCE_DEFINITION_CHANGED')
  })
})
