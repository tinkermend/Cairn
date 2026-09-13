import { ConflictException, ForbiddenException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { consoleAccounts, newId, openIsolatedDb, type DbHandle } from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY, type Step } from '@cairn/shared'
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
      permissions: ['target:write', 'workflow:write', 'run:execute'],
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

  it('能力查询与部署闸门一致，不含未开放的 AI 类型', () => {
    const capabilities = scenarios.capabilities()
    expect(capabilities.executableStepTypes).toEqual(
      expect.arrayContaining(['navigate', 'click', 'fill', 'extract', 'assert', 'echo', 'delay', 'fail']),
    )
    expect(capabilities.executableStepTypes).not.toContain('ai_action')
    expect(capabilities.unavailableReasons.some((item) => item.type === 'ai_action' && item.code === 'AI_DISABLED')).toBe(
      true,
    )
  })

  it('保存草稿升 revision；过期 revision 的保存 / 发布 / 试跑都是同一套冲突', async () => {
    const { created } = await seed()
    const first = created.draft!
    const nextDoc = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [first.document.steps[0]!, extractStep()],
    }
    const saved = await scenarios.saveDraft(created.id, { revision: first.revision, document: nextDoc }, actor)
    expect(saved.draft?.revision).toBe(first.revision + 1)
    expect(saved.draft?.document.steps.map((step) => step.type)).toEqual(['navigate', 'extract'])
    expect(saved.draft?.document.steps[1]).toMatchObject({ outputKey: 'extracted' })

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
    expect(latest.draft?.document.steps).toHaveLength(2)
    expect(latest.draft?.document.steps[1]?.type).toBe('extract')
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
          steps: [created.draft!.document.steps[0]!, extractStep('extracted2')],
        },
      },
      actor,
    )
    expect(saved.draft?.document.steps).toHaveLength(2)
    const after = await scenarios.get(created.id)
    expect(after.draft?.document.steps.map((step) => step.outputKey)).toEqual([undefined, 'extracted2'])

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
          steps: [created.draft!.document.steps[0]!, aiActionStep()],
        },
      },
      actor,
    )
    expect(saved.draft?.document.steps.some((step) => step.type === 'ai_action')).toBe(true)
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
    expect(latest.draft?.document.steps.some((step) => step.type === 'ai_action')).toBe(true)
  })
})
