import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTargetBodySchema } from '@cairn/shared'
import * as api from '../index.js'
import { schemaFor } from '../native.js'
import { openContractDb } from './contract-fixture.js'
import { newId } from '../id.js'

describe('目标系统与运行附件异步清理审计结算', () => {
  it('清理完成后自动结算审计事件且不重复落盘', async () => {
    const handle = await openContractDb('postgres')
    try {
      const db = handle.db
      const { targets, artifacts, storedObjects, consoleAuditEvents, consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(db)
      const actorId = newId()
      await db.insert(consoleAccounts).values({
        id: actorId,
        displayName: '清理测试员',
        email: `cleanup-${actorId}@example.com`,
        status: 'active',
      })
      const [admin] = await db.select({ id: consoleRoles.id }).from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
      await db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })

      const actor = {
        id: actorId,
        displayName: '清理测试员',
        email: `cleanup-${actorId}@example.com`,
        status: 'active' as const,
        roles: [],
        permissions: [],
      }

      // 1. 创建目标系统
      const targetsStore = new api.TargetsStore(handle, () => Buffer.from('test'))
      const target = await targetsStore.createTarget(
        createTargetBodySchema.parse({
          code: `test-cleanup-${newId().slice(0, 8)}`,
          name: '清理测试系统',
          entryUrl: 'https://example.test',
        }),
        actor,
      )

      // 2. 模拟关联的 artifact 与 storedObjects
      const artifactId1 = newId()
      const artifactId2 = newId()
      const objectId1 = newId()
      const objectId2 = newId()

      await db.insert(artifacts).values([
        {
          id: artifactId1,
          targetId: target.id,
          kind: 'brand_logo',
          fileName: 'logo1.png',
          contentType: 'image/png',
          retainUntil: new Date(Date.now() + 86400000),
        },
        {
          id: artifactId2,
          targetId: target.id,
          kind: 'brand_logo',
          fileName: 'logo2.png',
          contentType: 'image/png',
          retainUntil: new Date(Date.now() + 86400000),
        },
      ])

      await db.insert(storedObjects).values([
        {
          id: objectId1,
          artifactId: artifactId1,
          objectKey: `targets/${target.id}/obj1.bin`,
          status: 'available',
          ownerKind: 'artifact',
          byteSize: 1024,
          retainUntil: new Date(Date.now() + 86400000),
          createdAt: new Date(),
        },
        {
          id: objectId2,
          artifactId: artifactId2,
          objectKey: `targets/${target.id}/obj2.bin`,
          status: 'available',
          ownerKind: 'artifact',
          byteSize: 2048,
          retainUntil: new Date(Date.now() + 86400000),
          createdAt: new Date(),
        },
      ])

      // 3. 删除目标
      await targetsStore.deleteTarget(target.id, actor)

      // 4. 对象尚未 purged 时，settleTargetCleanups 暂不结算
      const initialSettle = await api.settleTargetCleanups(handle)
      expect(initialSettle.settled).toBe(0)

      // 5. 模拟 Worker 处理并标记所有对象为 purged
      await db
        .update(storedObjects)
        .set({ status: 'purged', purgedAt: new Date() })
        .where(eq(storedObjects.id, objectId1))
      await db
        .update(storedObjects)
        .set({ status: 'purged', purgedAt: new Date() })
        .where(eq(storedObjects.id, objectId2))

      // 6. 执行结算，应成功结算 1 个目标并写入审计日志
      const settled = await api.settleTargetCleanups(handle)
      expect(settled.settled).toBe(1)

      // 7. 检查审计日志详情
      const auditRows = await db
        .select()
        .from(consoleAuditEvents)
        .where(eq(consoleAuditEvents.resourceId, target.id))

      const cleanupAudit = auditRows.find((r) => r.action === 'target.cleanup')
      expect(cleanupAudit).toBeDefined()
      expect(cleanupAudit?.summary).toContain('已清理 2 个附件对象')
      expect(cleanupAudit?.summary).toContain('3.00 KB')

      // 8. 再次结算不重复写入
      const recheck = await api.settleTargetCleanups(handle)
      expect(recheck.settled).toBe(0)
    } finally {
      await handle.close()
    }
  })
})
