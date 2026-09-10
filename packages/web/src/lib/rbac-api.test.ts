import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_CATALOG, PERMISSIONS } from '@cairn/shared'
import { fetchPermissionCatalog, fetchRoles } from './rbac-api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('rbac-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses the permission catalog with the shared schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ items: PERMISSION_CATALOG }))
    )
    const res = await fetchPermissionCatalog()
    expect(res.items).toHaveLength(PERMISSIONS.length)
    expect(res.items[0]?.code).toBe('account:read')
  })

  it('parses role list responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'admin',
              key: 'admin',
              name: 'Administrator',
              kind: 'system',
              description: null,
              permissions: ['account:read'],
              accountCount: 1,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      )
    )
    const res = await fetchRoles()
    expect(res.items[0]?.key).toBe('admin')
  })
})
