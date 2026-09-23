import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { type ModuleContent } from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { connection, expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'

describe('Action Module Cases & Regression (AMR-04, 05, 06, 10)', { timeout: 30_000 }, () => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  async function setup() {
    const handle = await openContractDb('postgres')
    handles.push(handle)
    const db = expose(handle)
    const rbac = new api.RbacStore(db, { hash: async (v) => v, verify: async (v, h) => v === h })
    const admin = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const account = await rbac.createAccount(
      {
        email: `amc_${newId()}@test.com`,
        displayName: 'AMC 测试账号',
        password: 'Password123!',
        roleIds: [admin.id],
      },
      null,
    )
    const targets = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target = await targets.createTarget(
      {
        loginFields: null,
        authMethod: 'manual',
        captchaMode: 'none',
        status: 'active',
        name: 'AMC 目标',
        code: `AMC_${newId().slice(0, 8)}`,
        entryUrl: 'https://example.com',
      },
      account,
    )
    return { db, account, target }
  }

  function sampleModuleContent(): ModuleContent {
    return {
      contract: {
        inputs: [{ key: 'orderId', label: '订单号', valueType: 'string', required: true }],
        outputs: [{ key: 'orderStatus', label: '订单状态', shape: { kind: 'scalar', type: 'string' } }],
        effectCeiling: 'READ_ONLY',
        preconditions: [],
        postconditions: [{ meaning: '查得状态', verification: { kind: 'output_required', outputKey: 'orderStatus' } }],
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: newId(),
              name: '查订单',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: { value: 'SHIPPED' },
              outputKey: 'status_val',
            },
          ],
          outputMapping: {
            orderStatus: 'status_val',
          },
        },
      ],
    }
  }

  let modSeq = 1
  async function setupModule(db: any, account: any, target: any, key?: string) {
    const validKey = key ?? `order.case${modSeq++}`
    const created = await api.createActionModule(db, {
      idempotencyKey: newId(),
      targetId: target.id,
      key: validKey,
      name: '订单查询模块',
      actor: account,
    })
    const content = sampleModuleContent()
    await api.saveActionModuleDraft(db, created.id, {
      baseRevision: created.draftRevision ?? 0,
      content,
      actor: account,
    })
    const mod = await api.getActionModule(db, created.id)
    return { mod, content }
  }

  function makeReview(account: any, inputs: any, outputs: any, confirmed = true) {
    const rev = api.computeSampleReview(inputs, outputs, confirmed)
    return {
      reviewedBy: account.id,
      reviewedAt: new Date().toISOString(),
      inputsDigest: rev.inputsDigest,
      outputsDigest: rev.outputsDigest,
      confirmed: rev.confirmed,
    }
  }

  it('用例 CRUD 与审阅凭据完整性校验 (AMR-04)', async () => {
    const { db, account, target } = await setup()
    const { mod } = await setupModule(db, account, target)

    const inputs = { orderId: 'ORD-12345' }
    const expectedOutputs = { orderStatus: 'SHIPPED' }
    const sampleReview = makeReview(account, inputs, expectedOutputs)

    // 1. 创建测试用例
    const created = await api.createModuleTestCase(db, mod.id, {
      name: '普通发货单用例',
      inputs,
      expectedModuleOutcome: 'VERIFIED',
      expectedOutputs,
      implementationKey: 'default',
      releaseGate: true,
      sampleReview,
      actor: account,
    })

    expect(created.name).toBe('普通发货单用例')
    expect(created.revision).toBe(1)
    expect(created.status).toBe('ACTIVE')
    expect(created.releaseGate).toBe(true)

    // 2. 伪造/不匹配的 sampleReview 应被拒绝
    await expect(
      api.createModuleTestCase(db, mod.id, {
        name: '篡改用例',
        inputs,
        expectedModuleOutcome: 'VERIFIED',
        expectedOutputs,
        implementationKey: 'default',
        releaseGate: true,
        sampleReview: {
          ...sampleReview,
          inputsDigest: 'tampered-digest',
        },
        actor: account,
      }),
    ).rejects.toThrow('审阅摘要不一致')

    // 3. 读取单个用例
    const fetched = await api.getModuleTestCase(db, mod.id, created.id, account.id)
    expect(fetched.id).toBe(created.id)
    expect(fetched.inputs).toEqual(inputs)

    // 4. 更新用例 (带新审阅凭据)
    const nextInputs = { orderId: 'ORD-99999' }
    const nextReview = makeReview(account, nextInputs, expectedOutputs)

    const updated = await api.updateModuleTestCase(db, mod.id, created.id, {
      revision: created.revision,
      inputs: nextInputs,
      sampleReview: nextReview,
      actor: account,
    })
    expect(updated.revision).toBe(2)
    expect(updated.inputs).toEqual(nextInputs)

    // 5. OCC 冲突校验 (旧 revision 应失败)
    await expect(
      api.updateModuleTestCase(db, mod.id, created.id, {
        revision: 1, // 旧 revision
        name: '冲突改名',
        actor: account,
      }),
    ).rejects.toThrow('测试用例已被他人更新')

    // 6. 列表查询
    const list = await api.listModuleTestCases(db, mod.id, account.id)
    expect(list.items.length).toBe(1)
    expect(list.items[0]!.id).toBe(created.id)
    expect(list.items[0]!.revision).toBe(2)

    // 7. 删除用例 (软删除)
    await api.deleteModuleTestCase(db, mod.id, created.id, account)
    const listAfterDelete = await api.listModuleTestCases(db, mod.id, account.id)
    expect(listAfterDelete.items.length).toBe(0)
  })

  it('执行用例、不可变快照与结算比较 (AMR-04, AMR-05)', async () => {
    const { db, account, target } = await setup()
    const { mod } = await setupModule(db, account, target)

    const inputs = { orderId: 'ORD-100' }
    const expectedOutputs = { orderStatus: 'SHIPPED' }
    const sampleReview = makeReview(account, inputs, expectedOutputs)

    const testCase = await api.createModuleTestCase(db, mod.id, {
      name: '正向用例',
      inputs,
      expectedModuleOutcome: 'VERIFIED',
      expectedOutputs,
      implementationKey: 'default',
      releaseGate: true,
      sampleReview,
      actor: account,
    })

    // 发起试跑
    const { execution, run } = await api.runModuleTestCase(db, mod.id, testCase.id, {
      actor: account,
    })

    expect(execution.caseId).toBe(testCase.id)
    expect(execution.frozenInputs).toEqual(inputs)
    expect(execution.frozenExpectedOutputs).toEqual(expectedOutputs)
    expect(run.id).toBe(execution.runId)

    // 初始结果为 PENDING
    const initialCase = await api.getModuleTestCase(db, mod.id, testCase.id, account.id)
    expect(initialCase.latestResult?.status).toBe('PENDING')

    // 模拟 Engine 运行结束：设置 context 与 status
    const conn = connection(db)
    const { runs, moduleInvocationResults } = schemaFor(conn)
    await conn
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        context: { orderStatus: 'SHIPPED' },
        finishedAt: new Date(),
      })
      .where(eq(runs.id, run.id))

    await conn.insert(moduleInvocationResults).values({
      id: newId(),
      runId: run.id,
      invocationId: newId(),
      projectorVersion: 1,
      moduleId: mod.id,
      moduleDraftRevision: mod.draftRevision,
      runKind: 'trial',
      targetId: target.id,
      outcome: 'VERIFIED',
      attribution: 'UNKNOWN',
      verificationStrength: 'sufficient',
      sourceRunEventSeq: 1,
    })

    // 执行结算
    await api.settleModuleCaseResult(db, run.id)

    // 验证结算结果 PASS
    const settledCase = await api.getModuleTestCase(db, mod.id, testCase.id, account.id)
    expect(settledCase.latestResult?.status).toBe('PASS')
    expect(settledCase.latestResult?.outcomeMatched).toBe(true)
    expect(settledCase.latestResult?.outputsMatched).toBe(true)
    expect(settledCase.latestResult?.evidenceComplete).toBe(true)

    // 验证重算 (Recompute) 生成新修订版本
    const recomputed = await api.recomputeModuleCaseResult(db, execution.id, account.id)
    expect(recomputed.revision).toBe(2)
    expect(recomputed.status).toBe('PASS')
  })

  it('预期输出不匹配时结算为 FAIL (AMR-05)', async () => {
    const { db, account, target } = await setup()
    const { mod } = await setupModule(db, account, target)

    const inputs = { orderId: 'ORD-MISMATCH' }
    const expectedOutputs = { orderStatus: 'DELIVERED' } // 期望 DELIVERED
    const sampleReview = makeReview(account, inputs, expectedOutputs)

    const testCase = await api.createModuleTestCase(db, mod.id, {
      name: '预期交付用例',
      inputs,
      expectedModuleOutcome: 'VERIFIED',
      expectedOutputs,
      implementationKey: 'default',
      releaseGate: true,
      sampleReview,
      actor: account,
    })

    const { execution, run } = await api.runModuleTestCase(db, mod.id, testCase.id, {
      actor: account,
    })

    const conn = connection(db)
    const { runs, moduleInvocationResults } = schemaFor(conn)
    // 实际 context 中 orderStatus 是 SHIPPED（不匹配）
    await conn
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        context: { orderStatus: 'SHIPPED' },
        finishedAt: new Date(),
      })
      .where(eq(runs.id, run.id))

    await conn.insert(moduleInvocationResults).values({
      id: newId(),
      runId: run.id,
      invocationId: newId(),
      projectorVersion: 1,
      moduleId: mod.id,
      moduleDraftRevision: mod.draftRevision,
      runKind: 'trial',
      targetId: target.id,
      outcome: 'VERIFIED',
      attribution: 'UNKNOWN',
      verificationStrength: 'sufficient',
      sourceRunEventSeq: 1,
    })

    await api.settleModuleCaseResult(db, run.id)

    const settledCase = await api.getModuleTestCase(db, mod.id, testCase.id, account.id)
    expect(settledCase.latestResult?.status).toBe('FAIL')
    expect(settledCase.latestResult?.outputsMatched).toBe(false)
    expect(settledCase.latestResult?.failureReason).toContain('输出不匹配')
  })

  it('批量回归 20 例限制与执行聚合 (AMR-06)', async () => {
    const { db, account, target } = await setup()
    const { mod } = await setupModule(db, account, target)

    // 创建 2 条测试用例
    const caseIds: string[] = []
    for (let i = 1; i <= 2; i++) {
      const inputs = { orderId: `ORD-${i}` }
      const expectedOutputs = { orderStatus: 'SHIPPED' }
      const c = await api.createModuleTestCase(db, mod.id, {
        name: `用例 ${i}`,
        inputs,
        expectedModuleOutcome: 'VERIFIED',
        expectedOutputs,
        implementationKey: 'default',
        releaseGate: true,
        sampleReview: makeReview(account, inputs, expectedOutputs),
        actor: account,
      })
      caseIds.push(c.id)
    }

    // 尝试传入超过 20 例应抛错
    const fake21Cases = Array.from({ length: 21 }, () => newId())
    await expect(
      api.createModuleTestBatch(db, mod.id, {
        caseIds: fake21Cases,
        confirmedBy: {
          confirmedTargetEnvironment: 'test',
          confirmedIsolationMode: 'sample_only',
        },
        actor: account,
      }),
    ).rejects.toThrow('批量回归每次最多执行 20 条用例')

    // 发起正常 2 例批量
    const batch = await api.createModuleTestBatch(db, mod.id, {
      caseIds,
      confirmedBy: {
        confirmedTargetEnvironment: 'staging',
        confirmedIsolationMode: 'sandbox_account',
      },
      actor: account,
    })

    expect(batch.totalCases).toBe(2)
    expect(batch.status).toBe('RUNNING')
    expect(batch.caseExecutionIds.length).toBe(2)

    // 读取批次详情
    const detail = await api.getModuleTestBatch(db, mod.id, batch.id, account.id)
    expect(detail.id).toBe(batch.id)
    expect(detail.executions.length).toBe(2)
  })

  it('发布门禁拦截与正向 releaseGate 放行 (AMR-10)', async () => {
    const { db, account, target } = await setup()
    const { mod, content } = await setupModule(db, account, target)

    // 1. 无用例时发布，被 assertReleaseGateSatisfied 拦截
    await expect(
      api.assertReleaseGateSatisfied(db, mod.id, content),
    ).rejects.toThrow('发布门禁未通过')

    // 2. 创建 releaseGate 用例
    const inputs = { orderId: 'ORD-GATE' }
    const expectedOutputs = { orderStatus: 'SHIPPED' }
    const testCase = await api.createModuleTestCase(db, mod.id, {
      name: '门禁正向用例',
      inputs,
      expectedModuleOutcome: 'VERIFIED',
      expectedOutputs,
      implementationKey: 'default',
      releaseGate: true,
      sampleReview: makeReview(account, inputs, expectedOutputs),
      actor: account,
    })

    // 3. 执行并结算为 PASS
    const { run } = await api.runModuleTestCase(db, mod.id, testCase.id, { actor: account })
    const conn = connection(db)
    const { runs, moduleInvocationResults } = schemaFor(conn)
    await conn
      .update(runs)
      .set({
        status: 'SUCCEEDED',
        context: { orderStatus: 'SHIPPED' },
        finishedAt: new Date(),
      })
      .where(eq(runs.id, run.id))

    await conn.insert(moduleInvocationResults).values({
      id: newId(),
      runId: run.id,
      invocationId: newId(),
      projectorVersion: 1,
      moduleId: mod.id,
      moduleDraftRevision: mod.draftRevision,
      runKind: 'trial',
      targetId: target.id,
      outcome: 'VERIFIED',
      attribution: 'UNKNOWN',
      verificationStrength: 'sufficient',
      sourceRunEventSeq: 1,
    })

    await api.settleModuleCaseResult(db, run.id)

    // 4. 门禁验证通过，不抛错
    await expect(api.assertReleaseGateSatisfied(db, mod.id, content)).resolves.not.toThrow()
  })
})
