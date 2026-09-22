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

/**
 * 用确定性浏览器步骤造场景，不用 echo：这份用例测的是平台配置，而 echo 属于调试夹具，
 * 平台出厂关闭，建 Run 时会被闸门拒绝。用生产上合法的步骤类型，既不依赖夹具开关，
 * 也不需要预先种一行配置——后者会破坏「库里一开始没有配置」的前提。
 */
const navigate: Step = {
  id: api.newId(),
  name: '打开首页',
  type: 'navigate',
  effectType: 'READ_ONLY',
  input: { url: 'https://example.com' },
}

/**
 * fixture() 保存场景时会惰性初始化出厂配置，所以用例里再 getOrCreate(自己的文档) 是空操作。
 * 要把配置换成用例需要的样子，走产品真实的「改配置」路径。
 */
async function adoptPlatformConfig(
  db: ReturnType<typeof expose>,
  actor: Awaited<ReturnType<typeof fixture>>['actor'],
  document: typeof FACTORY_PLATFORM_CONFIG,
  reason: string,
) {
  const current = await api.getPlatformConfig(db)
  if (!current) return api.getOrCreatePlatformConfig(db, { document, reason })
  return api.updatePlatformConfig(db, {
    expectedRevision: current.revision,
    document,
    reason,
    actor,
  })
}

async function fixture(driver: (typeof DRIVERS)[number]) {
  // 纯净库：这份用例测「平台配置从无到有」，库里不能预先有 platform_config 行。
  const handle = await openContractDb(driver, undefined, { pristine: true })
  handles.push(handle)
  const db = expose(handle)
  const rbac = new api.RbacStore(db, {
    hash: async (value: string) => value,
    verify: async (value: string, hash: string) => value === hash,
  })
  const adminRoleId = (await rbac.listRoles()).items.find(role => role.key === 'admin')!.id
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: `cfg-${driver}`,
      displayName: '管理员',
      password: 'test-password',
      roleIds: [adminRoleId],
      targetScopes: [{ roleId: adminRoleId, mode: 'all' }],
    }),
    null,
  )
  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: `cfg-${driver}`,
      name: '目标',
      entryUrl: 'https://example.com',
      account: { username: 'tester', displayName: '测试账号', password: 'hidden', validity: { mode: 'permanent' } },
    }),
    actor,
  )
  const scenario = await api.createScenarioWithVersion(db, {
    targetId: target.id,
    name: '场景',
    steps: [{ ...navigate, id: api.newId() }],
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
    // 首次引用该 secret 的修订是这里的 original；之后再改地址，绑定仍取首次那一版。
    const first = await adoptPlatformConfig(db, actor, document, '旧配置初始化')
    await api.updatePlatformConfig(db, {
      expectedRevision: first.revision,
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
    await adoptPlatformConfig(db, actor, document, '启用 AI')
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
    // 保存场景需要一份确定的平台配置来编译，会惰性初始化出厂值（getOrCreatePlatformConfig）。
    // 这条用例守护的是「Run 创建」这一步只读：建 Run 前后配置行不得有任何变化。
    const before = await api.getPlatformConfig(db)
    expect(before).not.toBeNull()
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
    })
    expect(created.created).toBe(true)
    const after = await api.getPlatformConfig(db)
    expect(after?.revision).toBe(before!.revision)
    expect(after?.document).toEqual(before!.document)
    expect(created.detail.snapshot.policy?.timeoutMs).toBe(
      FACTORY_PLATFORM_CONFIG.execution.defaultTimeoutMs,
    )
    // 配置行已存在（保存场景时惰性初始化），快照冻结的就是建 Run 时的当前修订，不多不少。
    expect(created.detail.snapshot.platformConfigRevision).toBe(before!.revision)
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

  it('知识分析 useAi 在入队口拒绝缺提供商，不只在执行器失败', async () => {
    const { db, actor, target } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db, {
      document: FACTORY_PLATFORM_CONFIG,
      reason: '初始化',
    })
    const current = (await api.getPlatformConfig(db))!
    // 出厂已预填提供商；「缺提供商」是存量文档形态，须显式去掉这个键才构造得出来。
    const { provider: _factoryProvider, ...platformAiWithoutProvider } =
      FACTORY_PLATFORM_CONFIG.platformAi
    await api.updatePlatformConfig(db, {
      expectedRevision: current.revision,
      reason: '启用分析但未选提供商',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        analysisAi: { ...FACTORY_PLATFORM_CONFIG.analysisAi, enabled: true },
        platformAi: {
          ...platformAiWithoutProvider,
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          secretRef: { provider: 'local', secretId: api.newId() },
        },
      },
      actor,
    })
    await expect(
      api.createAnalysisJob(db, {
        targetId: target.id,
        mode: 'map_quality',
        source: { includeFailures: true },
        strategyVersion: 'analysis-strategy@1',
        budget: { maxItems: 1, useAi: true },
        actor: { kind: 'console', id: actor.id },
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_CONFIG_INVALID' })
  })

  it('readLiveSessionAuth 升级存量文档，旧 schemaVersion 不阻断会话登录', async () => {
    const { db } = await fixture(driver)
    await api.getOrCreatePlatformConfig(db)
    const native = connection(db)
    const { platformConfig } = schemaFor(native)
    const [row] = await native.select().from(platformConfig)
    expect(row).toBeTruthy()
    const stored = { ...(row!.document as Record<string, unknown>) }
    const sessionAuth = { ...((stored.sessionAuth as Record<string, unknown>) ?? {}) }
    delete sessionAuth.loginLeaveTimeoutMs
    await native
      .update(platformConfig)
      .set({
        document: {
          ...stored,
          schemaVersion: 4,
          sessionAuth,
        },
      })
      .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
    const live = await api.readLiveSessionAuth(db)
    expect(live.sessionAuth.loginLeaveTimeoutMs).toBe(
      FACTORY_PLATFORM_CONFIG.sessionAuth.loginLeaveTimeoutMs,
    )
  })
})
