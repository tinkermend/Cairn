import { describe, expect, it } from 'vitest'
import {
  FACTORY_PLATFORM_CONFIG,
  TARGET_ACCESS_POLICY_SCHEMA_VERSION,
  type FrozenAuthVerification,
  type FrozenTargetAccessPolicy,
  type Step,
} from '@cairn/shared'
import { assembleRunSnapshot } from '../runs/assemble-snapshot.js'

const ids = {
  run: '00000000-0000-4000-8000-000000000021',
  target: '00000000-0000-4000-8000-000000000022',
  scenario: '00000000-0000-4000-8000-000000000024',
  version: '00000000-0000-4000-8000-000000000025',
  echo: '00000000-0000-4000-8000-000000000026',
}

const echoStep: Step = {
  id: ids.echo,
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'echo_1',
  input: { value: { ok: true } },
}

const authVerification: FrozenAuthVerification = {
  profileRevision: null,
  profileDigest: null,
  loginFieldsDigest: 'a'.repeat(64),
  expectedIdentity: null,
  capability: 'LEGACY',
  freshnessSeconds: 300,
  verifyTimeoutMs: 10_000,
  loginTimeoutMs: 30_000,
  verifyRetryBackoffSeconds: [1],
  platformConfigRevision: 1,
}

const accessPolicy: FrozenTargetAccessPolicy = {
  revision: 1,
  digest: 'b'.repeat(64),
  policy: {
    schemaVersion: TARGET_ACCESS_POLICY_SCHEMA_VERSION,
    policyVersion: 1,
    rules: [{ origin: 'https://erp.example', purpose: 'business_surface', effect: 'allow' }],
  },
}

describe('assembleRunSnapshot', () => {
  it('v2 仅文本模型在视觉关闭时冻结文本配置，规则场景不冻结模型', () => {
    const step: Step = {
      id: '00000000-0000-4000-8000-000000000027', name: '查询', type: 'click', effectType: 'SIDE_EFFECT',
      input: { target: { semantic: '查询按钮', candidates: [{ by: 'text', value: '查询' }] } },
      policy: { locatorPlan: { v: 2, order: ['text_ai'] } },
    }
    const document = {
      ...FACTORY_PLATFORM_CONFIG,
      locator: { defaultPlan: { v: 2 as const, order: ['rule' as const] }, limits: { v: 2 as const, allowed: ['rule' as const, 'text_ai' as const] } },
      platformAi: { ...FACTORY_PLATFORM_CONFIG.platformAi, enabled: true, secretRef: { provider: 'local' as const, secretId: '00000000-0000-4000-8000-000000000033' } },
    }
    const input = {
      runId: ids.run, createdAt: new Date('2026-09-26T00:00:00.000Z'), targetId: ids.target,
      scenarioId: ids.scenario, scenarioVersionId: ids.version, steps: [step], input: {},
      target: { entryUrl: 'https://erp.example/app', loginUrl: 'https://erp.example/login', authMethod: 'password', captchaMode: 'none', loginFields: null, sessionPolicy: null },
      platformDocument: document, platformRevision: 3, locatorProtocol: 2 as const,
      authVerification, allowedOrigins: ['https://erp.example'], accessPolicy, mapConsumption: { mode: 'off' as const },
    }
    const snapshot = assembleRunSnapshot(input)
    expect(snapshot.resolution).toMatchObject({ protocol: 'snapshot.resolution@2', steps: { [step.id]: { actual: ['text_ai'] } }, textConfigVersion: '3' })
    expect(snapshot.aiExecution).toMatchObject({ visionEnabled: false, modelBaseUrl: document.platformAi.baseUrl })
    const rule = assembleRunSnapshot({ ...input, steps: [{ ...step, policy: { locatorPlan: { v: 2 as const, order: ['rule' as const] } } }] })
    expect(rule.aiExecution).toBeUndefined()
  })
  it('相同输入得到相同 digest，且不改策略合并结果', () => {
    const input = {
      runId: ids.run,
      createdAt: new Date('2026-09-10T08:00:00.000Z'),
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [echoStep],
      input: { orderId: 'SO-1' },
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
      },
      platformDocument: FACTORY_PLATFORM_CONFIG,
      platformRevision: 1,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' as const },
    }
    const first = assembleRunSnapshot(input)
    const second = assembleRunSnapshot(input)
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toBeTruthy()
    expect(first.sessionPolicy).toEqual(second.sessionPolicy)
    expect(first.policy).toEqual(second.policy)
    expect(first.mapConsumption).toEqual({ mode: 'off' })
    expect(first.loginOrigin).toBe('https://erp.example')
    expect(first.evidencePolicy.screenshot).toBe(FACTORY_PLATFORM_CONFIG.evidence.screenshot)
    expect(first.evidencePolicy.video).toBe(FACTORY_PLATFORM_CONFIG.evidence.video)
    expect(first.evidencePolicy.captureContractVersion).toBe(1)
    expect(first.evidencePolicy.screenshotViewport).toBe('viewport')
  })

  it('地图作业冻结轻量证据策略，不吃平台出厂截图/录像', () => {
    const snapshot = assembleRunSnapshot({
      runId: ids.run,
      createdAt: new Date('2026-09-10T08:00:00.000Z'),
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [echoStep],
      input: {},
      evidencePolicyOverride: { screenshot: 'always', video: 'always', trace: 'always' },
      mapJob: {
        jobId: '00000000-0000-4000-8000-000000000099',
        sliceOrdinal: 0,
        purpose: 'map_probe',
        entryId: '00000000-0000-4000-8000-000000000098',
        policyRevision: 1,
        remainingBudgetSeconds: 20,
        consumerVersion: 'map-jobs@1',
      },
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
      },
      platformDocument: FACTORY_PLATFORM_CONFIG,
      platformRevision: 1,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' },
    })
    expect(snapshot.evidencePolicy).toMatchObject({
      screenshot: 'off',
      video: 'off',
      trace: 'off',
    })
    expect(snapshot.mapJob?.jobId).toBe('00000000-0000-4000-8000-000000000099')
  })

  it('新快照可冻结凭据版本与登录名配对', () => {
    const snapshot = assembleRunSnapshot({
      runId: ids.run,
      createdAt: new Date('2026-09-19T00:00:00.000Z'),
      targetId: ids.target,
      targetAccountId: '00000000-0000-4000-8000-000000000031',
      secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000032' },
      credentialBinding: {
        credentialId: '00000000-0000-4000-8000-000000000031',
        versionId: '00000000-0000-4000-8000-000000000032',
        identityRevision: 1,
        identityUsername: 'alice',
      },
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [echoStep],
      input: {},
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
      },
      platformDocument: FACTORY_PLATFORM_CONFIG,
      platformRevision: 1,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' },
    })
    expect(snapshot.credentialBinding).toEqual({
      credentialId: '00000000-0000-4000-8000-000000000031',
      versionId: '00000000-0000-4000-8000-000000000032',
      identityRevision: 1,
      identityUsername: 'alice',
    })
    expect(snapshot.secretRef?.secretId).toBe('00000000-0000-4000-8000-000000000032')
  })

  it('目标系统上限能压住平台已开放的 AI 档，不冻结 resolution', () => {
    const clickId = '00000000-0000-4000-8000-000000000041'
    const click: Step = {
      id: clickId,
      name: '点击',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: { target: { candidates: [{ by: 'text', value: '查询' }] } },
    }
    const platformDocument = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: {
        ...FACTORY_PLATFORM_CONFIG.browserAi,
        enabled: true,
        baseUrl: 'https://model.example/v1',
        model: 'demo',
        modelFamily: 'doubao-seed',
        secretRef: { provider: 'local' as const, secretId: '00000000-0000-4000-8000-000000000033' },
        resolutionCeiling: 'prefer_deterministic' as const,
      },
    }
    const closed = assembleRunSnapshot({
      runId: ids.run,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [click],
      input: {},
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
        resolutionPolicy: { ceiling: 'deterministic_only' },
      },
      platformDocument,
      platformRevision: 2,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' },
    })
    expect(closed.resolution).toBeUndefined()
    expect(closed.aiExecution).toBeUndefined()

    const open = assembleRunSnapshot({
      runId: ids.run,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [click],
      input: {},
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
        resolutionPolicy: { preference: 'prefer_deterministic' },
      },
      platformDocument,
      platformRevision: 2,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' },
    })
    expect(open.resolution?.ceiling).toBe('prefer_deterministic')
    expect(open.resolution?.targetPreference).toBe('prefer_deterministic')
    expect(open.resolution?.steps[clickId]).toBe('prefer_deterministic')
    expect(open.aiExecution?.modelName).toBe('demo')

    const leftover = assembleRunSnapshot({
      runId: ids.run,
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [click],
      input: {},
      target: {
        entryUrl: 'https://erp.example/app',
        loginUrl: 'https://erp.example/login',
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: null,
        sessionPolicy: null,
        resolutionPolicy: { ceiling: 'deterministic_only' },
      },
      platformDocument,
      platformRevision: 2,
      aiExecution: open.aiExecution,
      authVerification,
      allowedOrigins: ['https://erp.example'],
      accessPolicy,
      mapConsumption: { mode: 'off' },
    })
    expect(leftover.resolution).toBeUndefined()
    expect(leftover.aiExecution).toBeUndefined()
  })
})
