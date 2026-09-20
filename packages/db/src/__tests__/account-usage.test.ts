import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTargetBodySchema, type Step } from '@cairn/shared'
import { TargetsStore } from '../console/targets.js'
import { expose } from '../database.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  updateMapJobPolicy,
  writeSchedule,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000061',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 账号用途准入', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `usage_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'usage',
      email: `usage-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return {
      id: actorId,
      displayName: 'usage',
      email: `usage-${actorId}@example.com`,
      status: 'active' as const,
      roles: [],
      permissions: [],
    }
  }

  async function freshTarget() {
    const store = new TargetsStore(expose(handle), () => Buffer.from('fixture'))
    const target = await store.createTarget(
      createTargetBodySchema.parse({
        code: `usage-${newId()}`,
        name: '用途夹具',
        entryUrl: 'https://shop.example/home',
      }),
      actor(),
    )
    return { store, target }
  }

  it('RJ-11/14 未标地图用途不能开手工作业或保存复查计划', async () => {
    const { store, target } = await freshTarget()
    const account = await store.createAccount(
      target.id,
      { displayName: '业务号', username: `biz-${newId().slice(0, 8)}`, status: 'active' },
      actor(),
    )
    expect(account.usage).toBe('business')
    await expect(
      updateMapJobPolicy(
        handle.db,
        target.id,
        {
          expectedRevision: 0,
          idempotencyKey: `enable:${target.id}`.slice(0, 128),
          manualJobsEnabled: true,
          reason: '无采集号',
        },
        { kind: 'console', id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'MAP_ACCOUNT_USAGE_REQUIRED' })
    await expect(
      writeSchedule(
        handle.db,
        {
          expectedRevision: 0,
          idempotencyKey: `sched:${newId()}`,
          definition: {
            timezone: 'Asia/Shanghai',
            weekdays: [1],
            windowStart: '02:00',
            windowEnd: '03:00',
            misfire: 'skip',
            consumer: {
              type: 'map_refresh',
              targetId: target.id,
              targetAccountId: account.id,
              entryId: newId(),
            },
          },
        },
        { kind: 'console', id: actorId },
      ),
    ).rejects.toMatchObject({ code: 'MAP_ACCOUNT_USAGE_REQUIRED' })
  })

  it('RJ-12 仅地图账号不能创建场景 Run', async () => {
    const { store, target } = await freshTarget()
    const account = await store.createAccount(
      target.id,
      { displayName: '采集号', username: `map-${newId().slice(0, 8)}`, status: 'active', usage: 'map' },
      actor(),
    )
    expect(account.usage).toBe('map')
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId: target.id,
      name: `场景-${newId().slice(0, 8)}`,
      steps: [echo],
      actor: { kind: 'console', id: actorId },
    })
    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        targetAccountId: account.id,
        actor: { kind: 'console', id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'RUN_ACCOUNT_MAP_ONLY' })
  })

  it('RJ-13 同一目标不能有第二个含地图用途的账号', async () => {
    const { store, target } = await freshTarget()
    await store.createAccount(
      target.id,
      { displayName: '采集号', username: `map-${newId().slice(0, 8)}`, status: 'active', usage: 'both' },
      actor(),
    )
    await expect(
      store.createAccount(
        target.id,
        { displayName: '第二采集', username: `map2-${newId().slice(0, 8)}`, status: 'active', usage: 'map' },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_MAP_USAGE_CONFLICT' })
  })
})
