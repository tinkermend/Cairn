import {
  changePasswordBodySchema,
  loginBodySchema,
  loginResponseSchema,
  meResponseSchema,
  updateMeBodySchema,
  type ChangePasswordBody,
  type LoginBody,
  type LoginResponse,
  type MeResponse,
  type UpdateMeBody,
} from '@cairn/shared'
import { z } from 'zod'
import { apiFetch } from '@/lib/api-client'

export function login(body: LoginBody): Promise<LoginResponse> {
  return apiFetch('/api/auth/login', loginResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginBodySchema.parse(body)),
  })
}

export function updateMe(body: UpdateMeBody): Promise<MeResponse> {
  return apiFetch('/api/me', meResponseSchema, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateMeBodySchema.parse(body)),
  })
}

export function changePassword(body: ChangePasswordBody): Promise<void> {
  return apiFetch('/api/me/password', z.undefined(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changePasswordBodySchema.parse(body)),
  }).then(() => undefined)
}
