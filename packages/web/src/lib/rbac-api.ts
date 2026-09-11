import {
  accountListResponseSchema,
  accountSchema,
  assignAccountRolesBodySchema,
  auditListResponseSchema,
  createAccountBodySchema,
  createRoleBodySchema,
  meResponseSchema,
  permissionCatalogResponseSchema,
  roleListResponseSchema,
  roleSchema,
  setPasswordBodySchema,
  updateAccountBodySchema,
  updateRoleBodySchema,
  type AccountDto,
  type AssignAccountRolesBody,
  type AuditListResponse,
  type CreateAccountBody,
  type CreateRoleBody,
  type MeResponse,
  type PermissionCatalogResponse,
  type RoleDto,
  type RoleListResponse,
  type AccountListResponse,
  type SetPasswordBody,
  type UpdateAccountBody,
  type UpdateRoleBody,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchPermissionCatalog(): Promise<PermissionCatalogResponse> {
  return apiFetch('/api/rbac/permissions', permissionCatalogResponseSchema)
}

export function fetchRoles(): Promise<RoleListResponse> {
  return apiFetch('/api/rbac/roles', roleListResponseSchema)
}

export function createRole(body: CreateRoleBody): Promise<RoleDto> {
  return apiFetch('/api/rbac/roles', roleSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createRoleBodySchema.parse(body)),
  })
}

export function updateRole(id: string, body: UpdateRoleBody): Promise<RoleDto> {
  return apiFetch(`/api/rbac/roles/${id}`, roleSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateRoleBodySchema.parse(body)),
  })
}

export function deleteRole(id: string): Promise<void> {
  return apiFetch(`/api/rbac/roles/${id}/delete`, roleSchema, {
    method: 'POST',
  }).then(() => undefined)
}

export function fetchAccounts(): Promise<AccountListResponse> {
  return apiFetch('/api/console/accounts', accountListResponseSchema)
}

export function createAccount(body: CreateAccountBody): Promise<AccountDto> {
  return apiFetch('/api/console/accounts', accountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createAccountBodySchema.parse(body)),
  })
}

export function updateAccount(id: string, body: UpdateAccountBody): Promise<AccountDto> {
  return apiFetch(`/api/console/accounts/${id}`, accountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateAccountBodySchema.parse(body)),
  })
}

export function deleteAccount(id: string): Promise<void> {
  return apiFetch(`/api/console/accounts/${id}/delete`, accountSchema, {
    method: 'POST',
  }).then(() => undefined)
}

export function assignAccountRoles(
  id: string,
  body: AssignAccountRolesBody,
): Promise<AccountDto> {
  return apiFetch(`/api/console/accounts/${id}/roles`, accountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assignAccountRolesBodySchema.parse(body)),
  })
}

export function fetchMe(): Promise<MeResponse> {
  return apiFetch('/api/me', meResponseSchema)
}

export function setAccountPassword(id: string, body: SetPasswordBody): Promise<void> {
  return apiFetch(`/api/console/accounts/${id}/password`, accountSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setPasswordBodySchema.parse(body)),
  }).then(() => undefined)
}

export function fetchAuditLog(): Promise<AuditListResponse> {
  return apiFetch('/api/console/audit', auditListResponseSchema)
}
