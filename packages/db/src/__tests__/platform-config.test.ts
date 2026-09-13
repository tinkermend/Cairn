import { afterEach, describe, expect, it } from 'vitest'
import {
  FACTORY_PLATFORM_CONFIG,
  createAccountBodySchema,
  createTargetBodySchema,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
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
  return { db, actor, scenario }
}

describe.each(DRIVERS)('%s 平台配置仓储', (driver) => {
  it('Run 创建只读配置，不会抢先写入出厂值', async () => {
    const { db, actor, scenario } = await fixture(driver)
    expect(await api.getPlatformConfig(db)).toBeNull()
    const created = await api.createRunWithSnapshot(db, {
      scenarioId: scenario.id,
      actor,
    })
    expect(created.created).toBe(true)
    expect(await api.getPlatformConfig(db)).toBeNull()
    expect(created.detail.snapshot.policy?.timeoutMs).toBe(FACTORY_PLATFORM_CONFIG.execution.defaultTimeoutMs)
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
    expect(second.document.execution.defaultTimeoutMs).toBe(first.document.execution.defaultTimeoutMs)

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
    expect(restored.document.execution.defaultTimeoutMs).toBe(FACTORY_PLATFORM_CONFIG.execution.defaultTimeoutMs)
    const history = await api.listPlatformConfigRevisions(db)
    expect(history.items.map((item) => item.revision)).toEqual([3, 2, 1])
    expect(await api.getPlatformConfigRevision(db, 1)).toEqual(FACTORY_PLATFORM_CONFIG)
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
