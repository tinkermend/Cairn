import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  commitTargetFixtureUpload,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  grantAdminScope,
  listRunEvidence,
  newId,
  openIsolatedDb,
  registerWorker,
  reserveTargetFixtureUpload,
  secrets,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { ensureTargetAccountCredential } from '@cairn/db'
import {
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  RUN_FILE_HANDLE_KIND,
  type RunFileHandle,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'
import { existsSync } from 'node:fs'
import { runFileWorkspaceDir } from '../engine/run-file-workspace.js'

type LabServerHandle = {
  port: number
  url: string
  close: () => Promise<void>
}

const SCHEMA = `cairn_test_${Date.now().toString(36)}_fsub`

describe('浏览器文件上传/下载与Target夹具全链路业务系统验证（L2 真机真服）', { timeout: 180_000 }, () => {
  let lab: LabServerHandle
  let handle: DbHandle
  let manager: BrowserSessionManager
  let objects: ObjectService
  let objectDir: string
  let targetId: string
  let accountId: string
  let secretId: string
  let actorId: string
  let workerId: string
  let workerInstanceId: string
  let fixtureId: string
  let fixtureDigest: string
  let fixtureByteSize: number
  const secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  beforeAll(async () => {
    // 1. 启动受控靶场服务
    const labServerPath = resolve(__dirname, '../../../../tests/target-surface-lab/server.mjs')
    const labModule = (await import(pathToFileURL(labServerPath).href)) as {
      startLabServer: (port?: number) => Promise<LabServerHandle>
    }
    lab = await labModule.startLabServer(0)

    // 2. 初始化独立数据库
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    secretId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'file-submission-admin',
      email: `admin-${actorId.slice(0, 8)}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)

    // 3. 接入当前业务提报目标系统
    await handle.db.insert(targets).values({
      id: targetId,
      code: `file-submission-${SCHEMA.slice(-6)}`,
      name: '企业费用报销与材料提报系统',
      entryUrl: `${lab.url}/file-submission.html`,
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
      displayName: '提报员',
      username: 'submitter',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })
    await ensureTargetAccountCredential(handle, {
      account: {
        id: accountId,
        targetId,
        displayName: '提报员',
        username: 'submitter',
        configRevision: 1,
        secretId,
        secretProvider: LOCAL_SECRET_PROVIDER,
      },
      sealed: { id: secretId, provider: LOCAL_SECRET_PROVIDER },
      actor: { id: actorId },
    })

    // 4. 初始化对象存储服务与受管资产夹具
    objectDir = mkdtempSync(join(tmpdir(), 'cairn-fsub-obj-'))
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

    const invoiceContent = Buffer.from('%PDF-1.4 official tax invoice fixture for cairn integration test')
    fixtureByteSize = invoiceContent.byteLength
    fixtureDigest = `sha256:${createHash('sha256').update(invoiceContent).digest('hex')}`

    const reserved = await reserveTargetFixtureUpload(
      handle.db,
      {
        targetId,
        name: 'official-invoice.pdf',
        contentType: 'application/pdf',
        byteSize: fixtureByteSize,
        digest: fixtureDigest,
      },
      actorId,
    )
    fixtureId = reserved.fixtureId

    // 将夹具实体文件存入对象存储
    await objects.objectStore().put({
      key: reserved.objectKey,
      body: invoiceContent,
      contentType: 'application/pdf',
    })

    await commitTargetFixtureUpload(
      handle.db,
      {
        fixtureId,
        generationId: reserved.generationId,
        byteSize: fixtureByteSize,
        digest: fixtureDigest,
      },
      actorId,
    )

    // 5. 初始化 Worker 会话管理器
    workerId = `fsub-worker-${SCHEMA.slice(-6)}`
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
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-fsub-prof-')),
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
    if (lab) await lab.close()
  })

  async function claimTargetRun(runId: string) {
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING')
          AND id <> $1`,
      [runId],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 60,
    })
    expect(grant?.runId).toBe(runId)
    return grant!
  }

  it('Round 1 (主流程完整闭环)：下载模版 -> 填选填表单 -> 夹具上传(隐藏框触发) -> 上下文模版回传 -> 提交生成单号', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开报销与提报系统',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${lab.url}/file-submission.html` },
      },
      {
        id: newId(),
        name: '下载报销标准模板',
        type: 'download',
        effectType: 'SIDE_EFFECT',
        outputKey: 'downloadedTemplate',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#download-template-btn' }] },
          waitMs: 15_000,
          expect: {
            fileNamePattern: '\\.csv$',
            minBytes: 10,
          },
        },
      },
      {
        id: newId(),
        name: '填写申请人工号与姓名',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#applicant-name' }] },
          value: '李四 (ENG-2048)',
        },
      },
      {
        id: newId(),
        name: '选择报销类别',
        type: 'select',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#category-select' }] },
          by: 'value',
          value: 'INVOICE',
        },
      },
      {
        id: newId(),
        name: '填写选填业务说明',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#remarks' }] },
          value: 'Q3研发机房扩容采购及差旅报销',
        },
      },
      {
        id: newId(),
        name: '填写选填紧急联系电话',
        type: 'fill',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#emergency-phone' }] },
          value: '13987654321',
        },
      },
      {
        id: newId(),
        name: '勾选加急审批选项',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#urgent-check' }] },
        },
      },
      {
        id: newId(),
        name: '上传受管发票夹具（点击按钮唤起隐藏input）',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#btn-select-invoice' }] },
          files: [
            {
              source: 'asset',
              fixtureId,
              digest: fixtureDigest,
              name: 'invoice-2026-q3.pdf',
            },
          ],
        },
      },
      {
        id: newId(),
        name: '上传上下文引用的下载模板作为补充材料',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#extra-file' }] },
          files: [
            {
              source: 'context',
              from: 'downloadedTemplate',
            },
          ],
        },
      },
      {
        id: newId(),
        name: '提交提报表单',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#submit-btn' }] },
        },
      },
      {
        id: newId(),
        name: '断言生成申请单号',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#ticket-id' }] },
          expect: { kind: 'exists' },
        },
      },
      {
        id: newId(),
        name: '提取生成的业务单号',
        type: 'extract',
        effectType: 'READ_ONLY',
        outputKey: 'claimTicketId',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#ticket-id' }] },
          as: 'text',
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsub-r1-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)

    await engine.execute(runId, { grant })

    // 校验 Run 状态与输出
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('SUCCEEDED')

    const context = detail.context as Record<string, any>
    expect(context).toBeDefined()
    expect(typeof context.claimTicketId).toBe('string')
    expect(context.claimTicketId).toMatch(/^CLAIM-\d{8}-\d{4}$/)

    // 校验下载步骤输出为合法句柄
    const downHandle = context.downloadedTemplate as RunFileHandle
    expect(downHandle.kind).toBe(RUN_FILE_HANDLE_KIND)
    expect(downHandle.scope).toBe('run')
    expect(downHandle.name).toBe('template.csv')
    expect(downHandle.mimeType).toBe('text/csv')
    expect(downHandle.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // 校验证据链完整性且不含 Base64
    const evidences = await listRunEvidence(handle.db, runId)
    const fileEvidence = evidences.items.find((e) => e.type === 'file')
    expect(fileEvidence).toBeDefined()
    expect(fileEvidence?.status).toBe('available')

    const serializedEvidences = JSON.stringify(evidences.items)
    expect(serializedEvidences).not.toContain('data:application/pdf;base64')
    expect(serializedEvidences).not.toContain('base64,')

    // 校验生命周期隔离：Run 结束后工作区自动彻底清除
    const wsDir = runFileWorkspaceDir(runId)
    expect(existsSync(wsDir)).toBe(false)
  })

  it('Round 2 (边界：隐藏文件框 DOM 直接注入)：直接定位 style="display:none" input 完成穿透', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开页面',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${lab.url}/file-submission.html` },
      },
      {
        id: newId(),
        name: '直注隐藏文件框',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#invoice-file' }] }, // 直接定位到隐藏的 input[type=file]
          files: [
            {
              source: 'asset',
              fixtureId,
              digest: fixtureDigest,
              name: 'direct-hidden.pdf',
            },
          ],
        },
      },
      {
        id: newId(),
        name: '断言页面状态徽章更新',
        type: 'assert',
        effectType: 'READ_ONLY',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#invoice-status' }] },
          expect: { kind: 'text_contains', value: 'direct-hidden.pdf' },
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsub-r2-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)
    await engine.execute(runId, { grant })

    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('SUCCEEDED')
  })

  it('Round 3 (边界：夹具摘要篡改拦截)：步骤篡改 digest 立即失败，阻止文件泄露与污染', async () => {
    const tamperedDigest = `sha256:${'9'.repeat(64)}`
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开页面',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${lab.url}/file-submission.html` },
      },
      {
        id: newId(),
        name: '尝试上传摘要被篡改的文件',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#btn-select-invoice' }] },
          files: [
            {
              source: 'asset',
              fixtureId,
              digest: tamperedDigest, // 摘要与数据库记录不符
            },
          ],
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsub-r3-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)
    await engine.execute(runId, { grant })

    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    const failedStep = detail.stepRuns.find((s) => s.status === 'FAILED')
    const lastAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
    expect(lastAttempt?.error?.code).toBe('FIXTURE_DIGEST_MISMATCH')
  })

  it('Round 4 (边界：跨 Run 伪造句柄拦截)：阻断跨运行未授权文件引用', async () => {
    const foreignRunId = newId()
    const foreignHandle: RunFileHandle = {
      kind: RUN_FILE_HANDLE_KIND,
      scope: 'run',
      runId: foreignRunId, // 伪造属于其他 Run 的句柄
      objectKey: `v1/runs/${foreignRunId}/secret.pdf`,
      name: 'foreign-secret.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      digest: `sha256:${'a'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    }

    const steps: Step[] = [
      {
        id: newId(),
        name: '尝试跨 Run 注入文件',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#extra-file' }] },
          files: [
            {
              source: 'context',
              from: 'injectedHandle',
            },
          ],
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsub-r4-${newId()}`,
      inputs: [{ key: 'injectedHandle', label: '注入句柄' }],
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
      input: { injectedHandle: foreignHandle as any },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)
    await engine.execute(runId, { grant })

    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    const failedStep = detail.stepRuns.find((s) => s.status === 'FAILED')
    const lastAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
    expect(lastAttempt?.error?.code).toBe('FILE_HANDLE_FOREIGN_RUN')
  })

  it('Round 5 (边界：目标元素无文件框报错与可重试机制)', async () => {
    const steps: Step[] = [
      {
        id: newId(),
        name: '打开页面',
        type: 'navigate',
        effectType: 'IDEMPOTENT',
        input: { url: `${lab.url}/file-submission.html` },
      },
      {
        id: newId(),
        name: '对常规无文件框按钮执行上传',
        type: 'upload',
        effectType: 'SIDE_EFFECT',
        input: {
          target: { framePath: [], candidates: [{ by: 'css', value: '#btn-dummy-no-upload' }] }, // 按钮不唤起任何 file input
          files: [
            {
              source: 'asset',
              fixtureId,
              digest: fixtureDigest,
            },
          ],
        },
      },
    ]

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `fsub-r5-${newId()}`,
      steps,
      actor: { id: actorId },
    })

    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: accountId,
      actor: { id: actorId },
    })
    const runId = created.detail.id

    const grant = await claimTargetRun(runId)
    const browserPort = createBrowserPort(manager, objects)
    const engine = new ExecutionEngine(handle, browserPort, secretsProvider, undefined, undefined, undefined, objects)
    await engine.execute(runId, { grant })

    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    const failedStep = detail.stepRuns.find((s) => s.status === 'FAILED')
    const lastAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
    expect(lastAttempt?.error?.code).toBe('UPLOAD_NO_FILE_INPUT')
  })
})
