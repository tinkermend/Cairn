import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2'
import { drizzle as sqliteDrizzle } from 'drizzle-orm/sqlite-proxy'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { Pool } from 'pg'
import { createPool } from 'mysql2/promise'
import type { DbEnv } from '@cairn/shared'
import { bindNative, nativeTables, schemaFor, type Driver } from './native.js'

/** Private common Drizzle query projection; never part of the business API. */
export type Db = NodePgDatabase<Record<string, never>>
export interface DbHandle {
  db: Db
  driver: Driver
  pool?: Pool
  ping(): Promise<boolean>
  close(): Promise<void>
  /** Native administrative SQL, only migrations/testing use it. */
  raw(statement: string, values?: unknown[]): Promise<Record<string, unknown>[]>
}

function bindTransactions(
  db: Db,
  driver: Driver,
  tables: ReturnType<typeof schemaFor>,
  inTx = false,
): Db {
  bindNative(db, driver, tables, inTx)
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (tx: Db) => Promise<unknown>, config?: unknown) =>
    transaction(
      (tx) => fn(bindTransactions(tx as unknown as Db, driver, tables, true)),
      (config ??
        (driver === 'mysql' && !inTx ? { isolationLevel: 'read committed' } : undefined)) as never,
    )) as Db['transaction']
  return db
}

export function createDb(env: DbEnv): DbHandle {
  if (env.CAIRN_DB_DRIVER === 'sqlite') return createSqlite(env.CAIRN_DB_FILE)
  if (env.CAIRN_DB_DRIVER === 'mysql') {
    const pool = createPool({
      host: env.CAIRN_DB_HOST,
      port: env.CAIRN_DB_PORT,
      database: env.CAIRN_DB_NAME,
      user: env.CAIRN_DB_USER,
      password: env.CAIRN_DB_PASSWORD,
      timezone: 'Z',
      charset: 'utf8mb4_bin',
      connectionLimit: 10,
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
    pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00', collation_connection = 'utf8mb4_0900_bin'")
    })
    const db = bindTransactions(mysqlDrizzle(pool) as unknown as Db, 'mysql', nativeTables('mysql'))
    return {
      db,
      driver: 'mysql',
      ping: async () => {
        await pool.query('SELECT 1')
        return true
      },
      close: () => pool.end(),
      raw: async (statement, values) => {
        const [rows] = await pool.query(statement, values as never)
        return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
      },
    }
  }
  const pool = new Pool({
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
    options: `-c search_path=${env.CAIRN_DB_SCHEMA},public -c timezone=UTC`,
  })
  pool.on('error', (error) => {
    console.error(`[db] 空闲连接错误：${error.message}`)
  })
  const db = bindTransactions(
    drizzle(pool),
    'postgres',
    nativeTables('postgres', env.CAIRN_DB_SCHEMA),
  )
  return {
    db,
    pool,
    driver: 'postgres',
    ping: async () => {
      await pool.query('SELECT 1')
      return true
    },
    close: () => pool.end(),
    raw: async (statement, values) => (await pool.query(statement, values)).rows,
  }
}

async function busyRetry<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return fn()
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'errcode' in error &&
          Number(error.errcode) % 256 === 5
        ) ||
        Date.now() >= deadline
      )
        throw error
      await setTimeout(5 + Math.random() * 20)
    }
  }
}

function createSqlite(file: string): DbHandle {
  const path = resolve(file)
  mkdirSync(dirname(path), { recursive: true })
  const tables = nativeTables('sqlite')
  const connections = new Set<DatabaseSync>()
  let closed = false
  let savepointSequence = 0
  function connect(): DatabaseSync {
    if (closed) throw new Error('Database is closed')
    const connection = new DatabaseSync(path)
    connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;')
    if (connection.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1)
      throw new Error('SQLite foreign keys unavailable')
    connections.add(connection)
    return connection
  }
  const root = connect()
  root.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
  function orm(connection: DatabaseSync, inTx = false): Db {
    const db = sqliteDrizzle(async (statement, values, method) =>
      busyRetry(() => {
        const prepared = connection.prepare(statement)
        prepared.setReturnArrays(true)
        const params = values as SQLInputValue[]
        if (method === 'run') {
          prepared.run(...params)
          return { rows: [] }
        }
        if (method === 'get') return { rows: (prepared.get(...params) ?? []) as unknown[] }
        return { rows: prepared.all(...params) as unknown as unknown[][] }
      }),
    ) as unknown as Db
    bindNative(db, 'sqlite', tables, inTx)
    // Dedicated transaction connection prevents an awaited callback from leaking
    // writes into another request. BEGIN IMMEDIATE serializes local writers.
    db.transaction = (async (fn: (tx: Db) => Promise<unknown>) => {
      if (inTx) {
        // Match native PG/MySQL nested transactions without opening another writer.
        const name = `cairn_sp_${++savepointSequence}`
        connection.exec(`SAVEPOINT ${name}`)
        try {
          const value = await fn(db)
          connection.exec(`RELEASE SAVEPOINT ${name}`)
          return value
        } catch (error) {
          connection.exec(`ROLLBACK TO SAVEPOINT ${name}`)
          connection.exec(`RELEASE SAVEPOINT ${name}`)
          throw error
        }
      }
      const txConnection = connect()
      try {
        await busyRetry(() => txConnection.exec('BEGIN IMMEDIATE'))
        try {
          const value = await fn(orm(txConnection, true))
          await busyRetry(() => txConnection.exec('COMMIT'))
          return value
        } catch (error) {
          txConnection.exec('ROLLBACK')
          throw error
        }
      } finally {
        connections.delete(txConnection)
        txConnection.close()
      }
    }) as Db['transaction']
    return db
  }
  return {
    db: orm(root),
    driver: 'sqlite',
    ping: async () => {
      root.prepare('SELECT 1').get()
      return true
    },
    close: async () => {
      closed = true
      for (const connection of connections) connection.close()
      connections.clear()
    },
    raw: async (statement, values = []) =>
      busyRetry(() => {
        const prepared = root.prepare(statement)
        if (prepared.columns().length)
          return prepared.all(...(values as SQLInputValue[])) as Record<string, unknown>[]
        prepared.run(...(values as SQLInputValue[]))
        return []
      }),
  }
}
