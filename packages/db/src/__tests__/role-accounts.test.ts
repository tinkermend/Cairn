import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

describe('角色成员关联 (RbacStore role accounts)', { timeout: 30_000 }, () => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  it('addRoleAccounts, listRoleAccounts 和 removeRoleAccounts 满足幂等性与安全不变量', async () => {
    const handle = await openContractDb('postgres')
    handles.push(handle)
    const db = expose(handle)
    const rbac = new api.RbacStore(db, {
      hash: async (value: string) => value,
      verify: async (value: string, hash: string) => value === hash,
    })

    const roles = await rbac.listRoles()
    const adminRole = roles.items.find((r) => r.key === 'admin')
    const operatorRole = roles.items.find((r) => r.key === 'operator')
    expect(adminRole).toBeDefined()
    expect(operatorRole).toBeDefined()

    // 创建测试账号
    const admin1 = await rbac.createAccount({
      displayName: 'Admin One',
      email: 'admin1@cairn.dev',
      password: 'password123',
      status: 'active',
      roleIds: [adminRole!.id],
    })
    const admin2 = await rbac.createAccount({
      displayName: 'Admin Two',
      email: 'admin2@cairn.dev',
      password: 'password123',
      status: 'active',
      roleIds: [adminRole!.id],
    })
    const normalUser = await rbac.createAccount({
      displayName: 'Normal User',
      email: 'user@cairn.dev',
      password: 'password123',
      status: 'active',
      roleIds: [operatorRole!.id],
    })

    const actor = {
      id: admin1.id,
      displayName: admin1.displayName,
      email: admin1.email,
      permissions: [...PERMISSIONS],
    }

    // 1. 幂等为 admin 绑定 admin1（已有）
    const idempotentAdd = await rbac.addRoleAccounts(
      adminRole!.id,
      { accountIds: [admin1.id] },
      actor,
    )
    expect(idempotentAdd.addedCount).toBe(0)

    // 2. 为 operator 批量添加 admin1 和 admin2
    const addOpRes = await rbac.addRoleAccounts(
      operatorRole!.id,
      { accountIds: [admin1.id, admin2.id] },
      actor,
    )
    expect(addOpRes.addedCount).toBe(2)

    // 3. 查询 operator 的成员列表并分页/搜索
    const opMembers = await rbac.listRoleAccounts(operatorRole!.id, { limit: 10 })
    expect(opMembers.items.length).toBeGreaterThanOrEqual(3) // normalUser, admin1, admin2
    expect(opMembers.items.some((m) => m.id === admin1.id)).toBe(true)

    const searchRes = await rbac.listRoleAccounts(operatorRole!.id, { search: 'Admin Two' })
    expect(searchRes.items).toHaveLength(1)
    expect(searchRes.items[0].displayName).toBe('Admin Two')

    // 4. 从 operator 角色移出 admin2
    const removeOp = await rbac.removeRoleAccounts(
      operatorRole!.id,
      { accountIds: [admin2.id] },
      actor,
    )
    expect(removeOp.removedCount).toBe(1)

    // 5. 移出 admin2 的 admin 角色（还剩 admin1，成功）
    const removeAdmin2 = await rbac.removeRoleAccounts(
      adminRole!.id,
      { accountIds: [admin2.id] },
      actor,
    )
    expect(removeAdmin2.removedCount).toBe(1)

    // 6. 尝试移出最后一个活跃管理员 admin1，必须阻止并抛出 conflict
    await expect(
      rbac.removeRoleAccounts(adminRole!.id, { accountIds: [admin1.id] }, actor),
    ).rejects.toThrow(/不能移除最后一个管理员/)
  })
})
