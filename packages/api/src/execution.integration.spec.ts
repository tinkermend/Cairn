import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitStoredObject,
  consoleAccounts,
  createSession,
  getSessionById,
  newId,
  openIsolatedDb,
  recordObjectEvidence,
  reserveStoredObject,
  setSessionStatus,
  type DbHandle,
} from '@cairn/db'
import { DEV_CREDENTIAL_KEY, type Step } from '@cairn/shared'
import type { RequestAccount } from './common/request-account'
import { credentialKeyFromEnv, LocalSecretProvider } from './secrets/local-secret-provider'
import { BrowserSessionsService } from './browser-sessions/browser-sessions.service'
import { RunsService } from './runs/runs.service'
import { ScenariosService } from './scenarios/scenarios.service'
import { TargetsService } from './targets/targets.service'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_api`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000081',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe('执行内核控制面（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let targets: TargetsService
  let scenarios: ScenariosService
  let runs: RunsService
  let actor: RequestAccount

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'api-tester',
      email: `api-${actorId}@example.com`,
      status: 'active',
    })
    actor = {
      id: actorId,
      displayName: 'api-tester',
      email: `api-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:write', 'target:delete', 'workflow:write', 'workflow:delete', 'run:execute'],
    }
    targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    scenarios = new ScenariosService(handle)
    runs = new RunsService(handle)
  })

  afterAll(async () => {
    await handle?.close()
  })

  function slug(prefix: string): string {
    return `${prefix}${SCHEMA.replace(/[^a-z0-9]/g, '').slice(-8)}`
  }

  async function createTarget(code: string, extra?: { status?: 'active' | 'disabled' }) {
    return targets.createTarget(
      {
        code,
        name: code,
        entryUrl: 'https://example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: extra?.status ?? 'active',
        loginFields: null,
      },
      actor,
    )
  }

  it('停用 Target 不能新建场景；停用场景不能新建 Run', async () => {
    const disabled = await createTarget(slug('off'), { status: 'disabled' })
    await expect(
      scenarios.create({ targetId: disabled.id, name: '不该建', steps: [echoStep] }, actor),
    ).rejects.toBeInstanceOf(ConflictException)

    const target = await createTarget(slug('on'))
    const scenario = await scenarios.create({ targetId: target.id, name: '随后停', steps: [echoStep] }, actor)
    await scenarios.update(scenario.id, { status: 'disabled' }, actor)
    try {
      await runs.create({ scenarioId: scenario.id }, actor)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SCENARIO_DISABLED' })
    }
  })

  it('参数化 from：缺 input 创建 Run → SCENARIO_UNRESOLVED_REF', async () => {
    const target = await createTarget(slug('param'))
    const scenario = await scenarios.create(
      {
        targetId: target.id,
        name: '参数化',
        steps: [
          {
            id: '00000000-0000-4000-8000-000000000082',
            name: '回显单号',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { from: 'orderId' },
          },
        ],
      },
      actor,
    )
    try {
      await runs.create({ scenarioId: scenario.id }, actor)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'SCENARIO_UNRESOLVED_REF' })
    }
    const created = await runs.create({ scenarioId: scenario.id, input: { orderId: 'A-1' } }, actor)
    expect(created.created).toBe(true)
    expect(created.detail.context).toEqual({ orderId: 'A-1' })
  })

  it('带账号的 Run：GET 无口令，secretRef 只有引用', async () => {
    const target = await createTarget(slug('sec'))
    const account = await targets.createAccount(
      target.id,
      { displayName: '运维', username: 'ops', password: 'hunter2-secret', status: 'active' },
      actor,
    )
    const scenario = await scenarios.create({ targetId: target.id, name: '带密', steps: [echoStep] }, actor)
    const created = await runs.create({ scenarioId: scenario.id, targetAccountId: account.id }, actor)
    const json = JSON.stringify(created.detail)
    expect(json).not.toContain('hunter2-secret')
    expect(json).not.toContain('password')
    expect(created.detail.snapshot.secretRef).toEqual({
      provider: 'local',
      secretId: expect.any(String),
    })
    expect(created.detail.snapshot).not.toHaveProperty('password')
  })

  it('GET evidence 返回对象指针、无正文', async () => {
    const target = await createTarget(slug('evd'))
    const scenario = await scenarios.create({ targetId: target.id, name: '指针', steps: [echoStep] }, actor)
    const created = await runs.create({ scenarioId: scenario.id }, actor)
    const reserved = await reserveStoredObject(handle.db, {
      runId: created.detail.id,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const digest = `sha256:${'ab'.repeat(32)}`
    await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 12,
      digest,
    })
    await recordObjectEvidence(handle.db, {
      runId: created.detail.id,
      type: 'log',
      objectKey: reserved.objectKey,
    })

    const listed = await runs.evidence(created.detail.id)
    const found = listed.items.find((item) => item.objectKey === reserved.objectKey)
    expect(found).toMatchObject({
      type: 'log',
      objectKey: reserved.objectKey,
      contentType: 'text/plain',
      byteSize: 12,
      digest,
    })
    expect(found?.payload).toBeUndefined()
    expect(JSON.stringify(listed)).not.toContain('hello-object')
  })

  it('删除仍有场景的 Target / 仍有 Run 的场景 / 仍被引用的账号', async () => {
    const withScenarioOnly = await createTarget(slug('dels'))
    await scenarios.create({ targetId: withScenarioOnly.id, name: '占坑', steps: [echoStep] }, actor)
    try {
      await targets.deleteTarget(withScenarioOnly.id, actor)
      expect.unreachable()
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'TARGET_HAS_SCENARIOS' })
    }

    const target = await createTarget(slug('dela'))
    const account = await targets.createAccount(
      target.id,
      { displayName: '引用', username: 'ref', status: 'active' },
      actor,
    )
    const scenario = await scenarios.create({ targetId: target.id, name: '有运行', steps: [echoStep] }, actor)
    await runs.create({ scenarioId: scenario.id, targetAccountId: account.id }, actor)

    try {
      await scenarios.remove(scenario.id, actor)
      expect.unreachable()
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SCENARIO_HAS_RUNS' })
    }
    try {
      await targets.deleteAccount(target.id, account.id, actor)
      expect.unreachable()
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'TARGET_ACCOUNT_HAS_RUNS' })
    }
  })

  it('处置卡死会话：LOST 放行、活会话被拒、键可再用', async () => {
    const target = await createTarget(slug('sess'))
    const account = await targets.createAccount(
      target.id,
      { displayName: '会话账号', username: `sess-${newId().slice(0, 8)}`, status: 'active' },
      actor,
    )
    const sessions = new BrowserSessionsService(handle)

    const created = await createSession(handle.db, {
      key: { targetId: target.id, targetAccountId: account.id },
      ownerWorkerId: 'api-worker',
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    await setSessionStatus(handle.db, {
      sessionId: created.id,
      expectedVersion: created.version,
      status: 'OPEN',
    })
    const opened = (await getSessionById(handle.db, created.id))!

    // 活会话：控制面不得处置
    await expect(sessions.dispose(opened.id, {}, actor)).rejects.toBeInstanceOf(ConflictException)

    // owner 失联 → LOST，键仍被占
    await setSessionStatus(handle.db, {
      sessionId: opened.id,
      expectedVersion: opened.version,
      status: 'LOST',
      closeReason: 'owner_lost',
    })
    expect((await sessions.list()).items.find((s) => s.id === opened.id)?.disposable).toBe(true)

    const dto = await sessions.dispose(opened.id, { note: '已确认旧进程退出' }, actor)
    expect(dto).toMatchObject({ status: 'CLOSED', closeReason: 'operator_disposed', disposable: false })
    expect((await sessions.list()).items.some((s) => s.id === opened.id)).toBe(false)

    // 键已释放：同键可再建
    const rebuilt = await createSession(handle.db, {
      key: { targetId: target.id, targetAccountId: account.id },
      ownerWorkerId: 'api-worker',
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 600,
      maxLifetimeSeconds: 3600,
    })
    expect(rebuilt.generation).toBeGreaterThan(created.generation)
    await setSessionStatus(handle.db, {
      sessionId: rebuilt.id,
      expectedVersion: rebuilt.version,
      status: 'CLOSED',
      closeReason: 'cleanup',
    })

    await expect(sessions.dispose(newId(), {}, actor)).rejects.toBeInstanceOf(NotFoundException)
  })
})
