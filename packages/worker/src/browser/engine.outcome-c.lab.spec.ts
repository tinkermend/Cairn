/**
 * Engine × 真 Chromium：OC-C 运行期约束端到端验收。
 * 强制启动 Playwright Chromium，不跳过、不注入 Attempt 错误码。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  getTargetAccessPolicy,
  newId,
  openIsolatedDb,
  publishScenarioDraft,
  registerWorker,
  saveScenarioDraft,
  secrets,
  targetAccounts,
  targetAuthProfiles,
  targets,
  updateTargetAccessPolicy,
  type DbHandle,
} from '@cairn/db/testing'
import {
  DEV_CREDENTIAL_KEY,
  LOCAL_SECRET_PROVIDER,
  createRuntimeInvariant,
  targetAuthProfileDefinitionSchema,
  type AuthoringNode,
  type RuntimeInvariant,
  type Step,
} from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { createBrowserPort } from './port.js'
import { BrowserSessionManager } from './session-manager.js'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_occclab`

const LOGIN_HTML = `<!doctype html><html><body>
<form method="POST" action="/login">
  <input name="username" id="user" />
  <input name="password" id="pass" type="password" />
  <button type="submit" id="go">登录</button>
</form>
</body></html>`

const HOME_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>OC-C Lab</title></head>
<body>
  <div id="status-badge">ONLINE</div>
  <div role="alert" id="ok-alert">通信 在线</div>
  <button id="action-btn">执行动作</button>
  <a id="logout" href="/logout">退出</a>
  <script>
    document.getElementById('action-btn').addEventListener('click', () => {
      document.getElementById('status-badge').textContent = 'DONE';
    });
  </script>
</body>
</html>`

const ERROR_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>系统异常</title></head>
<body>
  <div role="alertdialog">系统异常 password=hunter2 user@example.com</div>
  <button id="next">继续</button>
</body>
</html>`

const FLASH_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>闪现弹窗</title></head>
<body>
  <button id="after-flash">下一步</button>
  <script>
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    dialog.textContent = '系统异常：瞬时失败';
    document.body.appendChild(dialog);
    setTimeout(() => dialog.remove(), 80);
  </script>
</body>
</html>`

const ADMIN_HTML = `<!doctype html><html><body><h1>后台</h1></body></html>`

describe('ExecutionEngine × 真浏览器 OC-C 运行期约束', { timeout: 240_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''
  let origin = ''
  let actorId: string
  let targetId: string
  let accountId: string
  let secretId: string
  let authTargetId: string
  let authAccountId: string
  let authSecretId: string
  let authFailAccountId: string
  let workerId: string
  let workerInstanceId: string
  let objectDir: string
  let objects: ObjectService
  let secretsProvider: LocalSecretProvider

  beforeAll(async () => {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    await browser.close()

    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    secretId = newId()
    secretsProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (chunk) => chunks.push(chunk as Buffer))
          req.on('end', () => {
            const params = new URLSearchParams(Buffer.concat(chunks).toString())
            if (params.get('password') !== 'lab') {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(LOGIN_HTML)
              return
            }
            res.writeHead(302, {
              Location: '/',
              'Set-Cookie': 'lab=ok; Path=/; HttpOnly',
            })
            res.end()
          })
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
        return
      }
      if (url.pathname === '/logout') {
        res.writeHead(302, {
          Location: '/login',
          'Set-Cookie': 'lab=; Path=/; Max-Age=0',
        })
        res.end()
        return
      }
      if (url.pathname === '/auth') {
        const cookie = req.headers.cookie ?? ''
        if (!cookie.includes('lab=ok')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, user: 'lab' }))
        return
      }
      const cookie = req.headers.cookie ?? ''
      if (!cookie.includes('lab=ok')) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      const body =
        url.pathname === '/error'
          ? ERROR_HTML
          : url.pathname === '/flash'
            ? FLASH_HTML
            : url.pathname === '/admin'
              ? ADMIN_HTML
              : HOME_HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    })
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('invalid server address')
    baseUrl = `http://127.0.0.1:${address.port}`
    origin = new URL(baseUrl).origin

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'occ-c-lab',
      email: `occclab-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `occclab-${SCHEMA.slice(-8)}`,
      name: 'OC-C Lab Target',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
    })
    await handle.db.insert(secrets).values({
      id: secretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(secretId, 'lab'),
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: 'lab-user',
      username: 'lab',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId,
      status: 'active',
    })
    authTargetId = newId()
    authAccountId = newId()
    authSecretId = newId()
    await handle.db.insert(targets).values({
      id: authTargetId,
      code: `occclab-auth-${SCHEMA.slice(-8)}`,
      name: 'OC-C Auth Lab Target',
      entryUrl: `${baseUrl}/`,
      loginUrl: `${baseUrl}/login`,
      authMethod: 'password',
      captchaMode: 'none',
      loginFields: {
        username: { by: 'name', value: 'username' },
        password: { by: 'name', value: 'password' },
        submit: { by: 'css', value: 'button[type=submit]' },
      },
      currentAuthProfileRevision: 1,
    })
    await handle.db.insert(secrets).values({
      id: authSecretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(authSecretId, 'lab'),
    })
    await handle.db.insert(targetAccounts).values({
      id: authAccountId,
      targetId: authTargetId,
      displayName: 'lab-auth-user',
      username: 'lab',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId: authSecretId,
      status: 'active',
      expectedIdentity: 'lab',
    })
    authFailAccountId = newId()
    const authFailSecretId = newId()
    await handle.db.insert(secrets).values({
      id: authFailSecretId,
      provider: LOCAL_SECRET_PROVIDER,
      ciphertext: secretsProvider.encrypt(authFailSecretId, 'wrong'),
    })
    await handle.db.insert(targetAccounts).values({
      id: authFailAccountId,
      targetId: authTargetId,
      displayName: 'lab-auth-fail',
      username: 'lab-fail',
      secretProvider: LOCAL_SECRET_PROVIDER,
      secretId: authFailSecretId,
      status: 'active',
      expectedIdentity: 'lab',
    })
    const definition = targetAuthProfileDefinitionSchema.parse({
      verify: {
        mode: 'http',
        path: '/auth',
        success: { status: 200, jsonPath: '$.ok', equals: true },
        failure: { status: 401 },
      },
      identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' },
      scope: { origins: [origin], pathPrefixes: ['/auth'] },
    })
    await handle.db.insert(targetAuthProfiles).values({
      id: newId(),
      targetId: authTargetId,
      revision: 1,
      definition,
      digest: 'd1'.padEnd(64, 'd'),
      validation: {
        recordedAt: '2026-09-17T00:00:00.000Z',
        actorId,
        operationId: newId(),
        steps: {
          valid_pass: {
            authState: 'AUTHENTICATED',
            identityState: 'MATCH',
            observedIdentity: 'lab',
            unknownClass: null,
            evidenceSummary: 'seed',
            authProfileRevision: 1,
            diagnosticCode: 'verified',
          },
          server_revoked: {
            authState: 'EXPIRED',
            identityState: 'UNVERIFIED',
            observedIdentity: null,
            unknownClass: null,
            evidenceSummary: 'seed',
            authProfileRevision: 1,
            diagnosticCode: 'verified',
          },
          other_account: {
            authState: 'AUTHENTICATED',
            identityState: 'MISMATCH',
            observedIdentity: 'other',
            unknownClass: null,
            evidenceSummary: 'seed',
            authProfileRevision: 1,
            diagnosticCode: 'verified',
          },
        },
      },
    })

    objectDir = mkdtempSync(join(tmpdir(), 'cairn-occclab-obj-'))
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
    workerId = `occclab-${SCHEMA.slice(-8)}`
    workerInstanceId = newId()
    await registerWorker(handle.db, {
      workerId,
      instanceId: workerInstanceId,
      capacity: 8,
      maxSessions: 4,
      lostAfterSeconds: 60,
      protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId,
        profileRoot: mkdtempSync(join(tmpdir(), 'cairn-occclab-prof-')),
        headless: true,
        maxSessions: 4,
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
    if (server) {
      await new Promise<void>((done) => server!.close(() => done()))
    }
  }, 30_000)

  function cssTarget(value: string) {
    return { framePath: [], candidates: [{ by: 'css' as const, value }] }
  }

  function navigate(id: string, path: string): Step {
    return {
      id,
      name: `打开 ${path}`,
      type: 'navigate',
      effectType: 'IDEMPOTENT',
      input: { url: path.startsWith('http') ? path : `${baseUrl}${path}` },
    }
  }

  function click(id: string, selector: string, effectType: Step['effectType'] = 'SIDE_EFFECT'): Step {
    return {
      id,
      name: `点击 ${selector}`,
      type: 'click',
      effectType,
      input: { target: cssTarget(selector) },
    }
  }

  async function publishScenario(input: {
    name: string
    steps: Step[]
    runtimeInvariants?: RuntimeInvariant[]
    targetId?: string
  }) {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId: input.targetId ?? targetId,
      name: input.name,
      steps: [{ id: newId(), name: 'init', type: 'echo', effectType: 'READ_ONLY', input: { value: 'init' } }],
      actor: { id: actorId },
    })
    const nodes: AuthoringNode[] = input.steps.map((step) => ({ kind: 'step', step }))
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2 as const,
        schemaVersion: 1,
        inputs: [],
        nodes,
        runtimeInvariants: input.runtimeInvariants,
      },
      actor: { id: actorId },
    })
    await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    return scenario
  }

  async function executeScenario(input: {
    name: string
    steps: Step[]
    runtimeInvariants?: RuntimeInvariant[]
    targetId?: string
    accountId?: string
  }) {
    const scenario = await publishScenario(input)
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      targetAccountId: input.accountId ?? accountId,
      actor: { id: actorId },
    })
    expect(created.detail.snapshot.runtimeInvariantManifest?.entries.length ?? 0).toBe(
      input.runtimeInvariants?.length ?? 0,
    )
    await handle.pool.query(
      `UPDATE runs
          SET status = 'CANCELLED',
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE status IN ('QUEUED', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING')
          AND id <> $1`,
      [created.detail.id],
    )
    const grant = await claimRun(handle, {
      workerId,
      instanceId: workerInstanceId,
      leaseTtlSeconds: 90,
    })
    expect(grant?.runId).toBe(created.detail.id)
    const engine = new ExecutionEngine(handle, createBrowserPort(manager))
    await engine.execute(created.detail.id, { grant: grant! })
    return getRun(handle.db, created.detail.id)
  }

  function invariantRow(detail: Awaited<ReturnType<typeof getRun>>, contractId: string) {
    return detail.outcomeResults.find((item) => item.contractId === contractId)
  }

  it('OCC-02：真浏览器越界导航错误码不变，同时写 navigation_boundary FAIL', async () => {
    const invariantId = newId()
    const stepNavId = newId()
    const detail = await executeScenario({
      name: `occ-02-fail-${newId()}`,
      steps: [navigate(stepNavId, 'https://evil.example/')],
      runtimeInvariants: [createRuntimeInvariant('navigation_boundary', invariantId)],
    })
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.code).toBe('NAVIGATE_OUT_OF_SCOPE')
    expect(detail.outcomeStatus).toBe('FAIL')
    expect(invariantRow(detail, invariantId)).toMatchObject({
      provenance: 'runtime_invariant',
      verdict: 'FAIL',
      actual: { errorCode: 'NAVIGATE_OUT_OF_SCOPE' },
    })
  })

  it('OCC-02：pathPrefix 外路径同样拦截并记账；范围内停机写 PASS', async () => {
    const current = await getTargetAccessPolicy(handle.db, targetId)
    await updateTargetAccessPolicy(
      handle.db,
      targetId,
      {
        expectedRevision: current.revision,
        idempotencyKey: `occ-c-admin-${newId()}`.slice(0, 128),
        reason: 'lab deny /admin',
        rules: [
          { origin, purpose: 'business_surface', effect: 'allow', pathPrefix: '/' },
          { origin, purpose: 'business_surface', effect: 'deny', pathPrefix: '/admin' },
          { origin, purpose: 'authentication', effect: 'allow', pathPrefix: '/login' },
        ],
      },
      { id: actorId },
    )

    const denyId = newId()
    const denied = await executeScenario({
      name: `occ-02-admin-${newId()}`,
      steps: [navigate(newId(), '/admin')],
      runtimeInvariants: [createRuntimeInvariant('navigation_boundary', denyId)],
    })
    expect(denied.status).toBe('FAILED')
    expect(denied.stepRuns[0]?.attempts[0]?.error?.code).toBe('NAVIGATE_OUT_OF_SCOPE')
    expect(invariantRow(denied, denyId)?.verdict).toBe('FAIL')

    const passId = newId()
    const passed = await executeScenario({
      name: `occ-02-pass-${newId()}`,
      steps: [navigate(newId(), '/')],
      runtimeInvariants: [createRuntimeInvariant('navigation_boundary', passId)],
    })
    expect(passed.status).toBe('SUCCEEDED')
    expect(passed.outcomeStatus).toBe('PASS')
    expect(invariantRow(passed, passId)).toMatchObject({
      provenance: 'runtime_invariant',
      verdict: 'PASS',
    })
  })

  it('OCC-03：开跑前登录失败进入 WAITING_FOR_AUTH，补窗口并记 SHOULD FAIL / WARN', async () => {
    const invariantId = newId()
    const detail = await executeScenario({
      name: `occ-03-acquire-${newId()}`,
      targetId: authTargetId,
      accountId: authFailAccountId,
      steps: [navigate(newId(), '/')],
      runtimeInvariants: [createRuntimeInvariant('auth_validity', invariantId)],
    })
    expect(detail.status).toBe('WAITING_FOR_AUTH')
    expect(detail.snapshot.authVerification?.capability).toBe('IDENTITY_VERIFIED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.code).toBe('AUTH_GATE_CLOSED')
    expect(invariantRow(detail, invariantId)?.verdict).toBe('FAIL')
    expect(detail.outcomeStatus).toBe('WARN')
  })

  it('OCC-03：运行中回到登录页，认证恢复流程不变，默认 SHOULD 记 WARN', async () => {
    const invariantId = newId()
    const stepNavId = newId()
    const stepLogoutId = newId()
    const detail = await executeScenario({
      name: `occ-03-auth-${newId()}`,
      targetId: authTargetId,
      accountId: authAccountId,
      steps: [navigate(stepNavId, '/'), click(stepLogoutId, '#logout')],
      runtimeInvariants: [createRuntimeInvariant('auth_validity', invariantId)],
    })
    expect(detail.snapshot.authVerification?.capability).toBe('IDENTITY_VERIFIED')
    expect(['WAITING_FOR_AUTH', 'FAILED', 'NEEDS_REVIEW']).toContain(detail.status)
    expect(detail.authCheckpoint).toBeTruthy()
    expect(['recovering', 'recovered', 'unrecoverable', 'closed']).toContain(detail.authCheckpoint?.status)
    expect(invariantRow(detail, invariantId)?.verdict).toBe('FAIL')
    expect(detail.outcomeStatus).toBe('WARN')
    expect(
      detail.stepRuns
        .find((item) => item.stepId === stepLogoutId)
        ?.attempts.some((attempt) => attempt.error?.code === 'AUTH_GATE_CLOSED'),
    ).toBe(true)
  })

  it('OCC-04：只读约束对照 SIDE_EFFECT 记 FAIL，全程无写则 PASS，执行不被拦截', async () => {
    const failId = newId()
    const failed = await executeScenario({
      name: `occ-04-write-${newId()}`,
      steps: [navigate(newId(), '/'), click(newId(), '#action-btn')],
      runtimeInvariants: [createRuntimeInvariant('readonly_guarantee', failId)],
    })
    expect(failed.status).toBe('SUCCEEDED')
    expect(failed.outcomeStatus).toBe('FAIL')
    expect(invariantRow(failed, failId)).toMatchObject({
      provenance: 'runtime_invariant',
      verdict: 'FAIL',
      actual: { effectType: 'SIDE_EFFECT' },
    })

    const passId = newId()
    const passed = await executeScenario({
      name: `occ-04-pass-${newId()}`,
      steps: [navigate(newId(), '/')],
      runtimeInvariants: [createRuntimeInvariant('readonly_guarantee', passId)],
    })
    expect(passed.status).toBe('SUCCEEDED')
    expect(passed.outcomeStatus).toBe('PASS')
    expect(invariantRow(passed, passId)?.verdict).toBe('PASS')
  })

  it('OCC-05：真页面错误弹窗记 FAIL 并脱敏；正常 alert 不误报', async () => {
    const failId = newId()
    const failed = await executeScenario({
      name: `occ-05-fail-${newId()}`,
      steps: [navigate(newId(), '/error'), click(newId(), '#next')],
      runtimeInvariants: [createRuntimeInvariant('error_surface', failId)],
    })
    expect(failed.status).toBe('FAILED')
    expect(failed.outcomeStatus).toBe('FAIL')
    const row = invariantRow(failed, failId)
    expect(row?.verdict).toBe('FAIL')
    expect(JSON.stringify(row?.actual)).toMatch(/password=\*\*\*/)
    expect(JSON.stringify(row?.actual)).toMatch(/\[redacted-email\]/)
    expect(JSON.stringify(row?.actual)).not.toMatch(/hunter2/)
    expect(failed.stepRuns.at(-1)?.attempts[0]?.error?.code).toBe('ERROR_SURFACE_VIOLATED')

    const passId = newId()
    const passed = await executeScenario({
      name: `occ-05-clean-${newId()}`,
      steps: [navigate(newId(), '/'), click(newId(), '#action-btn')],
      runtimeInvariants: [createRuntimeInvariant('error_surface', passId)],
    })
    expect(passed.status).toBe('SUCCEEDED')
    expect(passed.outcomeStatus).toBe('PASS')
    expect(invariantRow(passed, passId)?.verdict).toBe('PASS')
  })

  it('OCC-05：窗口外闪现未探测不写 PASS；闪现消失后再探测才写 PASS', async () => {
    const unseenId = newId()
    const unseen = await executeScenario({
      name: `occ-05-flash-unseen-${newId()}`,
      steps: [navigate(newId(), '/flash')],
      runtimeInvariants: [createRuntimeInvariant('error_surface', unseenId)],
    })
    expect(unseen.status).toBe('SUCCEEDED')
    expect(unseen.outcomeStatus).toBe('UNKNOWN')
    expect(invariantRow(unseen, unseenId)).toBeUndefined()

    const seenId = newId()
    const seen = await executeScenario({
      name: `occ-05-flash-seen-${newId()}`,
      steps: [
        navigate(newId(), '/flash'),
        {
          id: newId(),
          name: '等待闪现消失',
          type: 'wait',
          effectType: 'READ_ONLY',
          input: { kind: 'time', durationMs: 250 },
        },
        click(newId(), '#after-flash'),
      ],
      runtimeInvariants: [createRuntimeInvariant('error_surface', seenId)],
    })
    expect(seen.status).toBe('SUCCEEDED')
    expect(invariantRow(seen, seenId)?.verdict).toBe('PASS')
  })

  it('OCC-06：each_step 在真浏览器逐步探测，并记录单次耗时', async () => {
    const invariant = {
      ...createRuntimeInvariant('error_surface', newId()),
      evaluateAt: 'each_step' as const,
    }
    const times: number[] = []
    const original = manager.probeErrorSurface.bind(manager)
    manager.probeErrorSurface = async (grant, signal) => {
      const started = performance.now()
      const matches = await original(grant, signal)
      times.push(performance.now() - started)
      return matches
    }
    try {
      const detail = await executeScenario({
        name: `occ-06-each-${newId()}`,
        steps: [navigate(newId(), '/'), click(newId(), '#action-btn', 'READ_ONLY')],
        runtimeInvariants: [invariant],
      })
      expect(detail.status).toBe('SUCCEEDED')
      expect(times.length).toBeGreaterThanOrEqual(2)
      const average = times.reduce((sum, item) => sum + item, 0) / times.length
      // 验收记录：真页面单次探测耗时应远低于一步超时。
      console.info(`[OCC-06] each_step probeMs=${times.map((item) => item.toFixed(1)).join(',')} avg=${average.toFixed(1)}`)
      expect(average).toBeLessThan(2_000)
      expect(invariantRow(detail, invariant.id)?.details).toMatchObject({ evaluateAt: 'each_step' })
    } finally {
      manager.probeErrorSurface = original
    }
  })

  it('OCC-07：已收编守卫 continue 不能取消越界拦截', async () => {
    const continueId = newId()
    const afterId = newId()
    const detail = await executeScenario({
      name: `occ-07-nav-continue-${newId()}`,
      steps: [
        navigate(newId(), 'https://evil.example/'),
        {
          id: afterId,
          name: '不应因 continue 跑完',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'skip' },
        },
      ],
      runtimeInvariants: [
        {
          ...createRuntimeInvariant('navigation_boundary', continueId),
          onViolation: 'continue',
        },
      ],
    })
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns[0]?.attempts[0]?.error?.code).toBe('NAVIGATE_OUT_OF_SCOPE')
    expect(detail.stepRuns.find((item) => item.stepId === afterId)?.attempts ?? []).toHaveLength(0)
    expect(invariantRow(detail, continueId)?.verdict).toBe('FAIL')
  })

  it('OCC-07：error_surface halt 截断后续步；continue 跑完且结果轴 FAIL', async () => {
    const haltId = newId()
    const afterHaltId = newId()
    const halted = await executeScenario({
      name: `occ-07-halt-${newId()}`,
      steps: [
        navigate(newId(), '/error'),
        click(newId(), '#next'),
        {
          id: afterHaltId,
          name: '不应执行',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'skip' },
        },
      ],
      runtimeInvariants: [createRuntimeInvariant('error_surface', haltId)],
    })
    expect(halted.status).toBe('FAILED')
    expect(halted.stepRuns.find((item) => item.stepId === afterHaltId)?.attempts ?? []).toHaveLength(0)
    expect(invariantRow(halted, haltId)?.onViolation).toBe('halt')

    const continueId = newId()
    const afterContinueId = newId()
    const continued = await executeScenario({
      name: `occ-07-continue-${newId()}`,
      steps: [
        navigate(newId(), '/error'),
        click(newId(), '#next'),
        {
          id: afterContinueId,
          name: '应继续',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'after' },
        },
      ],
      runtimeInvariants: [
        {
          ...createRuntimeInvariant('error_surface', continueId),
          onViolation: 'continue',
        },
      ],
    })
    expect(continued.status).toBe('SUCCEEDED')
    expect(continued.outcomeStatus).toBe('FAIL')
    expect(continued.stepRuns.find((item) => item.stepId === afterContinueId)?.status).toBe('SUCCEEDED')
    expect(invariantRow(continued, continueId)?.verdict).toBe('FAIL')
  })
})
