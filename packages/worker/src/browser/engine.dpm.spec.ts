/**
 * L3：真实 SNC DPM 只读路径。默认 skip；CAIRN_L3_DPM=1 时必须跑通，失败不准 skip。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  findLiveSession,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { ensureTargetAccountCredential } from '@cairn/db'
import { DEV_CREDENTIAL_KEY, LOCAL_SECRET_PROVIDER, type Step } from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

const ENABLED = process.env.CAIRN_L3_DPM === '1'
const CATALOG = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../tests/target-snc-dpm/catalog.json'), 'utf8'),
) as {
  name: string
  loginFields: {
    username: { by: 'css'; value: string }
    password: { by: 'css'; value: string }
    submit: { by: 'css'; value: string }
  }
  account: { displayName: string }
}

function loadLocalOverlay(): {
  entryUrl?: string
  loginUrl?: string
  username?: string
  password?: string
} {
  try {
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../tests/target-snc-dpm/catalog.local.json'), 'utf8'),
    ) as {
      entryUrl?: string
      loginUrl?: string
      account?: { username?: string; password?: string }
    }
    return {
      entryUrl: raw.entryUrl,
      loginUrl: raw.loginUrl,
      username: raw.account?.username,
      password: raw.account?.password,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim()
  }
  return ''
}

const LOCAL = loadLocalOverlay()
const ENTRY_URL = firstNonEmpty(process.env.CAIRN_L3_DPM_URL, LOCAL.entryUrl)
const LOGIN_URL = firstNonEmpty(process.env.CAIRN_L3_DPM_LOGIN_URL, LOCAL.loginUrl)
const USERNAME = firstNonEmpty(process.env.CAIRN_L3_DPM_USERNAME, LOCAL.username)
const PASSWORD = firstNonEmpty(process.env.CAIRN_L3_DPM_PASSWORD, LOCAL.password)
const SCHEMA = `cairn_test_${Date.now().toString(36)}_dpm`

async function requireChromium(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await Promise.race([
    chromium.launch({ headless: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('launch timeout')), 8_000)),
  ])
  await browser.close()
}

function requireOverlay(): void {
  const missing = [
    ['CAIRN_L3_DPM_URL', ENTRY_URL],
    ['CAIRN_L3_DPM_LOGIN_URL', LOGIN_URL],
    ['CAIRN_L3_DPM_USERNAME', USERNAME],
    ['CAIRN_L3_DPM_PASSWORD', PASSWORD],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length === 0) return
  throw new Error(
    `CAIRN_L3_DPM=1 时必须提供 ${missing.join('、')}（环境变量或 tests/target-snc-dpm/catalog.local.json）`,
  )
}

async function requireReachable(): Promise<void> {
  const res = await Promise.race([
    fetch(LOGIN_URL, { redirect: 'follow' }),
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
  let objects: ObjectService
  let objectDir = ''

  beforeAll(async () => {
    requireOverlay()
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
      loginUrl: LOGIN_URL,
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
    await ensureTargetAccountCredential(handle, {
      account: {
        id: accountId,
        targetId,
        displayName: CATALOG.account.displayName,
        username: USERNAME,
        configRevision: 1,
        secretId,
        secretProvider: LOCAL_SECRET_PROVIDER,
      },
      sealed: { id: secretId, provider: LOCAL_SECRET_PROVIDER },
      actor: { id: actorId },
    })
    objectDir = mkdtempSync(join(tmpdir(), 'cairn-dpm-obj-'))
    objects = new ObjectService(
      handle,
      new LocalObjectStore(objectDir, 32 * 1024 * 1024),
      {
        retainDays: 30,
        pendingTtlSeconds: 3600,
        maxBytes: 32 * 1024 * 1024,
        videoMaxBytes: 128 * 1024 * 1024,
        uploadMaxAttempts: 3,
      },
    )
    workerId = `dpm-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-dpm-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 90,
        defaultAuthWaitSeconds: 60,
        heartbeatMs: 60_000,
      },
      secretsProvider,
      objects,
    )
    await manager.reconcileOwn()
  })

  afterAll(async () => {
    await manager?.shutdown()
    await handle?.close()
    if (objectDir) rmSync(objectDir, { recursive: true, force: true })
  }, 30_000)

  it('自动登录后只读提取「数据库」菜单，第二次运行复用同一会话', async () => {
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
    const firstSession = await findLiveSession(handle.db, { targetId, targetAccountId: accountId })
    const repeated = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, targetAccountId: accountId, actor: { id: actorId } })
    const repeatedGrant = await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 90 })
    expect(repeatedGrant?.runId).toBe(repeated.detail.id)
    await engine.execute(repeated.detail.id, { grant: repeatedGrant! })
    const repeatedDetail = await getRun(handle.db, repeated.detail.id)
    expect(repeatedDetail.status).toBe('SUCCEEDED')
    expect(String(repeatedDetail.context.module)).toContain('数据库')
    expect((await findLiveSession(handle.db, { targetId, targetAccountId: accountId }))?.id).toBe(firstSession?.id)
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

  it('失败截图可取回字节，业务结论仍是 FAILED', async () => {
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
        name: '点不存在',
        type: 'click',
        effectType: 'READ_ONLY',
        input: {
          target: {
            framePath: [],
            candidates: [{ by: 'text', value: '绝不存在的菜单项-cairn-s04' }],
          },
        },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `dpm-shot-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      evidencePolicy: { screenshot: 'on_failure' },
      actor: { id: actorId },
    })
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 90,
    })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
    await engine.execute(created.detail.id, { grant: grant! })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('FAILED')
    const shot = (await listRunEvidence(handle.db, created.detail.id)).items.find(
      (item) => item.type === 'screenshot',
    )
    expect(shot?.status).toBe('available')
    expect(shot?.objectKey).toBeTruthy()
    const got = await objects.getObject(shot!.objectKey!)
    expect(got.contentType).toBe('image/png')
    expect(got.body.byteLength).toBeGreaterThan(100)
  })

  it('VE01：停留后的录像时长接近采集区间', async () => {
    const { readRunVideoPayload } = await import('@cairn/shared')
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
        name: '停留总览',
        type: 'wait',
        effectType: 'READ_ONLY',
        input: { kind: 'time', durationMs: 6_000 },
      },
      {
        id: newId(),
        name: '提取数据库菜单',
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
      {
        id: newId(),
        name: '停留数据库入口',
        type: 'wait',
        effectType: 'READ_ONLY',
        input: { kind: 'time', durationMs: 6_000 },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `dpm-ve01-${newId()}`,
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      evidencePolicy: { screenshot: 'always', video: 'always', trace: 'off' },
      actor: { id: actorId },
    })
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 90,
    })
    const engine = new ExecutionEngine(handle, createBrowserPort(manager, objects))
    await engine.execute(created.detail.id, { grant: grant! })
    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('SUCCEEDED')
    const video = (await listRunEvidence(handle.db, created.detail.id)).items.find((item) => item.type === 'video')
    const timing = readRunVideoPayload(video?.payload)?.timing
    expect(video?.status).toBe('available')
    expect(timing?.decodedFrames).toBeGreaterThanOrEqual(2)
    expect(timing && Math.abs(timing.decodedDurationMs - timing.capturedSpanMs)).toBeLessThanOrEqual(1_000)
    expect(timing && timing.capturedSpanMs).toBeGreaterThanOrEqual(10_000)
  })
})
