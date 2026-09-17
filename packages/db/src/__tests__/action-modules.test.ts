import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { compileModuleContent } from '@cairn/authoring'
import {
  moduleWarningKey,
  type ModuleContent,
} from '@cairn/shared'
import { newId } from '../id.js'
import * as api from '../index.js'
import { expose, connection } from '../database.js'
import { schemaFor } from '../native.js'
import { exportDatabase, importDatabase } from '../transfer.js'
import { DRIVERS, type ContractDriver, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

describe('AM-A: 动作模块数据库持久化 (A3)', { timeout: 30_000 }, () => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  async function setupFixture(driver: ContractDriver = 'postgres') {
    const handle = await openContractDb(driver)
    handles.push(handle)
    const db = expose(handle)

    // 创建管理员账号和目标系统
    const rbac = new api.RbacStore(db, {
      hash: async (v) => v,
      verify: async (v, h) => v === h,
    })
    const admin = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    const account = await rbac.createAccount({
      email: `user_${newId()}@test.com`,
      displayName: '测试编写者',
      password: 'Password123!',
      roleIds: [admin.id],
    }, null)

    const targetsStore = new api.TargetsStore(db, () => Buffer.from('fixture'))
    const target1 = await targetsStore.createTarget(
      {
        loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
        name: '测试目标1',
        code: `T1_${newId().slice(0, 8)}`,
        entryUrl: 'https://example.com/app',
      },
      account,
    )

    const target2 = await targetsStore.createTarget(
      {
        loginFields: null, authMethod: 'manual', captchaMode: 'none', status: 'active',
        name: '测试目标2',
        code: `T2_${newId().slice(0, 8)}`,
        entryUrl: 'https://example.com/app2',
      },
      account,
    )

    return { db, account, target1, target2, handle }
  }

  const validContent: ModuleContent = {
    contract: {
      inputs: [],
      outputs: [
        { key: 'status', label: '状态', shape: { kind: 'scalar', type: 'string' } },
      ],
      effectCeiling: 'READ_ONLY',
      preconditions: [],
      postconditions: [
        {
          meaning: '检查状态已输出',
          verification: { kind: 'output_required', outputKey: 'status' },
        },
      ],
    },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps: [
          {
            id: newId(),
            name: '提取状态',
            type: 'extract',
            effectType: 'READ_ONLY',
            outputKey: 'internalStatus',
            input: {
              target: {
                framePath: [],
                candidates: [{ by: 'text', value: '订单状态' }],
              },
              as: 'text',
            },
          },
          {
            id: newId(),
            name: '断言状态可见',
            type: 'assert',
            effectType: 'READ_ONLY',
            input: {
              expect: {
                kind: 'text_contains',
                value: '已完成',
              },
            },
          },
        ],
        outputMapping: {
          status: 'internalStatus',
        },
      },
    ],
  }

  it('完整生命周期：创建 -> 获取 -> 修改元数据 -> 保存草稿 -> 发布 -> 列出版本', async () => {
    const { db, account, target1 } = await setupFixture()

    // 1. 创建动作模块
    const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
      targetId: target1.id,
      key: 'order.query',
      name: '查询订单',
      description: '根据订单号查询详情',
      capabilityKey: 'order_mgmt',
      actor: { id: account.id },
    })

    expect(created.id).toBeDefined()
    expect(created.key).toBe('order.query')
    expect(created.name).toBe('查询订单')
    expect(created.draftRevision).toBe(0)
    expect(created.draftContent).toBeNull()
    expect(created.latestVersionNo).toBeNull()

    // 2. 更新元数据
    const updated = await api.updateActionModuleMeta(db, created.id, {
        baseRevision: 0,
      name: '查询订单详情',
      tags: ['订单', '只读'],
      aliases: ['订单查询', '查单'],
      actor: { id: account.id },
    })
    expect(updated.name).toBe('查询订单详情')
    expect(updated.tags).toEqual(['订单', '只读'])
    expect(updated.aliases).toEqual(['订单查询', '查单'])

    // 3. 保存草稿
    const draftSaved = await api.saveActionModuleDraft(db, created.id, {
      baseRevision: 1,
      content: validContent,
      actor: { id: account.id },
    })
    expect(draftSaved.draftRevision).toBe(2)
    expect(draftSaved.draftContent).toBeDefined()
    expect(draftSaved.compile?.ok).toBe(true)

    // 4. 发布
    const published = await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
      expectedRevision: 2,
      actor: { id: account.id },
    })
    expect(published.latestVersionNo).toBe(1)
    expect(published.executionMode).toBe('DETERMINISTIC')
    expect(published.effectCeiling).toBe('READ_ONLY')
    expect(published.publicationStatus).toBe('published')

    // 5. 版本列表
    const versions = await api.listActionModuleVersions(db, created.id)
    expect(versions.items.length).toBe(1)
    expect(versions.items[0]!.versionNo).toBe(1)
    expect(versions.items[0]!.contentDigest).toBeDefined()

    // 6. 获取单个版本
    const version1 = await api.getActionModuleVersion(db, created.id, versions.items[0]!.id)
    expect(version1.versionNo).toBe(1)
    expect(version1.contractDigest).toBeDefined()
  })

  describe('AMA-06: 草稿 OCC', () => {
    it('基于过期 revision 保存草稿触发 MODULE_DRAFT_CONFLICT', async () => {
      const { db, account, target1 } = await setupFixture()

      const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'order.occ',
        name: 'OCC测试',
        actor: { id: account.id },
      })

      // 客户端 1 保存 r0 -> r1
      await api.saveActionModuleDraft(db, created.id, {
        baseRevision: 0,
        content: validContent,
        actor: { id: account.id },
      })

      // 客户端 2 仍基于 r0 保存 -> 冲突
      await expect(
        api.saveActionModuleDraft(db, created.id, {
          baseRevision: 0,
          content: validContent,
          actor: { id: account.id },
        }),
      ).rejects.toThrow(/草稿已被他人更新/)
    })
  })

  describe('AMA-07: 发布不可变与幂等', () => {
    it('相同内容与 revision 重复发布幂等返回同一版本，修改后发布增加版本号', async () => {
      const { db, account, target1 } = await setupFixture()

      const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'order.idempotent',
        name: '幂等测试',
        actor: { id: account.id },
      })

      await api.saveActionModuleDraft(db, created.id, {
        baseRevision: 0,
        content: validContent,
        actor: { id: account.id },
      })

      // 首次发布 -> v1
      const pub1 = await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
        expectedRevision: 1,
        actor: { id: account.id },
      })
      expect(pub1.latestVersionNo).toBe(1)

      // 再次发布同一 revision -> 幂等，依然是 v1
      const pub2 = await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
        expectedRevision: 1,
        actor: { id: account.id },
      })
      expect(pub2.latestVersionNo).toBe(1)

      const versionsAfterDup = await api.listActionModuleVersions(db, created.id)
      expect(versionsAfterDup.items.length).toBe(1)

      // 保存新草稿 -> r2
      const modifiedContent: ModuleContent = {
        ...validContent,
        contract: {
          ...validContent.contract,
          inputs: [
            ...validContent.contract.inputs,
            { key: 'extraNote', label: '备注', valueType: 'string', required: false },
          ],
        },
      }
      await api.saveActionModuleDraft(db, created.id, {
        baseRevision: 1,
        content: modifiedContent,
        actor: { id: account.id },
      })

      // 发布新草稿 -> v2
      const pub3 = await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
        expectedRevision: 2,
        confirmedWarnings: compileModuleContent(modifiedContent, { mode: 'release' }).diagnostics.filter((d) => d.severity === 'warning').map(moduleWarningKey),
        actor: { id: account.id },
      })
      expect(pub3.latestVersionNo).toBe(2)

      const versionsAfterV2 = await api.listActionModuleVersions(db, created.id)
      expect(versionsAfterV2.items.length).toBe(2)
      expect(versionsAfterV2.items[0]!.versionNo).toBe(2)
      expect(versionsAfterV2.items[1]!.versionNo).toBe(1)
    })
  })

  describe('AMA-08 & AMA-10: Target 边界与唯一约束', () => {
    it('同一 Target 下同名 key 报错 MODULE_KEY_DUPLICATE，不同 Target 下允许同名 key', async () => {
      const { db, account, target1, target2 } = await setupFixture()

      await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'common.action',
        name: '通用动作1',
        actor: { id: account.id },
      })

      // 同一 Target 重复 key 报错
      await expect(
        api.createActionModule(db, {
        idempotencyKey: newId(),
          targetId: target1.id,
          key: 'common.action',
          name: '重复动作',
          actor: { id: account.id },
        }),
      ).rejects.toThrow(/模块 key 已存在/)

      // 不同 Target 允许同名 key
      const t2Module = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target2.id,
        key: 'common.action',
        name: '目标2通用动作',
        actor: { id: account.id },
      })
      expect(t2Module.id).toBeDefined()
      expect(t2Module.targetId).toBe(target2.id)
    })
  })

  describe('AMA-09: 删除约束', () => {
    it('从未发布过版本的模块允许软删除', async () => {
      const { db, account, target1 } = await setupFixture()

      const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'to.delete',
        name: '待删除模块',
        actor: { id: account.id },
      })

      await api.deleteActionModule(db, created.id, { id: account.id })

      await expect(api.getActionModule(db, created.id)).rejects.toThrow(/不存在/)
    })

    it('已发布但无用户引用的模块可以软删除', async () => {
      const { db, account, target1 } = await setupFixture()

      const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'has.version',
        name: '有版本模块',
        actor: { id: account.id },
      })

      await api.saveActionModuleDraft(db, created.id, {
        baseRevision: 0,
        content: validContent,
        actor: { id: account.id },
      })

      await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
        expectedRevision: 1,
        actor: { id: account.id },
      })

      const deleted = await api.deleteActionModule(db, created.id, { id: account.id })
      expect(deleted.id).toBe(created.id)
      await expect(api.getActionModule(db, created.id)).rejects.toThrow(/不存在/)
    })
  })

  describe('动作库服务端筛选与分页', () => {
    it('按 Target、标签、能力键、搜索词进行过滤与分页', async () => {
      const { db, account, target1 } = await setupFixture()

      const m1 = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'order.search',
        name: '订单搜索',
        capabilityKey: 'order',
        actor: { id: account.id },
      })
      await api.updateActionModuleMeta(db, m1.id, {
        baseRevision: 0,
        tags: ['core', 'search'],
        actor: { id: account.id },
      })

      const m2 = await api.createActionModule(db, {
        idempotencyKey: newId(),
        targetId: target1.id,
        key: 'user.search',
        name: '用户搜索',
        capabilityKey: 'user',
        actor: { id: account.id },
      })
      await api.updateActionModuleMeta(db, m2.id, {
        baseRevision: 0,
        tags: ['user'],
        actor: { id: account.id },
      })

      // 查全部
      const all = await api.listActionModules(db, { targetId: target1.id })
      expect(all.total).toBe(2)

      // 搜索 q
      const qRes = await api.listActionModules(db, { targetId: target1.id, q: '订单' })
      expect(qRes.total).toBe(1)
      expect(qRes.items[0]!.key).toBe('order.search')

      // 筛选 capabilityKey
      const capRes = await api.listActionModules(db, { targetId: target1.id, capabilityKey: 'user' })
      expect(capRes.total).toBe(1)
      expect(capRes.items[0]!.key).toBe('user.search')

      // 筛选 tag
      const tagRes = await api.listActionModules(db, { targetId: target1.id, tag: 'core' })
      expect(tagRes.total).toBe(1)
      expect(tagRes.items[0]!.key).toBe('order.search')

      // 分页
      const paged = await api.listActionModules(db, { targetId: target1.id, page: 1, pageSize: 1 })
      expect(paged.total).toBe(2)
      expect(paged.items.length).toBe(1)
    })
  })

  it.each(DRIVERS)('%s 驱动下动作模块创建、草稿、发布与查询一致性', async (driver) => {
    const { db, account, target1 } = await setupFixture(driver)

    const created = await api.createActionModule(db, {
        idempotencyKey: newId(),
      targetId: target1.id,
      key: 'pg.test',
      name: 'PG动作模块',
      actor: { id: account.id },
    })
    expect(created.id).toBeDefined()

    await api.saveActionModuleDraft(db, created.id, {
      baseRevision: 0,
      content: validContent,
      actor: { id: account.id },
    })

    const published = await api.publishActionModule(db, created.id, {
        idempotencyKey: newId(),
      expectedRevision: 1,
      actor: { id: account.id },
    })
    expect(published.latestVersionNo).toBe(1)

    const list = await api.listActionModules(db, { targetId: target1.id, q: 'PG' })
    expect(list.total).toBe(1)
    expect(list.items[0]!.key).toBe('pg.test')
  })
  describe.each(DRIVERS)('%s review regressions', (driver) => {
    it('数据库直接写入仍受模块键、版本号唯一约束与外键限制', async () => {
      const { db, account, target1 } = await setupFixture(driver)
      const actor = { id: account.id }
      const module = await api.createActionModule(db, { targetId: target1.id, key: 'review.constraints', name: '约束验证', idempotencyKey: newId(), actor })
      await api.saveActionModuleDraft(db, module.id, { baseRevision: 0, content: validContent, actor })
      await api.publishActionModule(db, module.id, { expectedRevision: 1, idempotencyKey: newId(), actor })
      const native = connection(db)
      const { actionModules, actionModuleVersions, actionModuleReceipts, targets } = schemaFor(native)
      const [row] = await native.select().from(actionModules).where(eq(actionModules.id, module.id))
      const [version] = await native.select().from(actionModuleVersions).where(eq(actionModuleVersions.moduleId, module.id))
      if (!row || !version) throw new Error('模块约束测试夹具未建立')
      await expect(native.insert(actionModules).values({ ...row, id: newId() })).rejects.toThrow()
      await expect(native.insert(actionModules).values({ ...row, id: newId(), targetId: newId() })).rejects.toThrow()
      await expect(native.insert(actionModuleVersions).values({ ...version, id: newId() })).rejects.toThrow()
      await expect(native.insert(actionModuleVersions).values({ ...version, id: newId(), moduleId: newId() })).rejects.toThrow()
      await expect(native.delete(targets).where(eq(targets.id, target1.id))).rejects.toThrow()
      // 去掉回执的外键，单独验证已发布版本对模块的 restrict。
      await native.delete(actionModuleReceipts).where(eq(actionModuleReceipts.moduleId, module.id))
      await expect(native.delete(actionModules).where(eq(actionModules.id, module.id))).rejects.toThrow()
      expect((await api.listActionModuleVersions(db, module.id)).items).toHaveLength(1)
    })
    it('持久化幂等、并发 OCC、摘要复算与历史版本不可变', async () => {
      const { db, account, target1 } = await setupFixture(driver)
      const actor = { id: account.id }
      const body = { targetId: target1.id, key: 'review.core', name: '复查', idempotencyKey: newId(), actor }
      const [created, retry] = await Promise.all([api.createActionModule(db, body), api.createActionModule(db, body)])
      expect(retry).toEqual(created)
      await expect(api.createActionModule(db, { ...body, name: 'changed' })).rejects.toMatchObject({ code: 'MODULE_IDEMPOTENCY_CONFLICT' })
      const saves = await Promise.allSettled([
        api.saveActionModuleDraft(db, created.id, { baseRevision: 0, content: validContent, actor }),
        api.updateActionModuleMeta(db, created.id, { baseRevision: 0, name: 'Concurrent', actor }),
      ])
      expect(saves.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(saves.filter((r) => r.status === 'rejected')).toHaveLength(1)
      const current = await api.getActionModule(db, created.id)
      const saved = await api.saveActionModuleDraft(db, created.id, { baseRevision: current.draftRevision!, content: validContent, actor })
      const publish = { expectedRevision: saved.draftRevision!, idempotencyKey: newId(), actor }
      const [first, same] = await Promise.all([api.publishActionModule(db, created.id, publish), api.publishActionModule(db, created.id, publish)])
      expect(same).toEqual(first)
      const version = (await api.listActionModuleVersions(db, created.id)).items[0]!
      expect(version.contentDigest).toBe(api.computeContentDigest(version.content))
      expect(version.contractDigest).toBe(api.computeContractDigest(version.content.contract))
      expect(version.implementationDigest).toBe(api.computeImplementationDigest(version.content.implementations))
      const modified = structuredClone(validContent); modified.implementations[0]!.steps[0]!.name = '新版提取'
      const next = await api.saveActionModuleDraft(db, created.id, { baseRevision: saved.draftRevision!, content: modified, actor })
      await api.publishActionModule(db, created.id, { expectedRevision: next.draftRevision!, idempotencyKey: newId(), actor })
      expect(await api.publishActionModule(db, created.id, publish)).toEqual(first)
      expect((await api.listActionModuleVersions(db, created.id)).items).toHaveLength(2)
      expect(await api.getActionModuleVersion(db, created.id, version.id)).toEqual(version)
    })
    it('别名/特殊字符标签精确筛选、版本字段分页以及 Target 删除级联', async () => {
      const { db, account, target1 } = await setupFixture(driver)
      const actor = { id: account.id }
      const created = await api.createActionModule(db, { targetId: target1.id, key: 'review.filter', name: '可检索模块', idempotencyKey: newId(), actor })
      await api.updateActionModuleMeta(db, created.id, { baseRevision: 0, tags: ['a%b_"'], aliases: ['查询复查专用别名'], actor })
      await api.saveActionModuleDraft(db, created.id, { baseRevision: 1, content: validContent, actor })
      await api.publishActionModule(db, created.id, { expectedRevision: 2, idempotencyKey: newId(), actor })
      expect((await api.listActionModules(db, { q: '  复查专用别名  ', tag: 'a%b_"', executionMode: 'DETERMINISTIC', publication: 'published', pageSize: 1 })).total).toBe(1)
      expect((await api.listActionModules(db, { tag: '%' })).total).toBe(0)
      expect((await api.listActionModules(db, { q: '%' })).total).toBe(0)
      expect((await api.listActionModules(db, { page: 2, pageSize: 1 })).items).toHaveLength(0)
      const v = (await api.listActionModuleVersions(db, created.id)).items[0]!
      await new api.TargetsStore(db, () => Buffer.from('fixture')).deleteTarget(target1.id, account)
      expect((await api.listActionModules(db, {})).total).toBe(0)
      await expect(api.getActionModuleVersion(db, created.id, v.id)).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
      await expect(api.saveActionModuleDraft(db, created.id, { baseRevision: 2, content: validContent, actor })).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
      await expect(api.publishActionModule(db, created.id, { expectedRevision: 2, idempotencyKey: newId(), actor })).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
    })
    it('关闭的 AI 能力阻断发布；逐条警告不能用诊断码或过期集合确认', async () => {
      const { db, account, target1 } = await setupFixture(driver)
      const actor = { id: account.id }
      const created = await api.createActionModule(db, { targetId: target1.id, key: 'review.gates', name: '发布闸门', idempotencyKey: newId(), actor })
      const c = structuredClone(validContent)
      c.implementations[0]!.steps.push({ id: newId(), type: 'ai_assert', name: 'AI 校验', effectType: 'READ_ONLY', input: { instruction: '页面正确' } })
      await api.saveActionModuleDraft(db, created.id, { baseRevision: 0, content: c, actor })
      await expect(api.publishActionModule(db, created.id, { expectedRevision: 1, idempotencyKey: newId(), actor })).rejects.toMatchObject({ code: 'MODULE_COMPILE_BLOCKED' })
      const warned = structuredClone(validContent)
      warned.contract.inputs = ['a', 'b'].map((key) => ({ key, label: key, required: false, valueType: 'string' }))
      await api.saveActionModuleDraft(db, created.id, { baseRevision: 1, content: warned, actor })
      const warnings = compileModuleContent(warned, { mode: 'release' }).diagnostics.filter((d) => d.severity === 'warning').map(moduleWarningKey)
      expect(new Set(warnings).size).toBe(2)
      for (const confirmedWarnings of [['MODULE_INPUT_UNUSED'], warnings.slice(0, 1), [...warnings, 'stale']]) {
        await expect(api.publishActionModule(db, created.id, { expectedRevision: 2, idempotencyKey: newId(), confirmedWarnings, actor })).rejects.toMatchObject({ code: 'MODULE_WARNINGS_NOT_CONFIRMED' })
      }
      expect((await api.publishActionModule(db, created.id, { expectedRevision: 2, idempotencyKey: newId(), confirmedWarnings: warnings, actor })).latestVersionNo).toBe(1)
    })
  })

  it.runIf(DRIVERS.includes('mysql'))('模块、不可变版本与幂等回执在支持后端间完整保留', async () => {
    const { db, account, target1, handle } = await setupFixture('postgres')
    const actor = { id: account.id }
    const body = { targetId: target1.id, key: 'review.transfer', name: '迁移模块', idempotencyKey: newId(), actor }
    const created = await api.createActionModule(db, body)
    await api.saveActionModuleDraft(db, created.id, { baseRevision: 0, content: validContent, actor })
    const pubBody = { expectedRevision: 1, idempotencyKey: newId(), actor }
    const published = await api.publishActionModule(db, created.id, pubBody)
    const options = { writersStopped: true as const, allowMillisecondPrecisionLoss: true }
    const archive = await exportDatabase(db, handle.env, options)
    expect(archive.tables.actionModules).toHaveLength(1)
    expect(archive.tables.actionModuleVersions).toHaveLength(1)
    expect(archive.tables.actionModuleReceipts).toHaveLength(2)
    const destination = await openContractDb('mysql'); handles.push(destination)
    const imported = expose(destination)
    await importDatabase(imported, destination.env, archive, options)
    expect(await api.publishActionModule(imported, created.id, pubBody)).toEqual(published)
    expect(await api.createActionModule(imported, body)).toEqual(created)
    expect((await api.listActionModuleVersions(imported, created.id)).items[0]!.contentDigest).toBe(api.computeContentDigest(validContent))
  })

})
