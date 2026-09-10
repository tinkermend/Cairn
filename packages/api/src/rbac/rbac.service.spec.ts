import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { RbacService } from './rbac.service'

describe('RbacService', () => {
  it('权限目录来自 @cairn/shared，不查库', () => {
    const service = new RbacService({} as never)
    const catalog = service.listPermissions()
    expect(catalog.items.map((i) => i.code)).toEqual([...PERMISSIONS])
  })
})
