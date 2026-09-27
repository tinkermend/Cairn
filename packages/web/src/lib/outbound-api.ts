import { z, type ZodType } from 'zod'
import {
  outboundChannelsResponseSchema,
  outboundEventListSchema,
  outboundEventSchema,
  outboundPolicyResponseSchema,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { apiFetch, toQueryString } from './api-client'
import { readSseStream } from './sse'

export type OutboundChannels = z.infer<
  typeof outboundChannelsResponseSchema
>
export type NotificationChannels = OutboundChannels

export type OutboundList = z.infer<typeof outboundEventListSchema>
export type NotificationList = OutboundList

export const outboundReceipt = z.object({ eventId: z.string() })
export const notificationReceipt = outboundReceipt

export function outboundCommandKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export const notificationCommandKey = outboundCommandKey

export const fetchOutboundChannels = (targetId?: string) =>
  apiFetch(
    `/api/outbound/channels${toQueryString({ targetId })}`,
    outboundChannelsResponseSchema
  )
export const fetchNotificationChannels = fetchOutboundChannels

export const fetchOutboundEvents = (query: Record<string, unknown>) =>
  apiFetch(
    `/api/outbound/events${toQueryString(query)}`,
    outboundEventListSchema
  )
export const fetchNotificationEvents = fetchOutboundEvents

export const fetchOutboundEvent = (id: string) =>
  apiFetch(`/api/outbound/events/${id}`, outboundEventSchema)
export const fetchNotificationEvent = fetchOutboundEvent

export const fetchOutboundPolicy = (id: string) =>
  apiFetch(
    `/api/outbound/scenarios/${id}/policy`,
    outboundPolicyResponseSchema
  )
export const fetchNotificationPolicy = fetchOutboundPolicy

export const postOutbound = <T>(
  path: string,
  body: unknown,
  schema: ZodType<T>
) =>
  apiFetch(`/api/outbound/${path}`, schema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
export const postNotification = postOutbound

export async function subscribeOutbound(
  query: Record<string, unknown>,
  signal: AbortSignal,
  onSnapshot: (value: OutboundList) => void
) {
  const token = useAuthStore.getState().auth.accessToken
  const res = await fetch(`/api/outbound/stream${toQueryString(query)}`, {
    signal,
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
  })
  if (!res.ok || !res.body) throw new Error('实时消息推送连接中断，请刷新重连')
  await readSseStream(
    res.body,
    (frame) => {
      if (frame.event === 'snapshot')
        onSnapshot(outboundEventListSchema.parse(JSON.parse(frame.data)))
    },
    signal
  )
}
export const subscribeNotifications = subscribeOutbound
