import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  getOrCreatePlatformConfig,
  registerStandaloneSecret,
  updatePlatformConfig,
  writeOutboundConfig,
} from '@cairn/db'
import {
  consoleAccountRoles,
  consoleAccounts,
  consoleRoles,
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
  OUTBOUND_WORKER_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { deliverOutbound } from './outbound-delivery.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_alrt`

describe('告警投递闭环（集成）', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let dir: string
  let key: Buffer
  let cert: Buffer
  let originalCAs: string[]

  beforeAll(async () => {
    // 新投递链路只走 HTTPS：用一次性自签证书，并临时加入进程信任。
    dir = mkdtempSync(join(tmpdir(), 'cairn-alert-tls-'))
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,DNS:notification.test,IP:127.0.0.1',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    )
    key = readFileSync(join(dir, 'key.pem'))
    cert = readFileSync(join(dir, 'cert.pem'))
    originalCAs = getCACertificates()
    setDefaultCACertificates([...originalCAs, cert.toString()])
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'alert',
      email: `alrt-${actorId}@example.com`,
      status: 'active',
    })
    // 目的地登记只允许全范围管理员：与通知一期一致，走真实的渠道写入领域操作。
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db
      .insert(consoleAccountRoles)
      .values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    await getOrCreatePlatformConfig(handle)
  })

  afterAll(async () => {
    await handle?.close()
    if (originalCAs) setDefaultCACertificates(originalCAs)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('RMD10 失联后本机 Webhook 收到 firing，恢复后收到 resolved', async () => {
    const received: Array<{ kind?: string; metricKey?: string; consolePath?: string }> = []
    const server = createServer({ key, cert }, (req, res) => {
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
        JSON.stringify({ v: 1, url: `https://notification.test:${port}/hook` }),
      ),
    })
    const channel = {
      id: channelId,
      name: '本机接收器',
      kind: 'webhook' as const,
      enabled: true,
      allowAlerts: true,
      targetIds: [],
      version: 1,
      secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
      host: 'notification.test',
      recipients: [],
      // 沿用旧告警载荷，断言与迁移前的 RMD10 一致。
      format: 'legacy_alert@1' as const,
      replay: 'manual_on_unknown' as const,
    }
    // 渠道与启用开关走消息推送领域写入；此时库里还没有旧协议 Worker，不会被停写升级闸门挡住。
    let config = await getOrCreatePlatformConfig(handle)
    await writeOutboundConfig(handle, {
      actorId,
      expectedRevision: config.revision,
      reason: '测试失联闭环：登记渠道',
      channel,
    })
    config = await getOrCreatePlatformConfig(handle)
    await writeOutboundConfig(handle, {
      actorId,
      expectedRevision: config.revision,
      reason: '测试失联闭环：启用消息推送',
      settings: { enabled: true, consoleBaseUrl: '' },
    })
    const current = await getOrCreatePlatformConfig(handle)
    await updatePlatformConfig(handle, {
      expectedRevision: current.revision,
      reason: '测试失联闭环：启用失联规则',
      document: {
        ...current.document,
        alerting: {
          ...current.document.alerting,
          rules: FACTORY_ALERT_RULES.map((rule) =>
            rule.id === 'factory.worker.lost'
              ? { ...rule, enabled: true, forSeconds: 0, channelIds: [channelId] }
              : rule,
          ),
        },
      },
      actor: { id: actorId },
    })

    // 投递领取要求领取者是已登记、带通知协议的 Worker；与被判失联的测试节点分开。
    const deliverer = { workerId: `deliver-${newId().slice(0, 8)}`, instanceId: newId() }
    await registerWorker(handle.db, {
      ...deliverer,
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 3600,
      protocolCapabilities: [OUTBOUND_WORKER_PROTOCOL],
    })
    const deliver = () =>
      deliverOutbound({
        db: handle,
        ...deliverer,
        secrets,
        resolveDestination: async () => [{ address: '127.0.0.1', family: 4 }],
      })

    const workerId = `loop-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, OUTBOUND_WORKER_PROTOCOL],
    })
    await handle.db.update(workers).set({ heartbeatExpiresAt: new Date(Date.now() - 1_000) }).where(eq(workers.id, workerId))
    expect(await markLostWorkers(handle.db)).toContain(workerId)
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    await deliver()
    expect(received.some((item) => item.kind === 'firing' && item.metricKey === 'worker.status.lost')).toBe(true)
    expect(received[0]?.consolePath).toBe('/monitoring')
    expect(JSON.stringify(received[0])).not.toMatch(/secret|token|password/i)

    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, OUTBOUND_WORKER_PROTOCOL],
    })
    expect((await evaluateAlerts(handle.db)).resolved).toBe(1)
    await deliver()
    expect(received.some((item) => item.kind === 'resolved')).toBe(true)

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })
})
