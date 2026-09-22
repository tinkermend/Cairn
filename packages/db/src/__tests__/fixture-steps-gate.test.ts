import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FACTORY_PLATFORM_CONFIG } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig, getPlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  adjustPlatformConfig,
  createRunWithSnapshot,
  createScenarioWithVersion,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

/**
 * 夹具步骤不访问目标系统，跑出来的成败不是业务事实，却与真实运行共用
 * Run / Outcome / 证据与总览口径。闸门放在 writeRunWithSnapshot：控制台、
 * 调度、场景集、开放服务与地图作业都经由它建 Run，不各拦一次。
 */
describe.each(DRIVERS)('%s 调试夹具闸门', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `fix_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'fixture-gate',
      email: `fixture-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `fix-${targetId}`,
      name: '夹具闸门',
      entryUrl: 'https://shop.example/home',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function setFixtureSteps(enabled: boolean): Promise<void> {
    const current = await getPlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current!.revision,
      document: { ...FACTORY_PLATFORM_CONFIG, fixtureStepsEnabled: enabled },
      reason: `测试：夹具步骤 ${enabled ? '开放' : '关闭'}`,
      actor: { id: actorId },
    })
  }

  async function scenarioWithFixtureStep(name: string): Promise<string> {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name,
      steps: [
        {
          id: newId(),
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
      actor: { id: actorId },
    })
    return scenario.id
  }

  it('关闭后不能用夹具步骤建运行，错误指出具体步骤', async () => {
    const scenarioId = await scenarioWithFixtureStep('夹具关闭')
    await setFixtureSteps(false)
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'FIXTURE_STEPS_DISABLED' })
  })

  it('已存在的夹具场景在关闭后同样跑不动，不因为「早就建好了」放行', async () => {
    const scenarioId = await scenarioWithFixtureStep('先建后关')
    await setFixtureSteps(true)
    const allowed = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    expect(allowed.detail.id).toBeTruthy()

    await setFixtureSteps(false)
    await expect(
      createRunWithSnapshot(handle.db, { scenarioId, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'FIXTURE_STEPS_DISABLED' })
  })

  it('adjustPlatformConfig 只改差异并真正生效：预写的夹具开关保留，传入的改动不被吞掉', async () => {
    await setFixtureSteps(true)
    await adjustPlatformConfig(
      handle,
      { id: actorId },
      (document) => ({ ...document, sessionAuth: { ...document.sessionAuth, autoLoginMaxPerWindow: 20 } }),
      '测试：调高自动登录额度',
    )
    const after = await getPlatformConfig(handle.db)
    // 对照：getOrCreate 传文档在已有配置的库上是空操作，这正是 adjustPlatformConfig 存在的原因。
    expect(after!.document.sessionAuth.autoLoginMaxPerWindow).toBe(20)
    expect(after!.document.fixtureStepsEnabled).toBe(true)
    const ignored = await getOrCreatePlatformConfig(handle.db, {
      document: { ...FACTORY_PLATFORM_CONFIG, sessionAuth: { ...FACTORY_PLATFORM_CONFIG.sessionAuth, autoLoginMaxPerWindow: 5 } },
      reason: '应被忽略',
    })
    expect(ignored.document.sessionAuth.autoLoginMaxPerWindow).toBe(20)
  })

  it('闸门只拦夹具步骤，确定性浏览器步骤照常建运行', async () => {
    await setFixtureSteps(false)
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '导航场景',
      steps: [
        {
          id: newId(),
          name: '导航',
          type: 'navigate',
          effectType: 'READ_ONLY',
          input: { url: 'https://shop.example/home' },
        },
      ],
      actor: { id: actorId },
    })
    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    expect(run.detail.id).toBeTruthy()
  })
})
