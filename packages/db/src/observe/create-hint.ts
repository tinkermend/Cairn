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
    void bus
      .publish({ namespace: input.namespace, runId: draft.runId, eventSeq: draft.eventSeq })
      .catch((error) => {
        console.error('[db] change-hint publish failed', error)
      })
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

const LISTEN_RECONNECT_MS = 250
const LISTEN_RECONNECT_MAX_MS = 8_000

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
  let publisher: Client | null = null
  let connecting: Promise<Client> | null = null
  let listener: Client | null = null
  let closed = false
  let reconnectTimer: NodeJS.Timeout | undefined
  let reconnectDelay = LISTEN_RECONNECT_MS
  let reconnecting = false
  let onHintRef: ChangeHintListener | undefined
  let onReconnectRef: (() => void) | undefined

  function logClientError(client: Client, label: string) {
    client.on('error', (error) => {
      console.error(`[db] change-hint ${label} error`, error)
    })
  }

  async function ensurePublisher() {
    if (closed) throw new Error('change-hint closed')
    if (publisher) return publisher
    if (!connecting) {
      const client = new Client(connection)
      logClientError(client, 'publisher')
      connecting = client
        .connect()
        .then(() => {
          if (closed) {
            void client.end().catch(() => undefined)
            throw new Error('change-hint closed')
          }
          publisher = client
          client.on('end', () => {
            if (publisher === client) publisher = null
          })
          return client
        })
        .catch(async (error) => {
          await client.end().catch(() => undefined)
          throw error
        })
        .finally(() => {
          connecting = null
        })
    }
    return connecting
  }

  async function attachListener(onHint: ChangeHintListener) {
    const client = new Client(connection)
    logClientError(client, 'LISTEN')
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
    try {
      await client.connect()
      await client.query(`LISTEN ${CHANNEL}`)
    } catch (error) {
      await client.end().catch(() => undefined)
      throw error
    }
    if (closed) {
      await client.end().catch(() => undefined)
      throw new Error('change-hint closed')
    }
    const previous = listener
    listener = client
    client.on('end', () => {
      if (listener === client) listener = null
      scheduleReconnect()
    })
    if (previous && previous !== client) await previous.end().catch(() => undefined)
  }

  function scheduleReconnect() {
    if (closed || reconnecting || reconnectTimer || !onHintRef) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (closed || reconnecting || !onHintRef) return
      reconnecting = true
      void attachListener(onHintRef)
        .then(() => {
          reconnectDelay = LISTEN_RECONNECT_MS
          onReconnectRef?.()
        })
        .catch((error) => {
          console.error('[db] change-hint LISTEN reconnect failed', error)
          reconnectDelay = Math.min(reconnectDelay * 2, LISTEN_RECONNECT_MAX_MS)
        })
        .finally(() => {
          reconnecting = false
          if (!closed && !listener) scheduleReconnect()
        })
    }, reconnectDelay)
    reconnectTimer.unref()
  }

  return {
    driver: 'postgres',
    realtime: true,
    namespace,
    async publish(hint) {
      const client = await ensurePublisher()
      try {
        await client.query('SELECT pg_notify($1, $2)', [
          CHANNEL,
          JSON.stringify(changeHintSchema.parse(hint)),
        ])
      } catch (error) {
        if (publisher === client) {
          publisher = null
          await client.end().catch(() => undefined)
        }
        throw error
      }
    },
    async subscribe(onHint, onReconnect) {
      onHintRef = onHint
      onReconnectRef = onReconnect
      await attachListener(onHint)
    },
    async ping() {
      try {
        const client = await ensurePublisher()
        await client.query('SELECT 1')
        return true
      } catch {
        return false
      }
    },
    async close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      setChangeHintPublisher(null)
      const inFlight = connecting
      connecting = null
      if (publisher) await publisher.end().catch(() => undefined)
      publisher = null
      if (inFlight) {
        const client = await inFlight.catch(() => null)
        if (client) await client.end().catch(() => undefined)
      }
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
  publisher.on('error', (error) => {
    console.error('[db] change-hint redis publisher error', error)
  })
  subscriber.on('error', (error) => {
    console.error('[db] change-hint redis subscriber error', error)
  })
  let opening: Promise<unknown> | null = null
  let closed = false
  async function ensure() {
    if (closed) throw new Error('change-hint closed')
    if (publisher.isOpen) return
    if (!opening) {
      opening = publisher.connect().finally(() => {
        opening = null
      })
    }
    await opening
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
      closed = true
      setChangeHintPublisher(null)
      await closeRedis(subscriber)
      await closeRedis(publisher)
    },
  }
}
