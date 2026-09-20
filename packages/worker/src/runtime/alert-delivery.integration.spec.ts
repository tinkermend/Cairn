import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getOrCreatePlatformConfig, registerStandaloneSecret, updatePlatformConfig } from '@cairn/db'
import {
  consoleAccounts,
  eq,
  evaluateAlerts,
  markLostWorkers,
  newId,
  openIsolatedDb,
  registerWorker,
  workers,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  FACTORY_ALERT_RULES,
  LOCAL_SECRET_PROVIDER,
  SESSION_OCCUPANCY_PROTOCOL,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { deliverDueAlertNotices } from './alert-delivery.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_alrt`

describe('告警投递闭环（集成）', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'alert',
      email: `alrt-${actorId}@example.com`,
      status: 'active',
    })
    await getOrCreatePlatformConfig(handle)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('RMD10 失联后本机 Webhook 收到 firing，恢复后收到 resolved', async () => {
    const received: Array<{ kind?: string; metricKey?: string; consolePath?: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof received)[number])
        res.statusCode = 204
        res.end()
      })
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') reject(new Error('no address'))
        else resolve(address.port)
      })
    })
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    const secretId = newId()
    const channelId = newId()
    await registerStandaloneSecret(handle, {
      id: secretId,
      ciphertext: secrets.encrypt(
        secretId,
        JSON.stringify({ v: 1, url: `http://127.0.0.1:${port}/hook` }),
      ),
    })
    const current = await getOrCreatePlatformConfig(handle)
    await updatePlatformConfig(handle, {
      expectedRevision: current.revision,
      reason: '测试失联闭环',
      document: {
        ...current.document,
        alerting: {
          channels: [
            {
              id: channelId,
              name: '本机接收器',
              kind: 'webhook',
              enabled: true,
              secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
              urlHost: '127.0.0.1',
            },
          ],
          rules: FACTORY_ALERT_RULES.map((rule) =>
            rule.id === 'factory.worker.lost'
              ? { ...rule, enabled: true, forSeconds: 0, channelIds: [channelId] }
              : rule,
          ),
        },
      },
      actor: { id: actorId },
    })

    const workerId = `loop-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    await handle.db.update(workers).set({ heartbeatExpiresAt: new Date(Date.now() - 1_000) }).where(eq(workers.id, workerId))
    expect(await markLostWorkers(handle.db)).toContain(workerId)
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const firing = await deliverDueAlertNotices({ db: handle, secrets, allowPrivateWebhook: true })
    expect(firing.sent).toBe(1)
    expect(received.some((item) => item.kind === 'firing' && item.metricKey === 'worker.status.lost')).toBe(true)
    expect(received[0]?.consolePath).toBe('/monitoring')
    expect(JSON.stringify(received[0])).not.toMatch(/secret|token|password/i)

    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    expect((await evaluateAlerts(handle.db)).resolved).toBe(1)
    const resolved = await deliverDueAlertNotices({ db: handle, secrets, allowPrivateWebhook: true })
    expect(resolved.sent).toBe(1)
    expect(received.some((item) => item.kind === 'resolved')).toBe(true)

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })
})
