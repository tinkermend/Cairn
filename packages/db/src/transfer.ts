import { createHash } from 'node:crypto'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { z } from 'zod'
import {
  canonicalJson,
  runSnapshotSchema,
  scenarioDefinitionSchema,
  type DbEnv,
} from '@cairn/shared'
import type { Db } from './client.js'
import type { Database } from './database.js'
import { nativeHandle } from './database.js'
import { schemaFor, indexedTextLimits } from './native.js'
import { assertSchemaReady } from './migrate-native.js'
import { computeSnapshotDigest } from './runs/digest.js'
import * as logical from './schema/index.js'

const ORDER = [
  'consoleAccounts',
  'consoleRoles',
  'secrets',
  'platformAiSecretBindings',
  'targets',
  'consoleIdentities',
  'consoleRolePermissions',
  'consoleAccountRoles',
  'targetAccounts',
  'serviceCallers',
  'serviceCredentials',
  'credentialTargetGrants',
  'credentialTargetAccountGrants',
  'scenarios',
  'scenarioVersions',
  'scenarioDrafts',
  'workers',
  'runs',
  'stepRuns',
  'attempts',
  'storedObjects',
  'evidences',
  'browserSessions',
  'runLeases',
  'sessionLeases',
  'recordingDrafts',
  'recordingBindings',
  'recordingImportReceipts',
  'consoleAuditEvents',
  'platformConfig',
  'platformConfigRevisions',
  'assistantConversations',
  'assistantTurns',
  'platformAiCalls',
] as const
const LOGICAL_VERSION = '0030'
const bundleSchema = z
  .object({
    format: z.literal('cairn-database-v1'),
    logicalVersion: z.literal(LOGICAL_VERSION),
    sourceDriver: z.enum(['postgres', 'mysql', 'sqlite']),
    exportedAt: z.iso.datetime(),
    timestampPrecisionLoss: z.number().int().nonnegative(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type DatabaseBundle = z.infer<typeof bundleSchema>
export type ObjectToVerify = { objectKey: string; digest: string; byteSize: number }
export type TransferOptions = {
  /** Operator has stopped API, workers, schedulers and cleanup writers. */
  writersStopped: true
  /** PG may contain sub-millisecond timestamps; acceptance must be explicit. */
  allowMillisecondPrecisionLoss?: boolean
  verifyObject?: (object: ObjectToVerify) => Promise<void>
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
function ensureStopped(options: TransferOptions): void {
  if (options.writersStopped !== true) throw new Error('Stop all database writers before transfer')
}
function assertQuiescent(tables: DatabaseBundle['tables']): void {
  if (
    tables.runs!.some((r) =>
      ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH'].includes(String(r.status)),
    )
  )
    throw new Error('Runs must be settled before transfer')
  if (tables.workers!.some((r) => ['READY', 'DRAINING'].includes(String(r.status))))
    throw new Error('Workers must be stopped before transfer')
  if (tables.browserSessions!.some((r) => r.status !== 'CLOSED'))
    throw new Error(
      'Unclosed browser sessions retain ownership; close or explicitly dispose them first',
    )
  if (['runLeases', 'sessionLeases'].some((t) => tables[t]!.some((r) => r.status === 'ACTIVE')))
    throw new Error('Active leases cannot be transferred')
  if (['storedObjects', 'evidences'].some((t) => tables[t]!.some((r) => r.status === 'pending')))
    throw new Error('Pending evidence or uploads must be settled before transfer')
}
function assertHistoricalFacts(tables: DatabaseBundle['tables']): void {
  for (const row of tables.runs!) {
    const snapshot = runSnapshotSchema.parse(row.snapshot)
    if (
      computeSnapshotDigest(snapshot) !== snapshot.digest ||
      row.snapshotDigest !== snapshot.digest
    )
      throw new Error('Snapshot digest mismatch')
  }
  for (const row of tables.scenarioVersions!) scenarioDefinitionSchema.parse(row.definition)
}
async function verifyObjects(
  tables: DatabaseBundle['tables'],
  options: TransferOptions,
): Promise<void> {
  for (const object of tables.storedObjects!.filter((r) => r.status === 'available')) {
    if (!options.verifyObject)
      throw new Error(
        'Available objects require byte-size/digest verification against the configured ObjectStore',
      )
    if (
      typeof object.objectKey !== 'string' ||
      typeof object.digest !== 'string' ||
      typeof object.byteSize !== 'number'
    )
      throw new Error('Incomplete object metadata')
    await options.verifyObject({
      objectKey: object.objectKey,
      digest: object.digest,
      byteSize: object.byteSize,
    })
  }
}

async function readLogicalTables(db: Db): Promise<DatabaseBundle['tables']> {
  const data: DatabaseBundle['tables'] = {}
  const native = schemaFor(db)
  for (const key of ORDER) {
    const rows = await db.select().from(native[key])
    const columns = getTableColumns(logical[key])
    data[key] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => {
          const column = columns[name as keyof typeof columns] as { columnType: string }
          return [
            name,
            value === null
              ? null
              : column.columnType === 'PgTimestamp'
                ? (value as Date).toISOString()
                : column.columnType === 'PgCustomColumn'
                  ? Buffer.from(value as Uint8Array).toString('base64')
                  : value,
          ]
        }),
      ),
    ) as DatabaseBundle['tables'][string]
    data[key]!.sort((a, b) =>
      canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0,
    )
  }
  return data
}

export async function exportDatabase(
  database: Database,
  env: DbEnv,
  options: TransferOptions,
): Promise<DatabaseBundle> {
  ensureStopped(options)
  const handle = nativeHandle(database)
  await assertSchemaReady(handle, env)
  let timestampPrecisionLoss = 0
  // Detect, rather than silently discard, PG precision beyond the JS Date contract.
  if (handle.driver === 'postgres') {
    for (const key of ORDER)
      for (const c of Object.values(getTableColumns(logical[key]))) {
        if (c.columnType !== 'PgTimestamp') continue
        const rows = await handle.raw(
          `SELECT count(*) AS n FROM "${(env as Extract<DbEnv, { CAIRN_DB_DRIVER: 'postgres' }>).CAIRN_DB_SCHEMA}"."${getTableName(logical[key])}" WHERE MOD(CAST(EXTRACT(MICROSECONDS FROM "${c.name}") AS BIGINT), 1000) <> 0`,
        )
        timestampPrecisionLoss += Number(rows[0]!.n)
      }
    if (timestampPrecisionLoss && !options.allowMillisecondPrecisionLoss)
      throw new Error(
        `${timestampPrecisionLoss} timestamps exceed millisecond precision; export requires explicit precision-loss acceptance`,
      )
  }
  const tables = await handle.db.transaction(
    async (tx) => {
      const data = await readLogicalTables(tx as unknown as Db)
      assertQuiescent(data)
      assertHistoricalFacts(data)
      return data
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
  await verifyObjects(tables, options)
  const body = {
    format: 'cairn-database-v1' as const,
    logicalVersion: LOGICAL_VERSION,
    sourceDriver: handle.driver,
    exportedAt: new Date().toISOString(),
    timestampPrecisionLoss,
    tables,
  }
  return bundleSchema.parse({ ...body, digest: hash(body) })
}

export async function importDatabase(
  database: Database,
  env: DbEnv,
  input: unknown,
  options: TransferOptions,
): Promise<{ counts: Record<string, number>; digest: string }> {
  ensureStopped(options)
  const bundle = bundleSchema.parse(input)
  const { digest, ...body } = bundle
  if (hash(body) !== digest) throw new Error('Transfer archive digest mismatch')
  if (Object.keys(bundle.tables).sort().join() !== [...ORDER].sort().join())
    throw new Error('Transfer table set mismatch')
  if (bundle.timestampPrecisionLoss && !options.allowMillisecondPrecisionLoss)
    throw new Error(
      'Archive contains accepted timestamp precision loss; target requires the same explicit acceptance',
    )
  assertQuiescent(bundle.tables)
  assertHistoricalFacts(bundle.tables)
  await verifyObjects(bundle.tables, options)
  const handle = nativeHandle(database)
  await assertSchemaReady(handle, env)
  const native = schemaFor(handle.db)
  await handle.db.transaction(async (tx) => {
    // Only a freshly migrated target is eligible. Never merge into a live database.
    for (const key of ORDER.filter(
      (k) => !['consoleRoles', 'consoleRolePermissions'].includes(k),
    )) {
      if ((await tx.select().from(native[key]).limit(1)).length)
        throw new Error('Import target is not empty')
    }
    const roles = await tx.select().from(native.consoleRoles)
    if (roles.some((r) => r.kind !== 'system')) throw new Error('Import target has custom roles')
    await tx.delete(native.consoleRolePermissions)
    await tx.delete(native.consoleRoles)
    for (const key of ORDER) {
      const columns = getTableColumns(logical[key]) as Record<
        string,
        { columnType: string; notNull: boolean }
      >
      for (const row of bundle.tables[key]!) {
        if (Object.keys(row).sort().join() !== Object.keys(columns).sort().join())
          throw new Error(`Column set mismatch in ${key}`)
        const decoded: Record<string, unknown> = {}
        for (const [name, c] of Object.entries(columns)) {
          const value = row[name]
          if (value === null) {
            if (c.notNull) throw new Error(`Unexpected NULL in ${key}.${name}`)
            decoded[name] = null
            continue
          }
          if (c.columnType === 'PgTimestamp') {
            if (typeof value !== 'string' || new Date(value).toISOString() !== value)
              throw new Error(`Invalid timestamp in ${key}.${name}`)
            decoded[name] = new Date(value)
          } else if (c.columnType === 'PgCustomColumn') {
            if (
              typeof value !== 'string' ||
              Buffer.from(value, 'base64').toString('base64') !== value
            )
              throw new Error(`Invalid binary encoding in ${key}.${name}`)
            decoded[name] = Buffer.from(value, 'base64')
          } else {
            if (
              c.columnType === 'PgUUID' &&
              (typeof value !== 'string' || !z.uuid().safeParse(value).success)
            )
              throw new Error(`Invalid UUID in ${key}.${name}`)
            if (
              c.columnType === 'PgInteger' &&
              (typeof value !== 'number' ||
                !Number.isInteger(value) ||
                value < -2147483648 ||
                value > 2147483647)
            )
              throw new Error(`Invalid integer in ${key}.${name}`)
            if (c.columnType === 'PgText' && typeof value !== 'string')
              throw new Error(`Invalid text in ${key}.${name}`)
            decoded[name] = value
          }
        }
        for (const [name, value] of Object.entries(decoded)) {
          const column = getTableColumns(logical[key])[name as never] as { name: string }
          const limit = indexedTextLimits[`${getTableName(logical[key])}.${column.name}`]
          if (
            handle.driver === 'mysql' &&
            limit &&
            typeof value === 'string' &&
            [...value].length > limit
          )
            throw new Error(`Target column capacity exceeded: ${key}.${name}`)
        }
        await tx.insert(native[key]).values(decoded as never)
      }
    }
    // Verify while the import transaction is still open. A mismatch rolls back
    // all imported rows, so an unverified target can never become visible.
    const roundTrip = await readLogicalTables(tx as unknown as Db)
    if (hash(roundTrip) !== hash(bundle.tables)) throw new Error('Post-import verification failed')
  })
  return { counts: Object.fromEntries(ORDER.map((k) => [k, bundle.tables[k]!.length])), digest }
}
