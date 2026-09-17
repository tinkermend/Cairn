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
  })
})
