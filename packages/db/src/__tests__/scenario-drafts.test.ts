import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { authoringSteps, createRuntimeInvariant, type Step } from '@cairn/shared'
import {
  appendScenarioVersion,
  createRunWithSnapshot,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  getScenario,
  listScenarioVersions,
  listScenarios,
  publishScenarioDraft,
  saveScenarioDraft,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_draft`

const echoStep = (id: string, name: string, extra: Pick<Extract<Step, { type: 'echo' }>, 'input' | 'outputKey'>): Step => ({
  id,
  name,
  type: 'echo',
  effectType: 'READ_ONLY',
  ...extra,
})

describe.each(DRIVERS)('%s 场景草稿 / 发布 / 试跑（集成）', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let consoleAccounts = schemaFor({}).consoleAccounts
  let targets = schemaFor({}).targets
  let scenarioVersions = schemaFor({}).scenarioVersions

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, targets, scenarioVersions } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `draft-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `draft-${SCHEMA.slice(-6)}`,
      name: '草稿夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('创建双写草稿与 Version 1，dirty=false，立刻可跑', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '创建即可跑',
      steps: [echoStep(newId(), '回显', { input: { value: 'ok' } })],
      actor: { id: actorId },
    })
    expect(scenario.latestVersionNo).toBe(1)
    expect(scenario.draftDirty).toBe(false)
    expect(scenario.draft?.revision).toBe(1)
    expect(scenario.compile?.ok).toBe(true)
    const run = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    expect(run.created).toBe(true)
    expect(run.detail.scenarioVersionKind).toBe('published')
  })

  it('同一 revision 并发保存：一个成功一个冲突', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'OCC',
      steps: [echoStep(newId(), '回显', { input: { value: 'a' } })],
      actor: { id: actorId },
    })
    const documentA = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [echoStep(newId(), '甲', { input: { value: 'a' } })],
    }
    const documentB = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [echoStep(newId(), '乙', { input: { value: 'b' } })],
    }
    const first = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: documentA,
      actor: { id: actorId },
    })
    expect(first.draft?.revision).toBe(2)
    expect(first.draftDirty).toBe(true)
    await expect(
      saveScenarioDraft(handle.db, scenario.id, {
        revision: 1,
        document: documentB,
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT', kind: 'conflict' })
    const latest = await getScenario(handle.db, scenario.id)
    expect(authoringSteps(latest.draft!.document)[0]?.name).toBe('甲')
  })

  it('同一 revision 连续发布两次只得到一个版本', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '发布幂等',
      steps: [echoStep(newId(), '回显', { input: { value: 'v1' } })],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        schemaVersion: 1,
        inputs: [],
        steps: [echoStep(newId(), '改过', { input: { value: 'v2' } })],
      },
      actor: { id: actorId },
    })
    const first = await publishScenarioDraft(handle.db, scenario.id, { revision: 2, actor: { id: actorId } })
    expect(first.latestVersionNo).toBe(2)
    expect(first.draftDirty).toBe(false)
    const again = await publishScenarioDraft(handle.db, scenario.id, { revision: 2, actor: { id: actorId } })
    expect(again.latestVersionId).toBe(first.latestVersionId)
    expect((await listScenarioVersions(handle.db, scenario.id)).items).toHaveLength(2)
  })

  it('库里有 trial 时 latestVersionNo 与 versions 只看 published', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: 'NULLS FIRST',
      steps: [echoStep(newId(), '回显', { input: { value: 'p' } })],
      actor: { id: actorId },
    })
    await handle.db.insert(scenarioVersions).values({
      id: newId(),
      scenarioId: scenario.id,
      versionNo: null,
      kind: 'trial',
      definition: scenario.published!.definition,
      compilerVersion: 1,
      sourceDigest: `trial-${scenario.id}`,
      createdByConsoleAccountId: actorId,
      createdAt: new Date(),
    })
    const listed = await listScenarios(handle.db)
    const item = listed.items.find((row) => row.id === scenario.id)
    expect(item?.latestVersionNo).toBe(1)
    expect((await listScenarioVersions(handle.db, scenario.id)).items.every((version) => version.kind === 'published')).toBe(
      true,
    )
    const next = await appendScenarioVersion(handle.db, scenario.id, {
      steps: [echoStep(newId(), '第二版', { input: { value: 'p2' } })],
      actor: { id: actorId },
    })
    expect(next.latestVersionNo).toBe(2)
  })

  it('试跑绑定 trial 版本，改草稿不影响已有 Run；同内容复用版本行', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '试跑复用',
      steps: [echoStep(newId(), '回显', { input: { value: 't1' } })],
      actor: { id: actorId },
    })
    const first = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
    })
    expect(first.created).toBe(true)
    expect(first.detail.scenarioVersionKind).toBe('trial')
    const trialVersionId = first.detail.scenarioVersionId
    const again = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
    })
    expect(again.detail.scenarioVersionId).toBe(trialVersionId)
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        schemaVersion: 1,
        inputs: [],
        steps: [echoStep(newId(), '改了', { input: { value: 't2' } })],
      },
      actor: { id: actorId },
    })
    const old = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: trialVersionId,
      actor: { id: actorId },
      allowTrialVersion: true,
    })
    expect(old.detail.snapshot.steps[0]?.name).toBe('回显')
    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        scenarioVersionId: trialVersionId,
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_VERSION_NOT_PUBLISHED' })
  })

  it('只改运行期约束也要新开 trial 版本，快照带上 runtimeInvariantManifest', async () => {
    const stepId = newId()
    const invariantId = newId()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '试跑约束增量',
      steps: [echoStep(stepId, '回显', { input: { value: 't1' } })],
      actor: { id: actorId },
    })
    const first = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: 1,
      actor: { id: actorId },
    })
    expect(first.detail.snapshot.runtimeInvariantManifest).toBeUndefined()
    const saved = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [{ kind: 'step', step: echoStep(stepId, '回显', { input: { value: 't1' } }) }],
        runtimeInvariants: [createRuntimeInvariant('auth_validity', invariantId)],
      },
      actor: { id: actorId },
    })
    const next = await createTrialRunFromDraft(handle.db, scenario.id, {
      revision: saved.draft!.revision,
      actor: { id: actorId },
    })
    expect(next.detail.scenarioVersionId).not.toBe(first.detail.scenarioVersionId)
    expect(next.detail.snapshot.runtimeInvariantManifest?.entries).toEqual([
      expect.objectContaining({ id: invariantId, kind: 'auth_validity' }),
    ])
  })

  it('缺声明输入值时试跑失败且不落 trial 行', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '缺输入',
      inputs: [{ key: 'orderId', label: '单号' }],
      steps: [echoStep(newId(), '读单号', { input: { from: 'orderId' } })],
      actor: { id: actorId },
    })
    await expect(
      createTrialRunFromDraft(handle.db, scenario.id, { revision: 1, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_UNRESOLVED_REF' })
    const trials = await handle.db
      .select()
      .from(scenarioVersions)
      .where(and(eq(scenarioVersions.scenarioId, scenario.id), eq(scenarioVersions.kind, 'trial')))
    expect(trials).toHaveLength(0)
  })

  it('试跑建 Run 失败时不留下半成品 trial 版本', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '账号不匹配',
      steps: [echoStep(newId(), '回显', { input: { value: 'ok' } })],
      actor: { id: actorId },
    })
    await expect(
      createTrialRunFromDraft(handle.db, scenario.id, {
        revision: 1,
        targetAccountId: newId(),
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'RUN_ACCOUNT_MISMATCH' })
    const trials = await handle.db
      .select()
      .from(scenarioVersions)
      .where(and(eq(scenarioVersions.scenarioId, scenario.id), eq(scenarioVersions.kind, 'trial')))
    expect(trials).toHaveLength(0)
  })

  it('保存放过未解析 from，发布拦截', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '先写 from',
      steps: [echoStep(newId(), '回显', { input: { value: 'x' } })],
      actor: { id: actorId },
    })
    const saved = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        schemaVersion: 1,
        inputs: [],
        steps: [echoStep(newId(), '读单号', { input: { from: 'orderId' } })],
      },
      actor: { id: actorId },
    })
    expect(saved.draft?.revision).toBe(2)
    expect(saved.compile?.ok).toBe(false)
    await expect(
      publishScenarioDraft(handle.db, scenario.id, { revision: 2, actor: { id: actorId } }),
    ).rejects.toMatchObject({ code: 'SCENARIO_COMPILE_BLOCKED' })
  })

  it('挂载成功条件后按 V2 保存，改步骤名不丢契约，V1 覆盖被拒', async () => {
    const stepId = newId()
    const contractId = newId()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '成功条件草稿',
      steps: [echoStep(stepId, '回显', { input: { value: 'x' } })],
      actor: { id: actorId },
    })
    const withOutcome = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1 as const,
      inputs: [],
      nodes: [
        {
          kind: 'step' as const,
          step: echoStep(stepId, '回显', { input: { value: 'x' } }),
          outcomes: [
            {
              id: contractId,
              scope: 'step' as const,
              meaning: '回显成功',
              severity: 'MUST' as const,
              onViolation: 'halt' as const,
              provenance: 'manual' as const,
              rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
            },
          ],
        },
      ],
    }
    const saved = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: withOutcome,
      actor: { id: actorId },
    })
    expect(saved.draft?.revision).toBe(2)
    expect(saved.draft?.document).toMatchObject({ authoringSchemaVersion: 2 })
    const renamed = {
      ...withOutcome,
      nodes: [
        {
          kind: 'step' as const,
          step: {
            id: stepId,
            name: '点击提交',
            type: 'click' as const,
            effectType: 'SIDE_EFFECT' as const,
            input: { target: { framePath: [], candidates: [{ by: 'label' as const, value: '提交' }] } },
          },
          outcomes: withOutcome.nodes[0]!.outcomes,
        },
      ],
    }
    const again = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      document: renamed,
      actor: { id: actorId },
    })
    const node = (again.draft?.document as typeof renamed).nodes[0]
    expect(node?.step.name).toBe('点击提交')
    expect(node?.step.type).toBe('click')
    expect(node?.outcomes?.[0]?.id).toBe(contractId)
    expect(again.compile?.diagnostics.some((item) => item.code === 'SCENARIO_NO_OUTCOME')).toBe(false)
    await expect(
      saveScenarioDraft(handle.db, scenario.id, {
        revision: 2,
        document: {
          ...renamed,
          nodes: [
            {
              ...renamed.nodes[0]!,
              step: { ...renamed.nodes[0]!.step, name: '并发覆盖' },
            },
          ],
        },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT', kind: 'conflict' })
    const latest = await getScenario(handle.db, scenario.id)
    const latestNode = (latest.draft?.document as typeof renamed).nodes[0]
    expect(latestNode?.outcomes?.[0]?.id).toBe(contractId)
    await expect(
      saveScenarioDraft(handle.db, scenario.id, {
        revision: 3,
        document: {
          schemaVersion: 1,
          inputs: [],
          steps: [echoStep(stepId, '旧客户端', { input: { value: 'x' } })],
        },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORING_SCHEMA_UNSUPPORTED' })
  })

  it('挂载运行期约束后按 V2 保存，V1 覆盖被拒', async () => {
    const stepId = newId()
    const invariantId = newId()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '运行期约束草稿',
      steps: [echoStep(stepId, '回显', { input: { value: 'x' } })],
      actor: { id: actorId },
    })
    const withInvariant = {
      authoringSchemaVersion: 2 as const,
      schemaVersion: 1 as const,
      inputs: [],
      nodes: [{ kind: 'step' as const, step: echoStep(stepId, '回显', { input: { value: 'x' } }) }],
      runtimeInvariants: [
        {
          id: invariantId,
          meaning: '不得离开允许的访问范围',
          kind: 'navigation_boundary' as const,
          severity: 'MUST' as const,
          onViolation: 'halt' as const,
          evaluateAt: 'step_boundary' as const,
        },
      ],
    }
    const saved = await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: withInvariant,
      actor: { id: actorId },
    })
    expect(saved.draft?.document).toMatchObject({
      authoringSchemaVersion: 2,
      runtimeInvariants: [{ id: invariantId }],
    })
    await expect(
      saveScenarioDraft(handle.db, scenario.id, {
        revision: saved.draft!.revision,
        document: {
          schemaVersion: 1 as const,
          inputs: [],
          steps: [echoStep(stepId, '回显', { input: { value: 'x' } })],
        },
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORING_SCHEMA_UNSUPPORTED' })
  })
})
