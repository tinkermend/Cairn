// Temporary bridge during outbound migration. Will be removed once all packages are migrated.
export * from './outbound.js'

import {
  FACTORY_OUTBOUND,
  platformOutboundSchema,
  outboundPolicySchema,
  DEFAULT_OUTBOUND_POLICY,
  frozenOutboundBindingSchema,
  frozenOutboundPolicySchema,
  outboundPayloadSchema,
  outboundReasons,
  outboundChannelWriteSchema,
  outboundSmtpWriteSchema,
  outboundSmtpSecretSchema,
  outboundChannelSecretSchema,
  outboundSettingsWriteSchema,
  outboundPolicyWriteSchema,
  outboundActionSchema,
  outboundChannelStateSchema,
  outboundListQuerySchema,
  outboundAttemptSchema,
  outboundDeliverySchema,
  outboundEventSchema,
  outboundEventListSchema,
  outboundPolicyResponseSchema,
  outboundChannelSummarySchema,
  outboundChannelsResponseSchema,
  outboundChannelSchema,
  outboundSmtpSchema,
  OUTBOUND_PROTOCOL,
  OUTBOUND_WORKER_PROTOCOL,
  RUN_OUTBOUND_PROTOCOL,
  type OutboundChannel,
  type OutboundSmtp,
  type PlatformOutbound,
  type OutboundPolicy,
  type FrozenOutboundBinding,
  type FrozenOutboundPolicy,
  type OutboundPayload,
  type OutboundChannelWrite,
  type OutboundSmtpWrite,
  type OutboundEventDto,
  type OutboundStatus,
  outboundStatusSchema,
} from './outbound.js'

export const NOTIFICATION_PROTOCOL = OUTBOUND_PROTOCOL
export const NOTIFICATION_WORKER_PROTOCOL = OUTBOUND_WORKER_PROTOCOL
export const RUN_NOTIFICATION_PROTOCOL = RUN_OUTBOUND_PROTOCOL
export const notificationStatusSchema = outboundStatusSchema
export type NotificationStatus = OutboundStatus
export const notificationChannelSchema = outboundChannelSchema
export type NotificationChannel = OutboundChannel
export const notificationSmtpSchema = outboundSmtpSchema
export type NotificationSmtp = OutboundSmtp
export const platformNotificationsSchema = platformOutboundSchema
export type PlatformNotifications = PlatformOutbound
export const FACTORY_NOTIFICATIONS = FACTORY_OUTBOUND
export const notificationPolicySchema = outboundPolicySchema
export type NotificationPolicy = OutboundPolicy
export const DEFAULT_NOTIFICATION_POLICY = DEFAULT_OUTBOUND_POLICY
export const frozenNotificationBindingSchema = frozenOutboundBindingSchema
export type FrozenNotificationBinding = FrozenOutboundBinding
export const frozenNotificationPolicySchema = frozenOutboundPolicySchema
export type FrozenNotificationPolicy = FrozenOutboundPolicy
export const notificationPayloadSchema = outboundPayloadSchema
export type NotificationPayload = OutboundPayload
export const notificationReasons = outboundReasons
export const notificationChannelWriteSchema = outboundChannelWriteSchema
export type NotificationChannelWrite = OutboundChannelWrite
export const notificationSmtpWriteSchema = outboundSmtpWriteSchema
export type NotificationSmtpWrite = OutboundSmtpWrite
export const notificationSmtpSecretSchema = outboundSmtpSecretSchema
export const notificationChannelSecretSchema = outboundChannelSecretSchema
export const notificationSettingsWriteSchema = outboundSettingsWriteSchema
export const notificationPolicyWriteSchema = outboundPolicyWriteSchema
export const notificationActionSchema = outboundActionSchema
export const notificationChannelStateSchema = outboundChannelStateSchema
export const notificationListQuerySchema = outboundListQuerySchema
export const notificationAttemptSchema = outboundAttemptSchema
export const notificationDeliverySchema = outboundDeliverySchema
export const notificationEventSchema = outboundEventSchema
export const notificationEventListSchema = outboundEventListSchema
export type NotificationEventDto = OutboundEventDto
export const notificationPolicyResponseSchema = outboundPolicyResponseSchema
export const notificationChannelSummarySchema = outboundChannelSummarySchema
export const notificationChannelsResponseSchema = outboundChannelsResponseSchema
