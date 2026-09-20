import { z, type ZodType } from 'zod'
import {
  notificationChannelsResponseSchema,
  notificationEventListSchema,
  notificationEventSchema,
  notificationPolicyResponseSchema,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { apiFetch, toQueryString } from './api-client'
import { readSseStream } from './sse'

export type NotificationChannels = z.infer<
  typeof notificationChannelsResponseSchema
>
export type NotificationList = z.infer<typeof notificationEventListSchema>
export const notificationReceipt = z.object({ eventId: z.string() })
export function notificationCommandKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export const fetchNotificationChannels = (targetId?: string) =>
  apiFetch(
    `/api/notifications/channels${toQueryString({ targetId })}`,
    notificationChannelsResponseSchema
  )
export const fetchNotificationEvents = (query: Record<string, unknown>) =>
  apiFetch(
    `/api/notifications/events${toQueryString(query)}`,
    notificationEventListSchema
  )
export const fetchNotificationEvent = (id: string) =>
  apiFetch(`/api/notifications/events/${id}`, notificationEventSchema)
export const fetchNotificationPolicy = (id: string) =>
  apiFetch(
    `/api/notifications/scenarios/${id}/policy`,
    notificationPolicyResponseSchema
  )
export const postNotification = <T>(
  path: string,
  body: unknown,
  schema: ZodType<T>
) =>
  apiFetch(`/api/notifications/${path}`, schema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export async function subscribeNotifications(
  query: Record<string, unknown>,
  signal: AbortSignal,
  onSnapshot: (value: NotificationList) => void
) {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(`/api/notifications/stream${toQueryString(query)}`, {
    signal,
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
  })
  if (!res.ok || !res.body) throw new Error('实时通知连接中断，请刷新重连')
  await readSseStream(
    res.body,
    (frame) => {
      if (frame.event === 'snapshot')
        onSnapshot(notificationEventListSchema.parse(JSON.parse(frame.data)))
    },
    signal
  )
}
