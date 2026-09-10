import { PERMISSIONS, SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { type User } from './schema'

const now = '2026-01-01T00:00:00.000Z'

export const users: User[] = [
  {
    id: 'acc-admin',
    displayName: 'Ada Admin',
    email: 'ada@cairn.dev',
    status: 'active',
    roles: [{ id: 'admin', key: 'admin', name: SYSTEM_ROLE_DEFINITIONS.admin.name, kind: 'system' }],
    permissions: [...PERMISSIONS],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'acc-operator',
    displayName: 'Omar Operator',
    email: 'omar@cairn.dev',
    status: 'active',
    roles: [
      { id: 'operator', key: 'operator', name: SYSTEM_ROLE_DEFINITIONS.operator.name, kind: 'system' },
    ],
    permissions: [...SYSTEM_ROLE_DEFINITIONS.operator.permissions],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'acc-viewer',
    displayName: 'Vera Viewer',
    email: 'vera@cairn.dev',
    status: 'disabled',
    roles: [{ id: 'viewer', key: 'viewer', name: SYSTEM_ROLE_DEFINITIONS.viewer.name, kind: 'system' }],
    permissions: [...SYSTEM_ROLE_DEFINITIONS.viewer.permissions],
    createdAt: now,
    updatedAt: now,
  },
]
