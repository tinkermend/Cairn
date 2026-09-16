import { ConflictException, ForbiddenException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPlatformConfig } from '@cairn/db'
import { consoleAccounts, newId, openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import { authoringSteps, DEV_CREDENTIAL_KEY, type Step } from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { ScenariosService } from './scenarios.service'
import { TargetsService } from '../targets/targets.service'
import { RunsService } from '../runs/runs.service'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_studio`

function navigateStep(url = 'https://shop.example.com'): Step {
  return {
    id: newId(),
    name: '打开页面',
    type: 'navigate',
    effectType: 'SIDE_EFFECT',
    input: { url },
  }
}

function extractStep(outputKey = 'extracted'): Step {
  return {
    id: newId(),
    name: '提取',
    type: 'extract',
    effectType: 'READ_ONLY',
    outputKey,
    input: { target: { framePath: [], candidates: [{ by: 'label', value: '单号' }] }, as: 'text' },
  }
}

function aiActionStep(): Step {
  return {
    id: newId(),
    name: 'AI 操作',
    type: 'ai_action',
    effectType: 'SIDE_EFFECT',
    input: { instruction: '点击查询' },
  }
}

describe('Studio 控制面（真实库）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let targets: TargetsService
  let scenarios: ScenariosService
  let actor: RequestAccount

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    const actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'studio-tester',
      email: `studio-${actorId}@example.com`,
      status: 'active',
    })
    actor = {
      id: actorId,
      displayName: 'studio-tester',
      email: `studio-${actorId}@example.com`,
      status: 'active',
      roles: [],
      permissions: ['target:read', 'target:write', 'workflow:write', 'run:execute'],
    }
    targets = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
    scenarios = new ScenariosService(handle)
  })

  afterAll(async () => {
    await handle?.close()
  })

  function slug(prefix: string): string {
    return `${prefix}${newId().replaceAll('-', '')}`
  }

  async function seed() {
    const target = await targets.createTarget(
      {
        code: slug('st'),
        name: slug('st'),
        entryUrl: 'https://shop.example.com',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const created = await scenarios.create(
      { targetId: target.id, name: 'Studio 编排', steps: [navigateStep()] },
      actor,
    )
    return { target, created }
  }

  // 这里跑的是真实进程配置，AI 开关由部署环境决定，所以断言两张清单的划分关系，
  // 而不是断言某个环境下的开关值：三类 AI 步骤同进同出，且可执行与不可用互斥、合起来盖满。
  it('能力查询与部署闸门一致：AI 类型要么整组可执行，要么整组给出关闭原因', async () => {
    expect(await getPlatformConfig(handle)).toBeNull()
    const capabilities = await scenarios.capabilities()
    expect(await getPlatformConfig(handle)).toBeNull()
    expect(capabilities.executableStepTypes).toEqual(
      expect.arrayContaining([
        'navigate',
        'click',
        'fill',
        'extract',
        'assert',
        'select',
        'keyboard',
        'wait',
        'echo',
        'delay',
        'fail',
      ]),
    )
    expect(capabilities.authoring).toMatchObject({
      indicate: 'open',
      highlight: 'open',
      debugHold: 'open',
      assist: 'closed',
      stepTypesExtra: ['select', 'keyboard', 'wait'],
    })
    expect(capabilities.authoringSchemaVersions).toEqual([1, 2])
    expect(capabilities.actionModules).toBe(true)
    const aiTypes = ['ai_action', 'ai_extract', 'ai_assert']
    const executable = aiTypes.filter((type) => capabilities.executableStepTypes.includes(type))
    const blocked = aiTypes.filter((type) =>
      capabilities.unavailableReasons.some((item) => item.type === type && item.code === 'AI_DISABLED'),
    )
    expect(executable.length === 0 ? blocked : executable).toEqual(aiTypes)
    expect(executable.filter((type) => blocked.includes(type))).toEqual([])
  })

  it('保存草稿升 revision；过期 revision 的保存 / 发布 / 试跑都是同一套冲突', async () => {
    const { created } = await seed()
    const first = created.draft!
    const nextDoc = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [authoringSteps(first.document)[0]!, extractStep()],
    }
    const saved = await scenarios.saveDraft(created.id, { revision: first.revision, document: nextDoc }, actor)
    expect(saved.draft?.revision).toBe(first.revision + 1)
    expect(authoringSteps(saved.draft!.document).map((step) => step.type)).toEqual(['navigate', 'extract'])
    expect(authoringSteps(saved.draft!.document)[1]).toMatchObject({ outputKey: 'extracted' })

    try {
      await scenarios.saveDraft(
        created.id,
        {
          revision: first.revision,
          document: { schemaVersion: 1, inputs: [], steps: [navigateStep('https://shop.example.com/x')] },
        },
        actor,
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    }

    try {
      await scenarios.publish(created.id, { revision: first.revision }, actor)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    }
    try {
      await scenarios.trial(created.id, { revision: first.revision }, actor)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
    }

    const latest = await scenarios.get(created.id)
    expect(authoringSteps(latest.draft!.document)).toHaveLength(2)
    expect(authoringSteps(latest.draft!.document)[1]?.type).toBe('extract')
  })

  it('试跑只跑已保存草稿，幂等键复用同一 Run，改草稿不改旧 Snapshot', async () => {
    const { created } = await seed()
    const key = `trial-${newId()}`
    const first = await scenarios.trial(created.id, { revision: created.draft!.revision, idempotencyKey: key }, actor)
    expect(first.created).toBe(true)
    expect(first.detail.scenarioId).toBe(created.id)
    expect(first.detail.scenarioVersionKind).toBe('trial')
    expect(first.detail.snapshot.steps[0]).toMatchObject({ name: '打开页面', type: 'navigate' })

    const again = await scenarios.trial(created.id, { revision: created.draft!.revision, idempotencyKey: key }, actor)
    expect(again.created).toBe(false)
    expect(again.detail.id).toBe(first.detail.id)

    const saved = await scenarios.saveDraft(
      created.id,
      {
        revision: created.draft!.revision,
        document: {
          schemaVersion: 1,
          inputs: [],
          steps: [authoringSteps(created.draft!.document)[0]!, extractStep('extracted2')],
        },
      },
      actor,
    )
    expect(authoringSteps(saved.draft!.document)).toHaveLength(2)
    const after = await scenarios.get(created.id)
    expect(authoringSteps(after.draft!.document).map((step) => step.outputKey)).toEqual([undefined, 'extracted2'])

    const runs = new RunsService(handle)
    const live = await runs.get(first.detail.id)
    expect(live.snapshot.steps).toHaveLength(1)
    expect(live.snapshot.steps[0]).toMatchObject({ name: '打开页面', type: 'navigate' })
    expect(live.scenarioVersionId).toBe(first.detail.scenarioVersionId)
  })

  it('含 AI 步骤但没有 ai:execute 时试跑被拒，草稿仍在', async () => {
    const { created } = await seed()
    const saved = await scenarios.saveDraft(
      created.id,
      {
        revision: created.draft!.revision,
        document: {
          schemaVersion: 1,
          inputs: [],
          steps: [authoringSteps(created.draft!.document)[0]!, aiActionStep()],
        },
      },
      actor,
    )
    expect(authoringSteps(saved.draft!.document).some((step) => step.type === 'ai_action')).toBe(true)
    await expect(scenarios.trial(saved.id, { revision: saved.draft!.revision }, actor)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    try {
      await scenarios.trial(saved.id, { revision: saved.draft!.revision }, actor)
      expect.unreachable()
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'AI_EXECUTE_FORBIDDEN' })
    }
    const latest = await scenarios.get(created.id)
    expect(authoringSteps(latest.draft!.document).some((step) => step.type === 'ai_action')).toBe(true)
  })
})
