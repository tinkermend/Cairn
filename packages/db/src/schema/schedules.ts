import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import type {
  MapRefreshScheduleConsumer,
  ScheduleAdmissionStatus,
  ScheduleSkipReason,
  ScheduleWeekday,
} from '@cairn/shared'
import { newId } from '../id.js'
import { cairnSchema } from './console.js'
import { mapJobs } from './map-jobs.js'
import { targetAccounts, targets } from './targets.js'

export const schedules = cairnSchema.table(
  'schedules',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => targetAccounts.id, { onDelete: 'restrict' }),
    consumerKey: text('consumer_key').notNull(),
    enabled: integer('enabled').notNull(),
    revision: integer('revision').notNull(),
    currentVersionId: uuid('current_version_id').notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('schedules_account_consumer').on(t.targetAccountId, t.consumerKey),
    index('schedules_due_idx').on(t.enabled, t.nextDueAt),
    index('schedules_target_idx').on(t.targetId, t.createdAt),
  ],
)

export const scheduleVersions = cairnSchema.table(
  'schedule_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    timezone: text('timezone').notNull(),
    weekdays: jsonb('weekdays').$type<ScheduleWeekday[]>().notNull(),
    windowStart: text('window_start').notNull(),
    windowEnd: text('window_end').notNull(),
    misfire: text('misfire').notNull(),
    consumer: jsonb('consumer').$type<MapRefreshScheduleConsumer>().notNull(),
    authorizedActorId: uuid('authorized_actor_id').notNull(),
    contentDigest: text('content_digest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('schedule_versions_rev').on(t.scheduleId, t.revision)],
)

export const scheduleOccurrences = cairnSchema.table(
  'schedule_occurrences',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'restrict' }),
    scheduleVersionId: uuid('schedule_version_id')
      .notNull()
      .references(() => scheduleVersions.id, { onDelete: 'restrict' }),
    localSlotKey: text('local_slot_key').notNull(),
    occurrenceKey: text('occurrence_key'),
    localStartDate: text('local_start_date').notNull(),
    windowStartUtc: timestamp('window_start_utc', { withTimezone: true }),
    windowEndUtc: timestamp('window_end_utc', { withTimezone: true }),
    startOffsetMinutes: integer('start_offset_minutes'),
    endOffsetMinutes: integer('end_offset_minutes'),
    timeRuleVersion: text('time_rule_version').notNull(),
    admissionStatus: text('admission_status').notNull().$type<ScheduleAdmissionStatus>(),
    reason: text('reason').$type<ScheduleSkipReason>(),
    jobId: uuid('job_id').references(() => mapJobs.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    admittedAt: timestamp('admitted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('schedule_occurrences_slot').on(t.scheduleId, t.localSlotKey),
    uniqueIndex('schedule_occurrences_key').on(t.occurrenceKey),
    uniqueIndex('schedule_occurrences_job').on(t.jobId),
    index('schedule_occurrences_due_idx').on(t.admissionStatus, t.windowEndUtc),
  ],
)

export const scheduleEvents = cairnSchema.table(
  'schedule_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('schedule_events_seq').on(t.scheduleId, t.seq)],
)

export const scheduleCommands = cairnSchema.table(
  'schedule_commands',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    commandKey: text('command_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('schedule_commands_key').on(t.commandKey)],
)
