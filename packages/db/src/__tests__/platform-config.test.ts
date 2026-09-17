import { afterEach, describe, expect, it } from 'vitest'
import {
  FACTORY_PLATFORM_CONFIG,
  PLATFORM_CONFIG_SCHEMA_UNSUPPORTED,
  PLATFORM_CONFIG_SCHEMA_VERSION,
  PLATFORM_CONFIG_SINGLETON_ID,
  createAccountBodySchema,
  createTargetBodySchema,
  resolveAiExecutionFromPlatform,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose, connection } from '../database.js'
import { schemaFor } from '../native.js'
import { computeIdempotencyDigest } from '../runs/digest.js'
import { eq } from 'drizzle-orm'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

const handles: DbHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close()
})

const echo: Step = {
  id: api.newId(),
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

async function fixture(driver: (typeof DRIVERS)[number]) {
  const handle = await openContractDb(driver)
  handles.push(handle)
  const db = expose(handle)
  const rbac = new api.RbacStore(db, {
    hash: async (value: string) => value,
    verify: async (value: string, hash: string) => value === hash,
  })
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: `cfg-${driver}`,
      displayName: '管理员',
      password: 'test-password',
    }),
    null,
  )
  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: `cfg-${driver}`,
      name: '目标',
      entryUrl: 'https://example.com',
      account: { username: 'tester', displayName: '测试账号', password: 'hidden' },
    }),
    actor,
  )
  const scenario = await api.createScenarioWithVersion(db, {
    targetId: target.id,
    name: '场景',
    steps: [{ ...echo, id: api.newId() }],
    actor,
  })
  return { db, actor, scenario, target }
}

describe.each(DRIVERS)('%s 平台配置仓储', (driver) => {
  it('登记原子保存 origin；绑定不可修改和删除，未登记的凭据不能冒用', async () => {
    const { db, actor } = await fixture(driver)
    const id = api.newId()
    await api.registerPlatformAiSecret(db, {
      id,
      baseUrl: 'https://MODEL.example:443/v1',
      ciphertext: Buffer.from('encrypted'),
      actor,
    })
    expect(await api.loadPlatformAiSecret(db, id)).toMatchObject({
      id,
      modelOrigin: 'https://model.example',
    })
    const native = connection(db)
    const { platformAiSecretBindings } = schemaFor(native)
    await expect(
      native
        .update(platformAiSecretBindings)
        .set({ modelOrigin: 'https://other.example' })
        .where(eq(platformAiSecretBindings.secretId, id)),
    ).rejects.toThrow()
    await expect(
      native.delete(platformAiSecretBindings).where(eq(platformAiSecretBindings.secretId, id)),
    ).rejects.toThrow()
    const unbound = api.newId()
    await api.registerStandaloneSecret(db, { id: unbound, ciphertext: Buffer.from('unbound') })
    expect(await api.loadPlatformAiSecret(db, unbound)).toMatchObject({ modelOrigin: null })
  })

  it('旧 Secret 的绑定取首次修订，不被停用和后续地址编辑改变', async () => {
    const { db, actor } = await fixture(driver)
    const id = api.newId()
    await api.registerStandaloneSecret(db, { id, ciphertext: Buffer.from('legacy-encrypted') })
    const document = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: {
        ...FACTORY_PLATFORM_CONFIG.browserAi,
        baseUrl: 'https://original.example/v1',
        secretRef: { provider: 'local', secretId: id },
      },
    }
    await api.getOrCreatePlatformConfig(db, { document, reason: '旧配置初始化' })
    await api.updatePlatformConfig(db, {
      expectedRevision: 1,
      actor,
      reason: '停用中修改地址',
      document: {
        ...document,
        browserAi: { ...document.browserAi, baseUrl: 'https://changed.example/v1' },
      },
    })
    expect(await api.loadPlatformAiSecret(db, id)).toMatchObject({
      modelOrigin: 'https://original.example',
    })
  })

  it('AI 校验最终 Run / Step 超时，并覆盖直接注入 AI 配置的入口', async () => {
    const { db, actor, target } = await fixture(driver)
    const secretId = api.newId()
    await api.registerPlatformAiSecret(db, {
      id: secretId,
      baseUrl: 'https://model.example/v1',
      ciphertext: Buffer.from('encrypted'),
      actor,
    })
    const document = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: {
        ...FACTORY_PLATFORM_CONFIG.browserAi,
        enabled: true,
        baseUrl: 'https://model.example/v1',
        model: 'demo',
        modelFamily: 'openai',
        secretRef: { provider: 'local', secretId },
      },
    }
    await api.getOrCreatePlatformConfig(db, { document, reason: '启用 AI' })
    const step: Step = {
      id: api.newId(),
      name: '查询',
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: '点击查询' },
    }
    const scenario = await api.createScenarioWithVersion(db, {
      targetId: target.id,
      name: 'AI 超时',
      actor,
      steps: [step],
    })
    const request = { scenarioId: scenario.id, actor, policy: { timeoutMs: 10_000 } }
    await expect(api.createRunWithSnapshot(db, request)).rejects.toMatchObject({
      code: 'AI_CONFIG_INVALID',
    })
    await expect(
      api.createRunWithSnapshot(db, {
        ...request,
        aiExecution: resolveAiExecutionFromPlatform([step], document, {
          revision: 1,
          hangWaitMs: 5000,
        }),
      }),
    ).rejects.toMatchObject({ code: 'AI_CONFIG_INVALID' })
    const overridden = await api.createScenarioWithVersion(db, {
      targetId: target.id,
      name: 'Step 覆盖',
      actor,
      steps: [{ ...step, id: api.newId(), policy: { timeoutMs: 20_000 } }],
    })
    expect(
      (await api.createRunWithSnapshot(db, { ...request, scenarioId: overridden.id })).created,
    ).toBe(true)
  })

  it('旧 resolved 摘要兼容部分嵌套覆盖及默认变更，不同值仍冲突', async () => {
    const { db, actor, scenario } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db)
    const request = {
      scenarioId: scenario.id,
      actor,
      evidencePolicy: { retainDays: { screenshot: 10 } },
    }
    const sample = (await api.createRunWithSnapshot(db, request)).detail.snapshot
    const legacy = computeIdempotencyDigest({
      scenarioVersionId: sample.scenarioVersionId,
      input: sample.input,
      targetAccountId: sample.targetAccountId,
      sessionPolicy: sample.sessionPolicy,
      evidencePolicy: sample.evidencePolicy,
    })
    const first = await api.createRunWithSnapshot(db, {
      ...request,
      idempotencyKey: 'legacy',
      externalIdempotencyDigest: legacy,
    })
    await api.updatePlatformConfig(db, {
      expectedRevision: 1,
      actor,
      reason: '修改平台天数',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        evidence: {
          ...FACTORY_PLATFORM_CONFIG.evidence,
          retainDays: { screenshot: 60, trace: 28, debugTrace: 7 },
        },
      },
    })
    expect(
      (await api.createRunWithSnapshot(db, { ...request, idempotencyKey: 'legacy' })).detail.id,
    ).toBe(first.detail.id)
    await expect(
      api.createRunWithSnapshot(db, {
        ...request,
        idempotencyKey: 'legacy',
        evidencePolicy: { retainDays: { screenshot: 11 } },
      }),
    ).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_CONFLICT' })
  })

  it('从始终 Trace 覆盖到失败时，冻结普通 Trace 保留期', async () => {
    const { db, actor, scenario } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      reason: '调试策略',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        evidence: { ...FACTORY_PLATFORM_CONFIG.evidence, trace: 'always' },
      },
    })
    const result = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
      evidencePolicy: { trace: 'on_failure' },
    })
    expect(result.detail.snapshot.evidencePolicy?.retainDays?.trace).toBe(14)
  })

  it('Run 创建只读配置，不会抢先写入出厂值', async () => {
    const { db, actor, scenario } = await fixture(driver)
    expect(await api.getPlatformConfig(db)).toBeNull()
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
    })
    expect(created.created).toBe(true)
    expect(await api.getPlatformConfig(db)).toBeNull()
    expect(created.detail.snapshot.policy?.timeoutMs).toBe(
      FACTORY_PLATFORM_CONFIG.execution.defaultTimeoutMs,
    )
    expect(created.detail.snapshot.platformConfigRevision).toBeUndefined()
    expect(created.detail.snapshot.targetAuth?.entryUrl).toBe('https://example.com')
  })

  it('初始化只发生一次；保存冲突；恢复产生新修订', async () => {
    const { db, actor } = await fixture(driver)
    const first = await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化：出厂默认',
    })
    const second = await api.getOrCreatePlatformConfig(db, {
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { ...FACTORY_PLATFORM_CONFIG.execution, defaultTimeoutMs: 45_000 },
      },
      reason: '不应覆盖',
    })
    expect(second.revision).toBe(1)
    expect(second.document.execution.defaultTimeoutMs).toBe(
      first.document.execution.defaultTimeoutMs,
    )

    const updated = await api.updatePlatformConfig(db, {
      expectedRevision: 1,
      reason: '调整默认超时',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: 45_000, defaultRetryLimit: 0 },
      },
      actor,
    })
    expect(updated.revision).toBe(2)
    await expect(
      api.updatePlatformConfig(db, {
        expectedRevision: 1,
        reason: '过期修订',
        document: FACTORY_PLATFORM_CONFIG,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONFIG_CONFLICT' })

    const restored = await api.restorePlatformConfig(db, {
      revision: 1,
      expectedRevision: 2,
      reason: '回到出厂超时',
      actor,
    })
    expect(restored.revision).toBe(3)
    expect(restored.source).toBe('restore')
    expect(restored.document.execution.defaultTimeoutMs).toBe(
      FACTORY_PLATFORM_CONFIG.execution.defaultTimeoutMs,
    )
    const history = await api.listPlatformConfigRevisions(db)
    expect(history.items.map((item) => item.revision)).toEqual([3, 2, 1])
    expect(await api.getPlatformConfigRevision(db, 1)).toEqual(FACTORY_PLATFORM_CONFIG)
  })

  it('历史修订含当前 Schema 已无的节：变更记录照常列出，恢复给出可读拒绝', async () => {
    const { db, actor } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化',
    })
    await api.updatePlatformConfig(db, {
      expectedRevision: 1,
      reason: '提高超时',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: 45_000, defaultRetryLimit: 0 },
      },
      actor,
    })

    // 修订表不可变，只能追加：直接插入一条"当前 Schema 已无此节"的历史修订。
    const native = connection(db)
    const { platformConfigRevisions } = schemaFor(native)
    await native.insert(platformConfigRevisions).values({
      id: api.newId(),
      revision: 3,
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        retiredSection: { legacy: true },
      } as unknown as typeof FACTORY_PLATFORM_CONFIG,
      actorConsoleAccountId: actor.id,
      reason: '写入时还存在的旧节',
      source: 'update',
      createdAt: new Date(),
    })

    const history = await api.listPlatformConfigRevisions(db)
    expect(history.items.map((item) => item.revision)).toEqual([3, 2, 1])
    expect(history.items[0]?.document).toMatchObject({ retiredSection: { legacy: true } })
    expect(history.items[0]?.diff.map((change) => change.path)).toContain('retiredSection')

    await expect(api.getPlatformConfigRevision(db, 3)).rejects.toMatchObject({
      code: 'PLATFORM_CONFIG_REVISION_INCOMPATIBLE',
    })
    await expect(
      api.restorePlatformConfig(db, {
        revision: 3,
        expectedRevision: 2,
        reason: '尝试恢复不兼容修订',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONFIG_REVISION_INCOMPATIBLE' })
    expect((await api.getPlatformConfig(db))?.revision).toBe(2)
  })

  it('当前配置行缺某一节时读取补出厂默认，不需要先保存一次', async () => {
    const { db } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化',
    })
    const { moduleResolver: _dropped, ...legacy } = FACTORY_PLATFORM_CONFIG
    const native = connection(db)
    const { platformConfig } = schemaFor(native)
    await native
      .update(platformConfig)
      .set({ document: legacy as unknown as typeof FACTORY_PLATFORM_CONFIG })
      .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
    expect((await api.getPlatformConfig(db))?.document.moduleResolver).toEqual(
      FACTORY_PLATFORM_CONFIG.moduleResolver,
    )
  })

  it('配置行版本高于本版本时明确拒绝，而不是按当前 Schema 误读', async () => {
    const { db } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化',
    })
    const native = connection(db)
    const { platformConfig } = schemaFor(native)
    await native
      .update(platformConfig)
      .set({
        document: {
          ...FACTORY_PLATFORM_CONFIG,
          schemaVersion: PLATFORM_CONFIG_SCHEMA_VERSION + 1,
        } as unknown as typeof FACTORY_PLATFORM_CONFIG,
      })
      .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
    await expect(api.getPlatformConfig(db)).rejects.toMatchObject({
      code: PLATFORM_CONFIG_SCHEMA_UNSUPPORTED,
    })
  })

  it('新 Run 冻结当前修订；改默认后同键重发仍返回原 Run', async () => {
    const { db, actor, scenario } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化',
    })
    const first = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
      idempotencyKey: 'same-request',
    })
    expect(first.detail.snapshot.platformConfigRevision).toBe(1)
    expect(first.detail.snapshot.policy?.timeoutMs).toBe(30_000)

    await api.updatePlatformConfig(db, {
      expectedRevision: 1,
      reason: '提高超时',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: 45_000, defaultRetryLimit: 0 },
      },
      actor,
    })
    const replay = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
      idempotencyKey: 'same-request',
    })
    expect(replay.created).toBe(false)
    expect(replay.detail.id).toBe(first.detail.id)
    expect(replay.detail.snapshot.policy?.timeoutMs).toBe(30_000)

    const next = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
      idempotencyKey: 'new-request',
    })
    expect(next.created).toBe(true)
    expect(next.detail.snapshot.platformConfigRevision).toBe(2)
    expect(next.detail.snapshot.policy?.timeoutMs).toBe(45_000)
  })
})
