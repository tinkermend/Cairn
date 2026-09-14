import { Client } from 'pg'
import { createClient, type RedisClientType } from 'redis'
import {
  changeHintSchema,
  resolveChangeHintDriver,
  type ChangeHint,
  type ChangeHintDriver,
  type DbEnv,
  type ResolvedChangeHintDriver,
} from '@cairn/shared'
import { setChangeHintPublisher, type ChangeHintListener } from './hint.js'

const CHANNEL = 'cairn_run_observe'

export type ChangeHintBus = {
  readonly driver: ResolvedChangeHintDriver
  readonly realtime: boolean
  readonly namespace: string
  publish(hint: ChangeHint): Promise<void>
  subscribe(onHint: ChangeHintListener, onReconnect?: () => void): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export function createChangeHint(input: {
  hint: ChangeHintDriver
  redisUrl?: string
  namespace: string
  dbEnv: DbEnv
}): ChangeHintBus {
  const driver = resolveChangeHintDriver(input.hint, input.dbEnv.CAIRN_DB_DRIVER, Boolean(input.redisUrl))
  if (driver === 'postgres' && input.dbEnv.CAIRN_DB_DRIVER !== 'postgres') {
    throw new Error('CAIRN_CHANGE_HINT=postgres 只能用于 PostgreSQL')
  }
  if (driver === 'redis' && !input.redisUrl) {
    throw new Error('redis 变化提示必须配置 CAIRN_REDIS_URL')
  }
  const bus =
    driver === 'postgres'
      ? createPostgresHint(input.dbEnv, input.namespace)
      : driver === 'redis'
        ? createRedisHint(input.redisUrl!, input.namespace)
        : createNoneHint(input.namespace)
  setChangeHintPublisher((draft) => {
    void bus.publish({ namespace: input.namespace, runId: draft.runId, eventSeq: draft.eventSeq })
  })
  return bus
}

function createNoneHint(namespace: string): ChangeHintBus {
  return {
    driver: 'none',
    realtime: false,
    namespace,
    publish: async () => undefined,
    subscribe: async () => undefined,
    ping: async () => true,
    close: async () => {
      setChangeHintPublisher(null)
    },
  }
}

function createPostgresHint(env: DbEnv, namespace: string): ChangeHintBus {
  if (env.CAIRN_DB_DRIVER !== 'postgres') {
    throw new Error('PostgreSQL 变化提示需要 postgres 连接配置')
  }
  const connection = {
    host: env.CAIRN_DB_HOST,
    port: env.CAIRN_DB_PORT,
    database: env.CAIRN_DB_NAME,
    user: env.CAIRN_DB_USER,
    password: env.CAIRN_DB_PASSWORD,
  }
  const publisher = new Client(connection)
  let publisherReady = false
  let listener: Client | null = null
  let closed = false
  async function ensurePublisher() {
    if (publisherReady) return
    await publisher.connect()
    publisherReady = true
  }
  return {
    driver: 'postgres',
    realtime: true,
    namespace,
    async publish(hint) {
      await ensurePublisher()
      await publisher.query('SELECT pg_notify($1, $2)', [
        CHANNEL,
        JSON.stringify(changeHintSchema.parse(hint)),
      ])
    },
    async subscribe(onHint, onReconnect) {
      const connect = async () => {
        const client = new Client(connection)
        client.on('notification', (message) => {
          if (message.channel !== CHANNEL || !message.payload) return
          try {
            const parsed = changeHintSchema.safeParse(JSON.parse(message.payload) as unknown)
            if (!parsed.success || parsed.data.namespace !== namespace) return
            onHint(parsed.data)
          } catch {
            return
          }
        })
        client.on('error', () => undefined)
        await client.connect()
        await client.query(`LISTEN ${CHANNEL}`)
        listener = client
      }
      await connect()
      listener?.on('end', () => {
        if (closed) return
        void connect()
          .then(() => onReconnect?.())
          .catch((error) => {
            console.error('[db] change-hint LISTEN reconnect failed', error)
          })
      })
    },
    async ping() {
      try {
        await ensurePublisher()
        await publisher.query('SELECT 1')
        return true
      } catch {
        return false
      }
    },
    async close() {
      closed = true
      setChangeHintPublisher(null)
      if (publisherReady) await publisher.end().catch(() => undefined)
      if (listener) await listener.end().catch(() => undefined)
      listener = null
    },
  }
}

async function closeRedis(client: RedisClientType): Promise<void> {
  try {
    if (client.isOpen) await client.quit()
  } catch {
    try {
      await client.disconnect()
    } catch {
      return
    }
  }
}

function createRedisHint(url: string, namespace: string): ChangeHintBus {
  const channel = `${CHANNEL}:${namespace}`
  const publisher: RedisClientType = createClient({ url })
  const subscriber: RedisClientType = createClient({ url })
  let opened = false
  async function ensure() {
    if (opened) return
    await publisher.connect()
    opened = true
  }
  return {
    driver: 'redis',
    realtime: true,
    namespace,
    async publish(hint) {
      await ensure()
      await publisher.publish(channel, JSON.stringify(changeHintSchema.parse(hint)))
    },
    async subscribe(onHint, onReconnect) {
      await subscriber.connect()
      subscriber.on('reconnecting', () => onReconnect?.())
      await subscriber.subscribe(channel, (raw) => {
        try {
          const parsed = changeHintSchema.safeParse(JSON.parse(raw) as unknown)
          if (!parsed.success || parsed.data.namespace !== namespace) return
          onHint(parsed.data)
        } catch {
          return
        }
      })
    },
    async ping() {
      try {
        await ensure()
        await publisher.ping()
        return true
      } catch {
        return false
      }
    },
    async close() {
      setChangeHintPublisher(null)
      await closeRedis(subscriber)
      await closeRedis(publisher)
    },
  }
}
