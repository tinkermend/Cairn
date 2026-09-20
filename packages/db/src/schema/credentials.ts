import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  CredentialIdentityBindingStatus,
  CredentialManagementStatus,
  CredentialMaterialStatus,
  CredentialSource,
  CredentialType,
  CredentialValidityMode,
  IssuerExpirySource,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'

export const credentials = cairnSchema.table(
  'credentials',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    type: text('type').notNull().$type<CredentialType>(),
    source: text('source').notNull().$type<CredentialSource>(),
    name: text('name').notNull(),
    ownerConsoleAccountId: uuid('owner_console_account_id'),
    notes: text('notes'),
    purpose: text('purpose'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    managementStatus: text('management_status').notNull().default('active').$type<CredentialManagementStatus>(),
    currentVersionId: uuid('current_version_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credentials_owner_idx').on(t.ownerConsoleAccountId),
    index('credentials_type_updated_idx').on(t.type, t.updatedAt, t.id),
    index('credentials_status_updated_idx').on(t.managementStatus, t.updatedAt, t.id),
  ],
)

export const credentialBindings = cairnSchema.table(
  'credential_bindings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    targetId: uuid('target_id'),
    targetAccountId: uuid('target_account_id'),
    modelOrigin: text('model_origin'),
    modelSlot: text('model_slot'),
    alertChannelId: text('alert_channel_id'),
    serviceCredentialId: uuid('service_credential_id'),
    identityUsername: text('identity_username'),
    identityRevision: integer('identity_revision'),
    identityConfirmStatus: text('identity_confirm_status')
      .notNull()
      .default('confirmed')
      .$type<CredentialIdentityBindingStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credential_bindings_credential_idx').on(t.credentialId),
    uniqueIndex('credential_bindings_target_account_idx').on(t.targetAccountId),
    uniqueIndex('credential_bindings_alert_channel_idx').on(t.alertChannelId),
    uniqueIndex('credential_bindings_service_credential_idx').on(t.serviceCredentialId),
    index('credential_bindings_target_idx').on(t.targetId),
  ],
)

export const credentialVersions = cairnSchema.table(
  'credential_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    secretProvider: text('secret_provider'),
    secretId: uuid('secret_id'),
    materialStatus: text('material_status').notNull().$type<CredentialMaterialStatus>(),
    identityRevision: integer('identity_revision'),
    identityUsername: text('identity_username'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credential_versions_credential_idx').on(t.credentialId, t.registeredAt),
    index('credential_versions_secret_idx').on(t.secretId),
  ],
)

export const credentialMaintenancePolicies = cairnSchema.table(
  'credential_maintenance_policies',
  {
    credentialId: uuid('credential_id')
      .primaryKey()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    mode: text('mode').notNull().$type<CredentialValidityMode>(),
    amount: integer('amount'),
    timeZone: text('time_zone'),
    validityStartedAt: timestamp('validity_started_at', { withTimezone: true }),
    maintenanceDueAt: timestamp('maintenance_due_at', { withTimezone: true }),
    issuerExpiresAt: timestamp('issuer_expires_at', { withTimezone: true }),
    issuerExpirySource: text('issuer_expiry_source').notNull().default('unknown').$type<IssuerExpirySource>(),
    expiryReminderLeadDays: integer('expiry_reminder_lead_days').notNull().default(14),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credential_policies_due_idx').on(t.maintenanceDueAt)],
)

export const credentialVerifications = cairnSchema.table(
  'credential_verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => credentialVersions.id, { onDelete: 'restrict' }),
    identityRevision: integer('identity_revision'),
    sessionId: text('session_id'),
    sessionGeneration: integer('session_generation'),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    outcome: text('outcome').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credential_verifications_current_idx').on(t.credentialId, t.verifiedAt)],
)

export const credentialBatches = cairnSchema.table(
  'credential_batches',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorConsoleAccountId: uuid('actor_console_account_id').notNull(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    source: text('source').notNull().default('selection'),
    requestDigest: text('request_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credential_batches_actor_idempotency_idx').on(t.actorConsoleAccountId, t.idempotencyKey)],
)

export const credentialBatchItems = cairnSchema.table(
  'credential_batch_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => credentialBatches.id, { onDelete: 'restrict' }),
    credentialId: uuid('credential_id').notNull(),
    targetId: uuid('target_id'),
    targetAccountId: uuid('target_account_id'),
    expectedRevision: integer('expected_revision').notNull(),
    itemIdempotencyKey: text('item_idempotency_key').notNull(),
    requestDigest: text('request_digest'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    resultRevision: integer('result_revision'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credential_batch_items_idempotency_idx').on(t.batchId, t.itemIdempotencyKey)],
)

export const credentialReminders = cairnSchema.table(
  'credential_reminders',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'restrict' }),
    versionId: uuid('version_id').notNull(),
    policyRevision: integer('policy_revision').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    deliveryStatus: text('delivery_status'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credential_reminders_identity_idx').on(t.credentialId, t.versionId, t.policyRevision, t.stage),
  ],
)
