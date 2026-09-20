/** Native Drizzle dialects share one repository implementation and one JS row shape.
 * The PG types below are a PRIVATE projection of that common query subset. Native
 * tables/encoders and dialects are used at runtime; SQL is never translated.
 */
import {
  getTableColumns,
  getTableName,
  is,
  sql,
  Table,
  inArray,
  SQL,
  type SQLWrapper,
  type InferSelectModel,
} from 'drizzle-orm'
import {
  type PgTable,
  type SelectedFields,
  type PgUpdateSetSource,
  type PgInsertValue,
} from 'drizzle-orm/pg-core'
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types'
import * as pg from 'drizzle-orm/pg-core'
import * as mysql from 'drizzle-orm/mysql-core'
import * as sqlite from 'drizzle-orm/sqlite-core'
import * as schema from './schema/index.js'
import type { Db } from './client.js'

export type Driver = 'postgres' | 'mysql' | 'sqlite'
type Tables = {
  [K in keyof typeof schema as (typeof schema)[K] extends Table ? K : never]: (typeof schema)[K]
}
type NativeContext = {
  driver: Driver
  tables: Tables
  inTransaction: boolean
  hooks: Array<() => void | Promise<void>>
}
const contexts = new WeakMap<object, NativeContext>()
export function driverOf(db: object): Driver {
  return contexts.get(db)?.driver ?? 'postgres'
}
export function schemaFor(db: object): Tables {
  return contexts.get(db)?.tables ?? schema
}

/** Compare a stored timestamp with a variable day interval, in the native dialect. */
export function timestampMinusDays(db: Db, timestamp: SQLWrapper, days: SQLWrapper): SQL {
  return driverOf(db) === 'mysql'
    ? sql`timestampadd(DAY, -(${days}), ${timestamp})`
    : sql`${timestamp} - (${days}) * interval '1 day'`
}
export function bindNative(
  db: Db,
  driver: Driver,
  tables: Tables,
  inTransaction = false,
  hooks: Array<() => void | Promise<void>> = [],
): Db {
  contexts.set(db, { driver, tables, inTransaction, hooks })
  return db
}
export function inTransaction(db: object): boolean {
  return contexts.get(db)?.inTransaction ?? false
}

export function onCommit(db: object, fn: () => void | Promise<void>): void {
  const ctx = contexts.get(db)
  if (!ctx?.inTransaction) {
    queueMicrotask(() => {
      void Promise.resolve(fn()).catch((error) => {
        console.error('[db] onCommit hook failed outside transaction', error)
      })
    })
    return
  }
  ctx.hooks.push(fn)
}

export async function flushCommitHooks(hooks: Array<() => void | Promise<void>>): Promise<void> {
  const pending = hooks.splice(0)
  for (const hook of pending) {
    try {
      await hook()
    } catch (error) {
      console.error('[db] after-commit hook failed', error)
    }
  }
}

const sqliteDate = sqlite.customType<{ data: Date; driverData: string }>({
  dataType: () => 'text',
  toDriver: (v) => v.toISOString(),
  fromDriver: (v) => new Date(v),
})
const mysqlBytes = mysql.customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'longblob',
})
const sqliteBytes = sqlite.customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'blob',
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v),
})

// Indexed text has a complete-value index, never a lossy prefix. Limits are
// checked on import and by each backend's physical constraints.
export const indexedTextLimits: Record<string, number> = {
  'notification_controls.key': 180,
  'notification_events.source_key': 200,
  'notification_events.state': 24,
  'notification_deliveries.recipient_key': 64,
  'notification_deliveries.status': 24,
  'notification_commands.command_key': 180,
  'notification_commands.action': 24,
  'service_webhooks.url': 2048,
  'service_webhooks.status': 16,
  'service_webhook_deliveries.event_type': 32,
  'service_webhook_deliveries.status': 16,
  'service_webhook_deliveries.last_error': 256,
  'service_webhook_deliveries.claim_owner': 256,
  'recording_artifacts.client_asset_id': 128,
  'recording_artifact_uploads.object_key': 512,
  'recording_artifacts.status': 16,
  'recording_artifact_uploads.status': 16,
  'scenario_validation_subjects.subject_digest': 64,
  'run_validation_contexts.subject_digest': 64,
  'console_accounts.email': 320,
  'console_identities.provider': 64,
  'console_identities.subject': 512,
  'console_roles.key': 64,
  'scenario_versions.source_digest': 64,
  'step_runs.name': 128,
  'console_role_permissions.permission': 128,
  'console_audit_events.login_identifier': 64,
  'targets.code': 256,
  'target_accounts.username': 256,
  'target_accounts.expected_identity': 256,
  'target_accounts.usage': 16,
  'target_accounts.map_usage_guard': 1,
  'target_auth_profiles.digest': 64,
  'target_account_auth_budget.paused_reason': 128,
  'credentials.type': 32,
  'credentials.source': 32,
  'credentials.name': 128,
  'credentials.purpose': 256,
  'credentials.management_status': 16,
  'credential_bindings.kind': 32,
  'credential_bindings.model_origin': 512,
  'credential_bindings.model_slot': 32,
  'credential_bindings.alert_channel_id': 64,
  'credential_bindings.identity_username': 256,
  'credential_bindings.identity_confirm_status': 32,
  'credential_versions.secret_provider': 64,
  'credential_versions.material_status': 32,
  'credential_versions.identity_username': 256,
  'credential_versions.revoke_reason': 128,
  'credential_maintenance_policies.mode': 16,
  'credential_maintenance_policies.time_zone': 64,
  'credential_maintenance_policies.issuer_expiry_source': 32,
  'credential_verifications.source': 32,
  'credential_verifications.source_id': 64,
  'credential_verifications.outcome': 32,
  'credential_verifications.session_id': 64,
  'credential_batches.kind': 32,
  'credential_batches.idempotency_key': 128,
  'credential_batch_items.item_idempotency_key': 128,
  'credential_batch_items.status': 32,
  'credential_batch_items.error_code': 64,
  'credential_batch_items.error_message': 256,
  'credential_reminders.stage': 16,
  'credential_reminders.status': 16,
  'credential_reminders.delivery_status': 16,
  'credential_reminders.last_error': 64,
  'browser_sessions.auth_expiry_source': 64,
  'browser_sessions.last_auth_error': 128,
  'browser_sessions.identity_state': 16,
  'browser_sessions.observed_tier': 32,
  'scenarios.name': 128,
  'runs.idempotency_key': 256,
  'run_events.type': 64,
  'run_events.worker_id': 128,
  'run_events.request_id': 128,
  'recording_drafts.idempotency_key': 256,
  'recording_bindings.ticket_hash': 64,
  'recording_bindings.status': 16,
  'recording_bindings.api_origin': 256,
  'recording_import_receipts.idempotency_key': 256,
  'recording_import_receipts.request_digest': 64,
  'recording_import_receipts.source_digest': 64,
  'recording_import_receipts.normalizer_version': 64,
  'recording_map_ingests.status': 16,
  'recording_map_ingests.last_error': 512,
  'assistant_conversations.idempotency_key': 128,
  'assistant_turns.client_turn_id': 128,
  'assistant_turns.status': 32,
  'assistant_turns.processing_token': 64,
  'assistant_turns.request_digest': 64,
  'stored_objects.object_key': 512,
  'evidences.artifact_key': 160,
  'run_video_media_jobs.status': 16,
  'run_video_media_jobs.claim_owner': 256,
  'run_video_media_jobs.last_error': 256,
  'stored_objects.owner_kind': 16,
  'runs.execution_origin': 16,
  'runs.suite_member_id': 64,
  'scenario_suite_publish_receipts.idempotency_key': 128,
  'suite_runs.verdict': 32,
  'suite_runs.failure_policy': 16,
  'suite_runs.idempotency_key': 128,
  'suite_run_items.member_id': 64,
  'suite_run_items.group_id': 64,
  'report_profiles.name': 128,
  'report_revision_outputs.format': 8,
  'report_revision_outputs.render_version': 64,
  'suite_report_triggers.status': 16,
  'artifacts.kind': 32,
  'artifacts.content_type': 128,
  'reports.subject_kind': 16,
  'reports.idempotency_key': 128,
  'reports.request_digest': 64,
  'report_revisions.idempotency_key': 128,
  'report_revisions.request_digest': 64,
  'report_revisions.stage': 16,
  'report_revisions.scope': 24,
  'report_revisions.template_version': 64,
  'report_revisions.render_version': 64,
  'report_revisions.content_completeness': 16,
  'export_jobs.kind': 32,
  'export_jobs.content_completeness': 16,
  'export_jobs.request_digest': 64,
  'export_jobs.idempotency_key': 128,
  'workers.id': 256,
  'session_operations.idempotency_key': 256,
  'session_operations.content_digest': 64,
  'session_operations.kind': 64,
  'session_operations.origin': 32,
  'session_operations.status': 32,
  'session_operations.error_code': 64,
  'session_operations.claim_token': 128,
  'session_operations.account_config_digest': 64,
  'session_retention_intents.reason': 256,
  'session_events.type': 64,
  'session_profiles.state': 32,
  'session_leases.purpose': 32,
  'session_leases.owner_kind': 32,
  'map_observations.dedupe_key': 192,
  'map_observations.payload_digest': 64,
  'map_observations.source_type': 32,
  'map_observations.capture_status': 16,
  'map_verifications.dedupe_key': 192,
  'map_verifications.payload_digest': 64,
  'map_verifications.dimension': 16,
  'map_verifications.verdict': 16,
  'map_fact_receipts.dedupe_key': 192,
  'map_fact_receipts.payload_digest': 64,
  'map_fact_receipts.fact_type': 16,
  'map_fact_contents.fact_type': 16,
  'map_fact_availability.fact_type': 16,
  'map_fact_availability.status': 16,
  'map_fact_availability.reason': 64,
  'map_pages.allocation_key': 192,
  'map_pages.kind': 16,
  'map_pages.route_template': 512,
  'map_pages.status': 16,
  'map_objects.allocation_key': 192,
  'map_objects.status': 16,
  'map_identity_revisions.command_key': 192,
  'map_identity_revisions.action': 16,
  'map_identity_revisions.reason': 512,
  'map_projections.status': 16,
  'map_projections.algorithm_version': 64,
  'map_projections.policy_version': 64,
  'map_projections.last_error': 512,
  'map_projections.rebuild_completeness': 16,
  'map_object_descriptors.implementation_key': 192,
  'map_object_descriptors.content_digest': 64,
  'map_implementations.implementation_key': 192,
  'map_projection_assets.asset_ref_key': 192,
  'map_projection_assets.implementation_key': 192,
  'map_projection_assets.lifecycle': 16,
  'map_conflicts.conflict_key': 192,
  'map_conflicts.status': 16,
  'map_releases.policy_version': 64,
  'map_releases.manifest_digest': 64,
  'map_releases.command_key': 192,
  'map_release_items.asset_ref_key': 192,
  'map_release_items.implementation_key': 192,
  'map_release_items.lifecycle': 16,
  'map_asset_governance.asset_ref_key': 192,
  'map_asset_governance.lifecycle': 16,
  'map_asset_governance.reason': 512,
  'map_governance_commands.command_key': 192,
  'map_governance_commands.kind': 32,
  'map_governance_commands.status': 16,
  'map_governance_commands.reason': 512,
  'map_governance_commands.last_error': 512,
  'map_release_publications.publication_status': 16,
  'map_release_publications.command_key': 192,
  'map_publication_commands.command_key': 192,
  'map_release_publications.reason': 512,
  'map_scenario_bindings.slot_key': 192,
  'map_scenario_bindings.asset_ref_key': 192,
  'map_scenario_bindings.implementation_key': 192,
  'map_scenario_bindings.basis': 32,
  'map_scenario_bindings.scope_kind': 16,
  'map_scenario_bindings.version_slot': 64,
  'map_scenario_bindings.descriptor_digest': 64,
  'map_scenario_bindings.resolution': 32,
  'map_scenario_bindings.status': 16,
  'map_reference_scan_heads.status': 16,
  'map_reference_scan_heads.completeness': 16,
  'map_reference_candidates.asset_ref_key': 192,
  'action_module_receipts.idempotency_key': 128,
  'action_module_command_receipts.idempotency_key': 128,
  'action_module_command_receipts.command': 32,
  'module_resolution_requests.idempotency_key': 128,
  'module_resolution_requests.request_digest': 64,
  'module_resolution_requests.expression': 512,
  'module_resolution_requests.mode': 16,
  'module_resolution_requests.term_revision': 128,
  'module_resolution_requests.status': 16,
  'module_resolution_requests.ai_skipped': 32,
  'module_resolution_requests.outcome': 16,
  'module_resolution_requests.accept_idempotency_key': 128,
  'action_modules.key': 64,
  'action_modules.capability_key': 128,
  'action_module_versions.publication_status': 32,
  'map_terminology_entries.request_key': 128,
  'map_terminology_entries.canonical_name': 128,
  'map_terminology_entries.term_status': 16,
  'map_authoring_proposals.request_key': 128,
  'map_authoring_proposals.accept_key': 128,
  'map_authoring_proposals.proposal_status': 16,
  'map_consumption_policies.consumption_mode': 32,
  'map_consumption_eligibility.eligibility_report_key': 128,
  'map_consumption_policy_commands.command_key': 128,
  'map_run_release_refs.manifest_digest': 64,
  'map_run_release_refs.consumer_version': 64,
  'map_selection_decisions.manifest_digest': 64,
  'map_selection_decisions.consumer_version': 64,
  'map_selection_decisions.asset_ref_key': 192,
  'map_selection_decisions.implementation_key': 192,
  'map_selection_decisions.coverage': 64,
  'map_selection_decisions.baseline_outcome': 64,
  'map_selection_decisions.selected_descriptor_digest': 64,
  'map_selection_decisions.consumption_mode': 32,
  'map_selection_decisions.decision_kind': 16,
  'map_selection_decisions.reason_code': 64,
  'target_access_policies.policy_digest': 64,
  'target_access_policy_commands.command_key': 128,
  'map_job_policies.default_depth': 16,
  'map_job_policy_commands.command_key': 128,
  'map_safe_entries.entry_name': 128,
  'map_safe_entries.entry_url': 2048,
  'map_safe_entries.arrival_name': 128,
  'map_safe_entries.command_key': 128,
  'map_jobs.job_kind': 16,
  'map_jobs.job_status': 16,
  'map_jobs.stop_reason': 64,
  'map_jobs.active_guard': 1,
  'map_job_commands.command_key': 128,
  'map_exploration_policies.explore_mode': 16,
  'map_exploration_policy_commands.command_key': 128,
  'schedules.consumer_key': 32,
  'schedules.enabled_guard': 1,
  'runtime_watermarks.name': 64,
  'periodic_slots.name': 64,
  'periodic_slots.mode': 16,
  'periodic_slots.lease_owner': 256,
  'periodic_slots.last_outcome': 16,
  'periodic_slots.last_error_class': 64,
  'periodic_slots.last_owner': 256,
  'schedule_versions.timezone': 64,
  'schedule_versions.window_start': 8,
  'schedule_versions.window_end': 8,
  'schedule_versions.misfire': 16,
  'schedule_versions.content_digest': 64,
  'schedule_occurrences.local_slot_key': 128,
  'schedule_occurrences.occurrence_key': 160,
  'schedule_occurrences.local_start_date': 16,
  'schedule_occurrences.time_rule_version': 32,
  'schedule_occurrences.admission_status': 16,
  'schedule_occurrences.reason': 64,
  'schedule_events.event_type': 64,
  'schedule_commands.command_key': 128,
  'api_instances.id': 256,
  'api_instances.id_source': 16,
  'api_instances.status': 16,
  'api_instances.version': 128,
  'api_instances.schema_logical_version': 32,
  'object_store_probes.store_kind': 32,
  'object_store_probes.status': 16,
  'object_store_probes.error_class': 64,
  'object_store_probes.probed_by': 288,
  'monitor_samples.metric_key': 128,
  'monitor_samples.scope': 16,
  'monitor_samples.scope_id': 256,
  'scenario_ai_calls.purpose': 32,
  'scenario_ai_calls.model': 256,
  'scenario_ai_calls.phase': 16,
  'scenario_ai_calls.error_code': 64,
}
export function nativeTables(driver: Driver, schemaName = 'cairn'): Tables {
  if (driver === 'postgres' && schemaName === 'cairn') return schema
  const result: Record<string, unknown> = {}
  for (const [key, table] of Object.entries(schema)) {
    if (!is(table, Table)) continue
    const name = getTableName(table)
    const columns: Record<string, any> = {}
    for (const [prop, column] of Object.entries(getTableColumns(table))) {
      const c = column as any
      let b: any
      if (c.columnType === 'PgUUID')
        b =
          driver === 'postgres'
            ? pg.uuid(c.name)
            : driver === 'mysql'
              ? mysql.varchar(c.name, { length: 36 })
              : sqlite.text(c.name)
      else if (c.columnType === 'PgBoolean')
        b =
          driver === 'postgres'
            ? pg.boolean(c.name)
            : driver === 'mysql'
              ? mysql.boolean(c.name)
              : sqlite.integer(c.name, { mode: 'boolean' })
      else if (c.columnType === 'PgInteger')
        b =
          driver === 'postgres'
            ? pg.integer(c.name)
            : driver === 'mysql'
              ? mysql.int(c.name)
              : sqlite.integer(c.name)
      else if (c.columnType === 'PgBigInt64' || c.columnType === 'PgBigInt53')
        b =
          driver === 'postgres'
            ? pg.bigint(c.name, { mode: 'number' })
            : driver === 'mysql'
              ? mysql.bigint(c.name, { mode: 'number' })
              : sqlite.integer(c.name)
      else if (c.columnType === 'PgDoublePrecision')
        b =
          driver === 'postgres'
            ? pg.doublePrecision(c.name)
            : driver === 'mysql'
              ? mysql.double(c.name)
              : sqlite.real(c.name)
      else if (c.columnType === 'PgTimestamp')
        b =
          driver === 'postgres'
            ? pg.timestamp(c.name, { withTimezone: true })
            : driver === 'mysql'
              ? mysql.datetime(c.name, { mode: 'date', fsp: 3 })
              : sqliteDate(c.name)
      else if (c.columnType === 'PgJsonb')
        b =
          driver === 'postgres'
            ? pg.jsonb(c.name)
            : driver === 'mysql'
              ? mysql.json(c.name)
              : sqlite.text(c.name, { mode: 'json' })
      else if (c.columnType === 'PgCustomColumn')
        b =
          driver === 'postgres'
            ? pg.customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })(
                c.name,
              )
            : driver === 'mysql'
              ? mysqlBytes(c.name)
              : sqliteBytes(c.name)
      else if (c.columnType === 'PgText') {
        const length =
          indexedTextLimits[`${name}.${c.name}`] ??
          (['status', 'holder_worker_id', 'owner_worker_id'].includes(c.name) ? 256 : undefined)
        b =
          driver === 'postgres'
            ? pg.text(c.name)
            : driver === 'mysql'
              ? length
                ? mysql.varchar(c.name, { length })
                : mysql.longtext(c.name)
              : sqlite.text(c.name)
      } else throw new Error(`Unsupported logical column: ${name}.${c.name} (${c.columnType})`)
      if (c.notNull) b = b.notNull()
      if (c.primary) b = b.primaryKey()
      if (c.defaultFn) b = b.$defaultFn(c.defaultFn)
      if (c.default !== undefined) b = b.default(is(c.default, SQL) ? nowFor(driver) : c.default)
      columns[prop] = b
    }
    result[key] =
      driver === 'postgres'
        ? pg.pgSchema(schemaName).table(name, columns)
        : driver === 'mysql'
          ? mysql.mysqlTable(name, columns)
          : sqlite.sqliteTable(name, columns)
  }
  return result as Tables
}

export function nowFor(driver: Driver): SQL {
  return driver === 'sqlite'
    ? sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    : driver === 'mysql'
      ? sql`CURRENT_TIMESTAMP(3)`
      : sql`now()`
}
export function databaseNow(db: object): SQL {
  return nowFor(driverOf(db))
}
export function afterSeconds(
  db: object,
  seconds: number | SQLWrapper,
  base: SQLWrapper = databaseNow(db),
): SQL {
  switch (driverOf(db)) {
    case 'postgres':
      return sql`${base} + (${seconds} * interval '1 second')`
    case 'mysql':
      return sql`TIMESTAMPADD(SECOND, ${seconds}, ${base})`
    case 'sqlite':
      return sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${base}, ${seconds} || ' seconds')`
  }
}
export async function clockNow(db: Db): Promise<Date> {
  const [row] = await db.select({ at: databaseNow(db) }).from(sql`(SELECT 1) AS clock_sample`)
  return new Date(
    driverOf(db) === 'mysql' && typeof row!.at === 'string'
      ? `${row!.at.replace(' ', 'T')}Z`
      : (row!.at as string),
  )
}

export function locked<Q>(db: object, query: Q, skipLocked = false): Q {
  return driverOf(db) === 'sqlite'
    ? query
    : (query as any).for('update', skipLocked ? { skipLocked: true } : undefined)
}
export async function atomic<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return inTransaction(db) ? fn(db) : db.transaction((tx) => fn(tx as unknown as Db))
}

export async function updateRows<T extends PgTable, S extends SelectedFields = T['_']['columns']>(
  db: Db,
  table: T,
  values: PgUpdateSetSource<T>,
  where: SQL | undefined,
  fields?: S,
): Promise<SelectResultFields<S>[]> {
  if (driverOf(db) !== 'mysql')
    return (await db
      .update(table)
      .set(values)
      .where(where)
      .returning(fields as any)) as SelectResultFields<S>[]
  return atomic(db, async (tx) => {
    const id = Object.values(getTableColumns(table)).find((c) => c.primary)
    if (!id) throw new Error('updateRows requires a single immutable primary key')
    const rows = await locked(
      tx,
      tx
        .select({ id })
        .from(table as any)
        .where(where),
    )
    if (!rows.length) return []
    const keys = inArray(
      id,
      rows.map((r) => r.id),
    )
    await tx.update(table).set(values).where(keys)
    return (await tx
      .select(fields as any)
      .from(table as any)
      .where(keys)) as SelectResultFields<S>[]
  })
}
export async function insertIgnoreRows<T extends PgTable>(
  db: Db,
  table: T,
  values: PgInsertValue<T> | Array<PgInsertValue<T>>,
): Promise<number> {
  const rows = Array.isArray(values) ? values : [values]
  if (rows.length === 0) return 0
  if (driverOf(db) === 'mysql') {
    const result = (await (db as any).insert(table).ignore().values(rows)) as [{ affectedRows?: number } | undefined]
    return Number(result[0]?.affectedRows ?? 0)
  }
  const inserted = (await db.insert(table).values(rows).onConflictDoNothing().returning()) as InferSelectModel<T>[]
  return inserted.length
}

export function sampleBucketAt(db: object, intervalMs: number, base: SQLWrapper = databaseNow(db)): SQL {
  const seconds = Math.max(intervalMs, 1) / 1000
  switch (driverOf(db)) {
    case 'postgres':
      return sql`to_timestamp(floor(extract(epoch from ${base}) / ${seconds}) * ${seconds})`
    case 'mysql':
      return sql`FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${base}) / ${seconds}) * ${seconds})`
    case 'sqlite':
      return sql`strftime('%Y-%m-%dT%H:%M:%fZ', datetime((cast(strftime('%s', ${base}) as integer) / ${seconds}) * ${seconds}, 'unixepoch'))`
  }
}

export async function insertRows<T extends PgTable>(
  db: Db,
  table: T,
  values: PgInsertValue<T>,
): Promise<InferSelectModel<T>[]> {
  if (driverOf(db) !== 'mysql')
    return (await db.insert(table).values(values).returning()) as InferSelectModel<T>[]
  return atomic(db, async (tx) => {
    const columns = getTableColumns(table)
    const row: any = { ...values }
    for (const [key, c] of Object.entries(columns))
      if (row[key] === undefined && c.defaultFn) row[key] = c.defaultFn()
    if (!row.id) throw new Error('insertRows requires an application-generated id')
    await tx.insert(table).values(row)
    return (await tx
      .select()
      .from(table as any)
      .where(sql`${(table as any).id} = ${row.id}`)) as InferSelectModel<T>[]
  })
}
export async function deleteRows<T extends PgTable, S extends SelectedFields = T['_']['columns']>(
  db: Db,
  table: T,
  where: SQL | undefined,
  fields?: S,
): Promise<SelectResultFields<S>[]> {
  if (driverOf(db) !== 'mysql')
    return (await db
      .delete(table)
      .where(where)
      .returning(fields as any)) as SelectResultFields<S>[]
  return atomic(db, async (tx) => {
    const rows = await locked(
      tx,
      tx
        .select(fields as any)
        .from(table as any)
        .where(where),
    )
    await tx.delete(table).where(where)
    return rows as SelectResultFields<S>[]
  })
}

export function jsonText(db: object, column: SQLWrapper, path: string[]): SQL {
  const driver = driverOf(db)
  if (driver === 'postgres') return sql`${column} #>> ${'{' + path.join(',') + '}'}`
  const jsonPath = '$.' + path.join('.')
  if (driver === 'mysql') return sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath}))`
  return sql`json_extract(${column}, ${jsonPath})`
}

export function jsonHasKey(db: object, column: SQLWrapper, key: string): SQL {
  const driver = driverOf(db)
  if (driver === 'postgres') return sql`${column}->${key} IS NOT NULL`
  if (driver === 'mysql') return sql`JSON_EXTRACT(${column}, ${'$.' + key}) IS NOT NULL`
  return sql`json_extract(${column}, ${'$.' + key}) IS NOT NULL`
}

export function jsonArrayIncludes(db: object, column: SQLWrapper, value: string): SQL {
  const driver = driverOf(db)
  if (driver === 'postgres') {
    return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}) AS cap(value) WHERE cap.value = ${value})`
  }
  if (driver === 'mysql') return sql`JSON_CONTAINS(${column}, JSON_QUOTE(${value}))`
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`
}

export function jsonArrayLength(db: object, column: SQLWrapper): SQL {
  const driver = driverOf(db)
  if (driver === 'postgres') return sql`COALESCE(jsonb_array_length(${column}), 0)`
  if (driver === 'mysql') return sql`COALESCE(JSON_LENGTH(${column}), 0)`
  return sql`COALESCE(json_array_length(${column}), 0)`
}
