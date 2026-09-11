/**
 * L3：真实 SNC DPM 只读路径。默认 skip；CAIRN_L3_DPM=1 时必须跑通，失败不准 skip。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db'
import { DEV_CREDENTIAL_KEY, LOCAL_SECRET_PROVIDER, type Step } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { ExecutionEngine } from '../engine/engine.js'

const ENABLED = process.env.CAIRN_L3_DPM === '1'
const CATALOG = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../tests/target-snc-dpm/catalog.json'), 'utf8'),
) as {
  name: string
  entryUrl: string
  loginUrl: string
  loginFields: {
    username: { by: 'css'; value: string }
    password: { by: 'css'; value: string }
    submit: { by: 'css'; value: string }
  }
  account: { displayName: string; username: string }
}

const ENTRY_URL = process.env.CAIRN_L3_DPM_URL ?? CATALOG.entryUrl
const USERNAME = process.env.CAIRN_L3_DPM_USERNAME ?? CATALOG.account.username
const PASSWORD = process.env.CAIRN_L3_DPM_PASSWORD ?? ''
const SCHEMA = `cairn_test_${Date.now().toString(36)}_dpm`

async function requireChromium(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await Promise.race([
    chromium.launch({ headless: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
  ])
  await browser.close()
}

async function requireReachable(): Promise<void> {
  const loginUrl = CATALOG.loginUrl
  const res = await Promise.race([
    fetch(loginUrl, { redirect: 'follow' }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unreachable')), 8_000)),
  ])
  if (!res.ok && res.status >= 500) throw new Error(`DPM 登录页 ${res.status}`)
}

describe.skipIf(!ENABLED)('ExecutionEngine × SNC DPM（L3 只读）', { timeout: 180_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let workerInstanceId: string

  beforeAll(async () => {
    await requireChromium()
    await requireReachable()
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    const secretId = newId()
    const secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'dpm-l3',
      email: `dpm-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `dpm-${SCHEMA.slice(-8)}`,
      name: CATALOG.name,
      entryUrl: ENTRY_URL,
      loginUrl: CATALOG.loginUrl,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: CATALOG.loginFields,
    })
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, PASSWORD),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: CATALOG.account.displayName,
      username: USERNAME,
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })
    workerId = `dpm-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 4,
      lostAfterSeconds: 60,
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-dpm-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 90,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretsProvider,
    )
    await manager.reconcileOwn()
  })

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
  }, 30_000)

  it('自动登录后只读提取「数据库」菜单', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开总览',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: ENTRY_URL },
      },
      {
        id: newId(),
        name: '提取模块名',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'module',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'role', value: 'menuitem', name: '数据库' }],
          },
          as: 'text',
        },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `dpm-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 90,
    })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant: grant! })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    expect(String(detail.context.module)).toContain('数据库')
  })

  it('缺口令走 WAITING_FOR_AUTH，不把 Run 写成 FAILED', async () => {
    const bareAccount = newId()
    await handle.db.insert(targetAccounts).values({
      id: bareAccount,
      targetId,
      displayName: '无密',
      username: `bare-${bareAccount.slice(0, 8)}`,
      status: 'active',
    })
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开总览',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: ENTRY_URL },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `dpm-auth-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: bareAccount,
      actor: { id: actorId },
    })
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 90,
    })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant: grant! })
    expect((await getRun(handle.db, created.detail.id)).status).toBe('WAITING_FOR_AUTH')
  })
})
