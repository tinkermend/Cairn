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
const contexts = new WeakMap<object, { driver: Driver; tables: Tables; inTransaction: boolean }>()
export function driverOf(db: object): Driver {
  return contexts.get(db)?.driver ?? 'postgres'
}
export function schemaFor(db: object): Tables {
  return contexts.get(db)?.tables ?? schema
}
export function bindNative(db: Db, driver: Driver, tables: Tables, inTransaction = false): Db {
  contexts.set(db, { driver, tables, inTransaction })
  return db
}
export function inTransaction(db: object): boolean {
  return contexts.get(db)?.inTransaction ?? false
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
  'console_accounts.email': 320,
  'console_identities.provider': 64,
  'console_identities.subject': 512,
  'console_roles.key': 64,
  'scenario_versions.source_digest': 64,
  'console_role_permissions.permission': 128,
  'targets.code': 256,
  'target_accounts.username': 256,
  'scenarios.name': 128,
  'runs.idempotency_key': 256,
  'recording_drafts.idempotency_key': 256,
  'stored_objects.object_key': 512,
  'workers.id': 256,
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
      else if (c.columnType === 'PgInteger')
        b =
          driver === 'postgres'
            ? pg.integer(c.name)
            : driver === 'mysql'
              ? mysql.int(c.name)
              : sqlite.integer(c.name)
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
