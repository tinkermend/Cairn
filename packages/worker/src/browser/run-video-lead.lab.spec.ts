/**
 * 验证方案 B 优化效果：
 * 录像起始时间与步骤 1 执行起点紧密对齐，消除原本 4~5 秒的 about:blank 前置空白。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  listRunEvidence,
  loadRunDetail,
  newId,
  openIsolatedDb,
  registerWorker,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { ensureTargetAccountCredential } from '@cairn/db'
import {
  buildRunVideoChapters,
  chapterAtPlayhead,
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  readRunVideoPayload,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'
import { isPlayableWebm } from './video-encoder.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_vlead`
const LAB_PUBLIC = resolve(__dirname, '../../../../tests/target-surface-lab/public')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

describe('运行录像前置空白治理验证（方案 B 真实浏览器场景）', { timeout: 120_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let secretId: string
  let workerId: string
  let workerInstanceId: string
  let objectDir: string
  let objects: ObjectService
  let secretsProvider: LocalSecretProvider

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    secretId = newId()
    secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

    // 启动靶场服务（提供企业费用报销页面 file-submission.html）
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const relative = url.pathname === '/' ? 'file-submission.html' : url.pathname.replace(/^\/+/, '')
      const file = join(LAB_PUBLIC, relative)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not file')
        const body = await readFile(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('lab port')
    baseUrl = `http://127.0.0.1:${address.port}`

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'lead-test-admin',
      email: `lead-${actorId.slice(0, 8)}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `lead-${SCHEMA.slice(-6)}`,
      name: '企业费用报销与材料提报系统',
      entryUrl: `${baseUrl}/file-submission.html`,
      state: 'ACTIVE',
      createdByConsoleAccountId: actorId,
    })
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, 'lab-secret'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '测试报销员',
      username: 'lead-tester',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })
    await ensureTargetAccountCredential(handle, {
      account: {
        id: accountId,
        targetId,
        displayName: '测试报销员',
        username: 'lead-tester',
        configRevision: 1,
        secretId,
        secretProvider: LOCAL_SECRET_PROVIDER,
      },
      sealed: { id: secretId, provider: LOCAL_SECRET_PROVIDER },
      actor: { id: actorId },
    })

    objectDir = mkdtempSync(join(tmpdir(), 'cairn-vlead-obj-'))
    objects = new ObjectService(
      handle,
      new LocalObjectStore(objectDir, 32 * 1024 * 1024),
      {
        retainDays: 30,
        pendingTtlSeconds: 3600,
        maxBytes: 32 * 1024 * 1024,
        traceMaxBytes: 128 * 1024 * 1024,
        videoMaxBytes: 128 * 1024 * 1024,
        uploadMaxAttempts: 3,
      },
    )

    workerId = `vlead-worker-${SCHEMA.slice(-6)}`
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
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-vlead-prof-')),
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 60,
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
    if (server) {
      await new Promise<void>((done) => server!.close(() => done()))
    }
  }, 30_000)

  it('场景执行产出有效录像，且前置空白时间缩短至亚秒级（< 300ms），步骤 1 紧贴起点', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开费用报销申报系统',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${baseUrl}/file-submission.html` },
      },
      {
        id: newId(),
        name: '填写申请人姓名(必填)',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#applicant-name' }] },
          value: '张三 (EMP-1002)',
        },
      },
      {
        id: newId(),
        name: '勾选加急审批复选框(选填)',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#urgent-check' }] },
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `vlead-scenario-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
      evidencePolicy: { video: 'always', screenshot: 'always' },
    })
    const runId = created.detail.id

    const grant = await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 60 })
    expect(grant?.runId).toBe(runId)

    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)

    await engine.execute(runId, { grant: grant! })

    // 1. 验证运行成功
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('SUCCEEDED')

    // 2. 验证录像证据存在且可播
    const evidences = await listRunEvidence(handle.db, runId)
    const videoEvidence = evidences.items.find((e) => e.type === 'video')
    expect(videoEvidence).toBeDefined()
    expect(videoEvidence?.status).toBe('available')
    expect(videoEvidence?.objectKey).toBeTruthy()

    const videoObj = await objects.getObject(videoEvidence!.objectKey!)
    expect(isPlayableWebm(videoObj.body)).toBe(true)

    // 3. 核心断言：录像启动时间与步骤 1 起始时间的差距（前置空白）应极小（< 300ms），绝无此前 4.8 秒大白屏
    const payload = readRunVideoPayload(videoEvidence?.payload)
    expect(payload?.timing?.captureStartedAt).toBeTruthy()
    const captureStartedAtMs = Date.parse(payload!.timing!.captureStartedAt!)
    const stepRuns = detail.stepRuns ?? []
    expect(stepRuns.length).toBe(3)

    const step1StartedAtMs = Date.parse(stepRuns[0]!.startedAt!)
    const leadBlankMs = step1StartedAtMs - captureStartedAtMs

    // 验证前置空白在毫秒级内（方案 B 前为 ~4800ms）
    expect(leadBlankMs).toBeGreaterThanOrEqual(0)
    expect(leadBlankMs).toBeLessThan(300)

    // 4. 章节时间轴验证：步骤 1 起始时间紧贴 0 秒，回放 100ms 时即命中第 1 步，不再回退到「步骤之间」
    const runDetail = (await loadRunDetail(handle.db, runId))!
    const chapterModel = buildRunVideoChapters({
      run: runDetail,
      payload,
      evidenceItems: evidences.items,
    })

    expect(chapterModel.chapters.length).toBe(3)
    const firstChapter = chapterModel.chapters[0]!
    expect(firstChapter.ordinal).toBe(0)
    expect(firstChapter.name).toBe('打开费用报销申报系统')
    expect(firstChapter.fromMs).toBeLessThan(300)

    // 在 100ms 处即可识别出正在看步骤 1，消除原本整个进度条前半截「步骤之间」的尴尬现象
    const at100ms = chapterAtPlayhead(chapterModel.chapters, 100)
    expect(at100ms?.stepRunId).toBe(firstChapter.stepRunId)
  })
})
