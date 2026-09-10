import {
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLE_KEYS,
  type RoleDto,
} from '@cairn/shared'

const now = '2026-01-01T00:00:00.000Z'

export const systemRoles: RoleDto[] = SYSTEM_ROLE_KEYS.map((key) => ({
  id: key,
  key,
  name: SYSTEM_ROLE_DEFINITIONS[key].name,
  kind: 'system',
  description: SYSTEM_ROLE_DEFINITIONS[key].description,
  permissions: [...SYSTEM_ROLE_DEFINITIONS[key].permissions],
  accountCount: 1,
  createdAt: now,
  updatedAt: now,
}))

export const sampleCustomRole: RoleDto = {
  id: 'role-qa',
  key: 'qa_lead',
  name: 'QA Lead',
  kind: 'custom',
  description: 'Read workflows and runs, execute runs.',
  permissions: ['workflow:read', 'run:read', 'run:execute'],
  accountCount: 0,
  createdAt: now,
  updatedAt: now,
}

export const sampleRoles: RoleDto[] = [...systemRoles, sampleCustomRole]
