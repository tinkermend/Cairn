import { afterEach, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { and, eq } from 'drizzle-orm'
import { openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

describe('系统角色权限对账', { timeout: 30_000 }, () => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  it('补回 admin 缺失的受管画面权限，且仍覆盖整个目录', async () => {
    const handle = await openContractDb('postgres')
    handles.push(handle)
    const db = expose(handle)
    const rbac = new api.RbacStore(db, {
      hash: async (value: string) => value,
      verify: async (value: string, hash: string) => value === hash,
    })
    const catalog = await rbac.reconcileSystemRolePermissions()
    expect(catalog.inserted).toBeGreaterThanOrEqual(0)
    const roles = await rbac.listRoles()
    const admin = roles.items.find((role) => role.key === 'admin')
    const operator = roles.items.find((role) => role.key === 'operator')
    expect(admin).toBeDefined()
    expect(operator?.permissions).toEqual(expect.arrayContaining(['monitor:read', 'monitor:operate']))
    const { consoleRolePermissions } = schemaFor(handle.db)
    await handle.db.delete(consoleRolePermissions).where(
      and(
        eq(consoleRolePermissions.consoleRoleId, admin!.id),
        eq(consoleRolePermissions.permission, 'session:view'),
      ),
    )
    await handle.db.delete(consoleRolePermissions).where(
      and(
        eq(consoleRolePermissions.consoleRoleId, admin!.id),
        eq(consoleRolePermissions.permission, 'session:control'),
      ),
    )
    const missing = await rbac.getRole(admin!.id)
    expect(missing.permissions).not.toContain('session:view')
    expect(missing.permissions).not.toContain('session:control')

    const first = await rbac.reconcileSystemRolePermissions()
    expect(first.inserted).toBe(2)
    const restored = await rbac.getRole(admin!.id)
    expect(restored.permissions).toEqual([...PERMISSIONS].sort())
    expect(await rbac.reconcileSystemRolePermissions()).toEqual({ inserted: 0 })
  })
})
