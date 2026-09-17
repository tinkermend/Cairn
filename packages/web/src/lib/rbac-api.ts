import {
  accountListResponseSchema,
  accountSchema,
  assignAccountRolesBodySchema,
  auditListResponseSchema,
  loginAuditListResponseSchema,
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
  type LoginAuditListResponse,
  type LoginAuditQuery,
  type OperationAuditQuery,
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
  addRoleAccountsBodySchema,
  removeRoleAccountsBodySchema,
  roleAccountsResponseSchema,
  type AddRoleAccountsBody,
  type RemoveRoleAccountsBody,
  type RoleAccountsQuery,
  type RoleAccountsResponse,
} from '@cairn/shared'
import { z } from 'zod'
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

export function fetchRoleAccounts(
  id: string,
  query?: RoleAccountsQuery,
): Promise<RoleAccountsResponse> {
  const params = new URLSearchParams()
  if (query?.cursor) params.set('cursor', query.cursor)
  if (query?.limit) params.set('limit', String(query.limit))
  if (query?.search) params.set('search', query.search)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return apiFetch(`/api/rbac/roles/${id}/accounts${qs}`, roleAccountsResponseSchema)
}

export function addRoleAccounts(
  id: string,
  body: AddRoleAccountsBody,
): Promise<{ addedCount: number }> {
  return apiFetch(
    `/api/rbac/roles/${id}/accounts`,
    z.object({ addedCount: z.number() }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addRoleAccountsBodySchema.parse(body)),
    },
  )
}

export function removeRoleAccounts(
  id: string,
  body: RemoveRoleAccountsBody,
): Promise<{ removedCount: number }> {
  return apiFetch(
    `/api/rbac/roles/${id}/accounts/remove`,
    z.object({ removedCount: z.number() }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(removeRoleAccountsBodySchema.parse(body)),
    },
  )
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

function auditSearch(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

function dateParam(value?: Date): string | undefined {
  return value ? value.toISOString() : undefined
}

export function fetchOperationAudit(query: OperationAuditQuery): Promise<AuditListResponse> {
  return apiFetch(
    `/api/console/audit/operations${auditSearch({
      cursor: query.cursor,
      limit: String(query.limit),
      action: query.action,
      actorId: query.actorId,
      from: dateParam(query.from),
      to: dateParam(query.to),
    })}`,
    auditListResponseSchema,
  )
}

export function fetchLoginAudit(query: LoginAuditQuery): Promise<LoginAuditListResponse> {
  return apiFetch(
    `/api/console/audit/logins${auditSearch({
      cursor: query.cursor,
      limit: String(query.limit),
      outcome: query.outcome,
      actorId: query.actorId,
      identifier: query.identifier,
      clientKind: query.clientKind,
      from: dateParam(query.from),
      to: dateParam(query.to),
    })}`,
    loginAuditListResponseSchema,
  )
}
