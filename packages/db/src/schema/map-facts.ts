import {
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type {
  MapCaptureStatus,
  MapFactType,
  MapSourceType,
  MapVerificationDimension,
  MapVerificationVerdict,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { targets } from './targets.js'

export const mapIngestHeads = cairnSchema.table('map_ingest_heads', {
  targetId: uuid('target_id')
    .primaryKey()
    .references(() => targets.id, { onDelete: 'restrict' }),
  committedSeq: integer('committed_seq').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mapObservations = cairnSchema.table(
  'map_observations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    ingestSeq: integer('ingest_seq').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sourceType: text('source_type').notNull().$type<MapSourceType>(),
    sourceRunId: uuid('source_run_id'),
    sourceAttemptId: uuid('source_attempt_id'),
    sourceRecordingId: uuid('source_recording_id'),
    captureStatus: text('capture_status').notNull().$type<MapCaptureStatus>(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    uniqueIndex('map_observations_target_dedupe_idx').on(t.targetId, t.dedupeKey),
    uniqueIndex('map_observations_target_seq_idx').on(t.targetId, t.ingestSeq),
    uniqueIndex('map_observations_target_id_idx').on(t.targetId, t.id),
    uniqueIndex('map_observations_id_target_idx').on(t.id, t.targetId),
    index('map_observations_observed_idx').on(t.targetId, t.observedAt, t.id),
    index('map_observations_source_run_idx').on(t.sourceRunId),
    index('map_observations_source_attempt_idx').on(t.sourceAttemptId),
    index('map_observations_source_recording_idx').on(t.sourceRecordingId),
  ],
)

export const mapVerifications = cairnSchema.table(
  'map_verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    ingestSeq: integer('ingest_seq').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    dimension: text('dimension').notNull().$type<MapVerificationDimension>(),
    verdict: text('verdict').notNull().$type<MapVerificationVerdict>(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_verifications_target_dedupe_idx').on(t.targetId, t.dedupeKey),
    uniqueIndex('map_verifications_target_seq_idx').on(t.targetId, t.ingestSeq),
    uniqueIndex('map_verifications_target_id_idx').on(t.targetId, t.id),
    uniqueIndex('map_verifications_id_target_idx').on(t.id, t.targetId),
    index('map_verifications_seq_idx').on(t.targetId, t.ingestSeq),
    index('map_verifications_dimension_idx').on(t.targetId, t.dimension),
  ],
)

export const mapVerificationRefs = cairnSchema.table(
  'map_verification_refs',
  {
    verificationId: uuid('verification_id').notNull(),
    observationId: uuid('observation_id').notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.verificationId, t.observationId], name: 'map_verification_refs_pkey' }),
    index('map_verification_refs_observation_idx').on(t.observationId),
  ],
)

export const mapFactReceipts = cairnSchema.table(
  'map_fact_receipts',
  {
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    dedupeKey: text('dedupe_key').notNull(),
    factType: text('fact_type').notNull().$type<MapFactType>(),
    factId: uuid('fact_id').notNull(),
    ingestSeq: integer('ingest_seq').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.targetId, t.dedupeKey], name: 'map_fact_receipts_pkey' }),
    uniqueIndex('map_fact_receipts_seq_idx').on(t.targetId, t.ingestSeq),
    uniqueIndex('map_fact_receipts_fact_idx').on(t.targetId, t.factType, t.factId),
  ],
)

export const mapFactContents = cairnSchema.table(
  'map_fact_contents',
  {
    targetId: uuid('target_id').notNull(),
    factType: text('fact_type').notNull().$type<MapFactType>(),
    factId: uuid('fact_id').notNull(),
    content: jsonb('content').$type<Record<string, unknown> | null>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.targetId, t.factType, t.factId], name: 'map_fact_contents_pkey' })],
)

export const mapFactAvailability = cairnSchema.table(
  'map_fact_availability',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id').notNull(),
    factType: text('fact_type').notNull().$type<MapFactType>(),
    factId: uuid('fact_id').notNull(),
    availabilityRevision: integer('availability_revision').notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('map_fact_availability_revision_idx').on(
      t.targetId,
      t.factType,
      t.factId,
      t.availabilityRevision,
    ),
    index('map_fact_availability_fact_idx').on(t.targetId, t.factType, t.factId),
  ],
)

export type MapObservationRow = typeof mapObservations.$inferSelect
export type MapVerificationRow = typeof mapVerifications.$inferSelect
export type MapFactReceiptRow = typeof mapFactReceipts.$inferSelect
export type MapIngestHeadRow = typeof mapIngestHeads.$inferSelect
