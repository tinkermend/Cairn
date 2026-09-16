import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startStack, eventually, firstSse } from './stack.mjs'
import { countFailedRecoveries } from '../../packages/db/dist/leases/leases.js'
import { schemaFor, eq, and } from '../../packages/db/dist/test-entry.js'
import { createRequire } from 'node:module'
const require = createRequire(
  new URL('../../packages/worker/package.json', import.meta.url),
)
const { chromium } = require('playwright')
import { startSessionTarget } from './target.mjs'

const lab = await startSessionTarget()
let stack
const results = []
async function check(name, fn) {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, passed: true, durationMs: Date.now() - start })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, passed: false, error: error.message })
    throw error
  }
}
const step = (type, input, extra = {}) => ({
  id: randomUUID(),
  name: type,
  type,
  effectType: 'READ_ONLY',
  input,
  ...extra,
})
const locator = (css) => ({
  candidates: [{ by: 'css', value: css }],
  framePath: [],
})
try {
  stack = await startStack()
  console.log(`Artifacts: ${stack.artifacts}`)
  const api = stack.request
  const initialConfig = await api('/platform-config')
  await api('/platform-config/update', {
    expectedRevision: initialConfig.revision,
    reason: '隔离验收缩短基础设施重试等待',
    document: {
      ...initialConfig.document,
      sessionAuth: {
        ...initialConfig.document.sessionAuth,
        verifyRetryBackoffSeconds: [1, 2],
      },
    },
  })
  let target, account, scenario, sessionId
  const accountPath = () => `/targets/${target.id}/accounts/${account.id}`
  async function operation(kind, extra = {}) {
    const view = await api(`${accountPath()}/session`)
    const expected = view.session
      ? {
          expectedSessionId: view.session.id,
          expectedGeneration: view.session.generation,
        }
      : {}
    return api(`${accountPath()}/session/operations`, {
      kind,
      idempotencyKey: randomUUID(),
      ...expected,
      ...extra,
    })
  }
  async function waitOperation(id, status = 'SUCCEEDED') {
    const done = await eventually(
      () => api(`/session-operations/${id}`),
      (r) =>
        ['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_FOR_AUTH'].includes(
          r.status,
        ),
      'operation terminal',
      45000,
    )
    assert.equal(done.status, status, JSON.stringify(done))
    return done
  }
  async function run(steps, options = {}) {
    const sc = steps
      ? await api('/scenarios', {
          targetId: target.id,
          name: `e2e-${randomUUID()}`,
          steps,
        })
      : scenario
    return api('/runs', {
      scenarioId: sc.id,
      targetAccountId: account.id,
      ...options,
    })
  }
  async function waitRun(id, status = 'SUCCEEDED') {
    const done = await eventually(
      () => api(`/runs/${id}`),
      (r) =>
        [
          'SUCCEEDED',
          'FAILED',
          'CANCELLED',
          'NEEDS_REVIEW',
          'WAITING_FOR_AUTH',
        ].includes(r.status),
      'Run terminal',
      45000,
    )
    assert.equal(
      done.status,
      status,
      JSON.stringify({
        status: done.status,
        error: done.error,
        steps: done.stepRuns,
        checkpoint: done.authCheckpoint,
      }),
    )
    return done
  }
  async function loginRun(id, completionStatus) {
    const base = `/runs/${id}/browser`
    const granted = await api(`${base}/auth-control/acquire`, {})
    let seq = 0
    for (const command of [
      { type: 'insert_text', text: 'alice' },
      { type: 'key', key: 'Tab' },
      { type: 'insert_text', text: 'lab-password' },
      { type: 'key', key: 'Enter' },
    ]) {
      const frame = await firstSse(
        `${stack.url}/api${base}/frames`,
        stack.token,
        'frame',
      )
      await api(`${base}/auth-control/input`, {
        token: granted.token,
        command: {
          ...command,
          commandId: randomUUID(),
          seq: ++seq,
          pageRef: frame.pageRef,
          frameId: frame.frameId,
          viewport: { width: frame.width, height: frame.height },
        },
      })
    }
    await eventually(
      () => Promise.resolve([...lab.state.sessions.values()]),
      (v) => v.includes('alice'),
      'manual Run login',
    )
    await api(
      `/runs/${id}/resume-auth`,
      { token: granted.token },
      completionStatus ? { status: completionStatus } : {},
    )
  }
  await check(
    'SM02/SM37 real API → two Workers → Chromium → Evidence; LEGACY reuse',
    async () => {
      target = await api('/targets', {
        code: `session-${Date.now()}`,
        name: '会话端到端验证',
        entryUrl: `${lab.url}/app`,
        loginUrl: `${lab.url}/login`,
        authMethod: 'password',
        captchaMode: 'none',
        loginFields: {
          username: { by: 'name', value: 'username' },
          password: { by: 'name', value: 'password' },
          submit: { by: 'css', value: 'button[type=submit]' },
        },
      })
      account = await api(`/targets/${target.id}/accounts`, {
        displayName: 'Alice',
        username: 'alice',
        password: 'lab-password',
      })
      scenario = await api('/scenarios', {
        targetId: target.id,
        name: '会话只读运行',
        steps: [
          step('navigate', { url: `${lab.url}/app` }),
          step(
            'extract',
            { target: locator('#identity'), as: 'text' },
            { outputKey: 'identity' },
          ),
        ],
      })
      const first = await waitRun((await run()).id)
      assert.equal(first.context.identity, 'alice')
      const evidence = await api(`/runs/${first.id}/evidence`)
      assert.ok(evidence.items.length >= 2)
      const before = lab.state.logins.length
      await waitRun((await run()).id)
      assert.equal(
        lab.state.logins.length,
        before,
        'second Run must reuse authenticated context',
      )
      const view = await api(`${accountPath()}/session`)
      sessionId = view.session?.id ?? view.sessionId
      assert.ok(sessionId)
    },
  )
  await check(
    'SM35 auth-profile validation uses live Worker probe for valid/revoked/wrong identity',
    async () => {
      account = await api(`${accountPath()}/identity`, {
        expectedRevision: account.configRevision ?? 1,
        expectedIdentity: 'alice',
      })
      await api(`/targets/${target.id}/auth-profile`, {
        expectedRevision: 0,
        definition: {
          verify: {
            mode: 'http',
            path: '/api/me',
            success: { status: 200, jsonPath: '$.ok', equals: true },
            failure: { status: 401 },
          },
          identity: { source: 'json', jsonPath: '$.user', normalize: 'exact' },
          renew: 'relogin',
          scope: { origins: [lab.url], pathPrefixes: ['/api/me'] },
          freshnessSeconds: 60,
        },
      })
      const req = await api(`/targets/${target.id}/auth-profile/validations`, {
        targetAccountId: account.id,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      })
      const id = req.operationId ?? req.operation?.id ?? req.id
      await waitOperation(id, 'WAITING_FOR_AUTH')
      await api(
        `/targets/${target.id}/auth-profile/validations/${id}/observe`,
        { step: 'valid_pass' },
      )
      const sessions = new Map(lab.state.sessions)
      lab.state.sessions.clear()
      await api(
        `/targets/${target.id}/auth-profile/validations/${id}/observe`,
        { step: 'server_revoked' },
      )
      lab.state.sessions = new Map([...sessions].map(([key]) => [key, 'bob']))
      await api(
        `/targets/${target.id}/auth-profile/validations/${id}/observe`,
        { step: 'other_account' },
      )
      lab.state.sessions = sessions
      const done = await api(`/session-operations/${id}`)
      assert.equal(done.status, 'SUCCEEDED')
      const next = await run()
      assert.equal(
        next.snapshot.authVerification.capability,
        'IDENTITY_VERIFIED',
      )
      await waitRun(next.id)
    },
  )
  await check(
    'SM36/SM41 fresh evidence reuses authentication; zero periodic/step-boundary verify calls',
    async () => {
      const probes = lab.state.probes,
        logins = lab.state.logins.length
      await waitRun((await run()).id)
      await waitRun((await run()).id)
      assert.equal(lab.state.probes, probes)
      assert.equal(lab.state.logins.length, logins)
    },
  )
  await check(
    'SM42 LOGIN_VERIFIED reuses login but expired credentials require human control',
    async () => {
      account = (await api(`/targets/${target.id}/accounts`)).items.find(
        (item) => item.id === account.id,
      )
      account = await api(`${accountPath()}/identity`, {
        expectedRevision: account.configRevision,
        expectedIdentity: null,
      })
      const downgraded = await run()
      assert.equal(
        downgraded.snapshot.authVerification.capability,
        'LOGIN_VERIFIED',
      )
      const logins = lab.state.logins.length
      await waitRun(downgraded.id)
      await waitRun((await run()).id)
      assert.equal(lab.state.logins.length, logins)
      lab.state.sessions.clear()
      await waitOperation(
        (await operation('VERIFY_AUTH')).operationId,
        'FAILED',
      )
      const expired = await run()
      const waiting = await waitRun(expired.id, 'WAITING_FOR_AUTH')
      assert.ok(waiting.stepRuns.every((s) => s.attempts.length === 0))
      assert.equal(
        lab.state.logins.length,
        logins,
        'LOGIN_VERIFIED cannot automatically submit stored credentials',
      )
      await loginRun(expired.id)
      await waitRun(expired.id)
      const beforeLoss = new Map(lab.state.sessions)
      const afterManualLogin = lab.state.logins.length
      const midRun = await run([
        step('navigate', { url: `${lab.url}/app` }),
        step('echo', { value: 'login-only' }, { outputKey: 'before' }),
        step('delay', { durationMs: 1500 }),
        step(
          'navigate',
          { url: `${lab.url}/read` },
          { policy: { retryLimit: 1 } },
        ),
      ])
      await eventually(
        () => api(`/runs/${midRun.id}`),
        (r) => r.context?.before === 'login-only',
        'LOGIN_VERIFIED before expiry',
      )
      lab.state.sessions.clear()
      const stopped = await waitRun(midRun.id, 'FAILED')
      assert.equal(stopped.authCheckpoint?.status, 'unrecoverable')
      assert.equal(stopped.authCheckpoint?.autoRecoveriesUsed, 0)
      assert.equal(lab.state.logins.length, afterManualLogin)
      lab.state.sessions = beforeLoss
      account = await api(`${accountPath()}/identity`, {
        expectedRevision: account.configRevision,
        expectedIdentity: 'alice',
      })
      const upgraded = await run()
      assert.equal(
        upgraded.snapshot.authVerification.capability,
        'IDENTITY_VERIFIED',
      )
      await waitRun(upgraded.id)
      assert.equal(
        (await api(`/runs/${downgraded.id}`)).snapshot.authVerification
          .capability,
        'LOGIN_VERIFIED',
      )
    },
  )
  await check(
    'SM01/SM06/SM19 idle verify, UNKNOWN infrastructure and state separation',
    async () => {
      await waitOperation((await operation('VERIFY_AUTH')).operationId)
      lab.state.verifyStatus = 500
      await waitOperation(
        (await operation('VERIFY_AUTH')).operationId,
        'FAILED',
      )
      const view = await api(`/browser-sessions/${sessionId}`)
      assert.equal(view.authState, 'UNKNOWN')
      assert.notEqual(view.health, 'UNHEALTHY')
      const before = lab.state.logins.length
      const created = await run()
      const yielded = await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.status === 'RECOVERING' && !r.lease,
        'infra failure returns Run to scheduler',
      )
      assert.equal(yielded.context.identity, undefined)
      assert.equal(
        (await api(`${accountPath()}/session`)).occupancy,
        null,
        'yield must release SessionLease',
      )
      assert.equal(
        lab.state.logins.length,
        before,
        'UNKNOWN must invalidate old fresh evidence without submitting credentials',
      )
      lab.state.verifyStatus = null
      await waitRun(created.id)
      await waitOperation((await operation('VERIFY_AUTH')).operationId)
    },
  )
  await check(
    'SM04 known identity mismatch cannot reuse fresh success or enter business steps',
    async () => {
      lab.state.forceIdentity = 'bob'
      await waitOperation(
        (await operation('VERIFY_AUTH')).operationId,
        'FAILED',
      )
      const before = lab.state.logins.length
      const created = await run()
      const waiting = await waitRun(created.id, 'WAITING_FOR_AUTH')
      assert.ok(waiting.stepRuns.every((s) => s.attempts.length === 0))
      assert.equal(lab.state.logins.length, before)
      await api(`/runs/${created.id}/cancel`, {})
      await waitRun(created.id, 'CANCELLED')
      lab.state.forceIdentity = null
      await waitOperation((await operation('VERIFY_AUTH')).operationId)
    },
  )
  await check(
    'SM18 cancellation interrupts a long infrastructure backoff and releases both leases',
    async () => {
      const cfg = await api('/platform-config')
      const changed = await api('/platform-config/update', {
        expectedRevision: cfg.revision,
        reason: '验证退避可取消',
        document: {
          ...cfg.document,
          sessionAuth: {
            ...cfg.document.sessionAuth,
            verifyRetryBackoffSeconds: [30],
          },
        },
      })
      lab.state.verifyStatus = 500
      await waitOperation(
        (await operation('VERIFY_AUTH')).operationId,
        'FAILED',
      )
      const probes = lab.state.probes
      const created = await run()
      await eventually(
        () => Promise.resolve(lab.state.probes),
        (n) => n > probes,
        'backoff has begun',
      )
      await api(`/runs/${created.id}/cancel`, {})
      await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.status === 'CANCELLED',
        'cancel during backoff',
        8000,
      )
      await eventually(
        () => api(`${accountPath()}/session`),
        (r) => r.occupancy === null,
        'cancel backoff lease release',
        8000,
      )
      lab.state.verifyStatus = null
      await api('/platform-config/update', {
        expectedRevision: changed.revision,
        reason: '恢复隔离验收退避',
        document: cfg.document,
      })
      // Cancellation may close the browser to abort an in-flight probe; cookies survive.
      await waitRun((await run()).id)
      sessionId = (await api(`${accountPath()}/session`)).session.id
    },
  )
  await check(
    'SM05/SM31 queued same-account Runs serialize across two actual Workers',
    async () => {
      const a = await run([
        step('navigate', { url: `${lab.url}/app` }),
        step('delay', { durationMs: 1800 }),
      ])
      await eventually(
        () => api(`/runs/${a.id}`),
        (r) => r.status === 'RUNNING',
        'first Run running',
      )
      const b = await run()
      const queued = await api(`/runs/${b.id}`)
      assert.equal(queued.status, 'QUEUED')
      assert.equal(queued.placement.waitReason, 'SESSION_IN_USE_BY_RUN')
      await waitRun(a.id)
      await waitRun(b.id)
    },
  )
  await check(
    'SM14 expired between steps recovers once without replaying completed output',
    async () => {
      const created = await run([
        step('navigate', { url: `${lab.url}/app` }),
        step('echo', { value: 'kept' }, { outputKey: 'before' }),
        step('delay', { durationMs: 1500 }),
        step(
          'navigate',
          { url: `${lab.url}/read` },
          { policy: { retryLimit: 1 } },
        ),
      ])
      await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.context?.before === 'kept',
        'completed first steps',
      )
      lab.state.sessions.clear()
      const done = await waitRun(created.id)
      assert.equal(done.context.before, 'kept')
      assert.equal(done.authCheckpoint?.status, 'recovered')
      assert.equal(done.authCheckpoint?.autoRecoveriesUsed, 1)
      assert.equal(done.stepRuns[1].attempts.length, 1)
    },
  )
  await check(
    'SM15 dispatched side effect enters NEEDS_REVIEW and is never resubmitted',
    async () => {
      const before = lab.state.commits.length
      const created = await run([
        step('navigate', { url: `${lab.url}/app` }),
        step(
          'click',
          { target: locator('#commit') },
          { effectType: 'SIDE_EFFECT' },
        ),
      ])
      const done = await waitRun(created.id, 'NEEDS_REVIEW')
      assert.equal(lab.state.commits.length, before + 1)
      assert.equal(
        done.authCheckpoint?.interruptedClassification,
        'side_effect_dispatched',
      )
    },
  )
  let manual, control
  await check(
    'SM17C/SM24 manual control uses real frames, serial input and identity verification',
    async () => {
      // The preceding recovery consumed the account's one automatic login budget.
      manual = (await operation('LOGIN')).operationId
      await waitOperation(manual, 'WAITING_FOR_AUTH')
      control = await api(
        `/session-operations/${manual}/auth-control/acquire`,
        {},
      )
      const roles = await api('/rbac/roles')
      await api('/console/accounts', {
        displayName: '第二控制者',
        email: 'session-controller',
        password: 'controller-password',
        roleIds: [roles.items.find((r) => r.key === 'admin').id],
      })
      const second = await api('/auth/login', {
        email: 'session-controller',
        password: 'controller-password',
      })
      await api(
        `/session-operations/${manual}/auth-control/acquire`,
        {},
        {
          status: 409,
          headers: { authorization: `Bearer ${second.accessToken}` },
        },
      )
      const meta = await api(`/session-operations/${manual}/browser`)
      for (let i = 0; i < 20; i++)
        await firstSse(
          `${stack.url}/api/session-operations/${manual}/browser/frames`,
          stack.token,
          'frame',
        )
      assert.equal(
        (await api(`/session-operations/${manual}/browser`)).pages.length,
        meta.pages.length,
        'frame reconnection must not leak pages',
      )
      let seq = 0
      async function input(command) {
        const frame = await firstSse(
          `${stack.url}/api/session-operations/${manual}/browser/frames`,
          stack.token,
          'frame',
        )
        const body = {
          token: control.token,
          command: {
            ...command,
            commandId: randomUUID(),
            seq: ++seq,
            pageRef: frame.pageRef,
            frameId: frame.frameId,
            viewport: { width: frame.width, height: frame.height },
          },
        }
        const ack = await api(
          `/session-operations/${manual}/auth-control/input`,
          body,
        )
        if (seq === 1) {
          await api(`/session-operations/${manual}/auth-control/input`, body)
          await api(
            `/session-operations/${manual}/auth-control/input`,
            {
              ...body,
              command: { ...body.command, commandId: randomUUID(), seq: 1 },
            },
            { status: 409 },
          )
        }
        return ack
      }
      await input({ type: 'insert_text', text: 'alice' })
      await input({ type: 'key', key: 'Tab' })
      await input({ type: 'insert_text', text: 'lab-password' })
      await input({ type: 'key', key: 'Enter' })
      await eventually(
        () => Promise.resolve([...lab.state.sessions.values()]),
        (v) => v.includes('alice'),
        'manual login reached target',
      )
      await api(`/session-operations/${manual}/complete-auth`, {
        token: control.token,
      })
      await waitOperation(manual)
      await waitRun((await run()).id)
    },
  )
  await check(
    'SM03 profiles, identity and business output are isolated between two accounts',
    async () => {
      const alice = account
      account = await api(`/targets/${target.id}/accounts`, {
        displayName: 'Bob',
        username: 'bob',
        password: 'lab-password',
      })
      await api(`${accountPath()}/identity`, {
        expectedRevision: account.configRevision ?? 1,
        expectedIdentity: 'bob',
      })
      const done = await waitRun((await run()).id)
      assert.equal(done.context.identity, 'bob')
      assert.notEqual(
        (await api(`${accountPath()}/session`)).session.id,
        sessionId,
      )
      account = alice
      assert.equal((await waitRun((await run()).id)).context.identity, 'alice')
    },
  )
  await check(
    'SM17D/SM44D in-run manual recovery uses the frozen budget and resumes only pending steps',
    async () => {
      const cfg = await api('/platform-config')
      const modified = await api('/platform-config/update', {
        expectedRevision: cfg.revision,
        reason: '隔离环境人工恢复验收',
        document: {
          ...cfg.document,
          runAuthRecovery: {
            maxAutoRecoveriesPerRun: 0,
            maxManualRecoveriesPerRun: 1,
          },
        },
      })
      const created = await run([
        step('navigate', { url: `${lab.url}/app` }),
        step('echo', { value: 'manual-kept' }, { outputKey: 'before' }),
        step('delay', { durationMs: 1500 }),
        step(
          'navigate',
          { url: `${lab.url}/read` },
          { policy: { retryLimit: 1 } },
        ),
      ])
      assert.equal(created.snapshot.runAuthRecovery.maxAutoRecoveriesPerRun, 0)
      await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.context?.before === 'manual-kept',
        'before manual recovery',
      )
      lab.state.sessions.clear()
      const waiting = await waitRun(created.id, 'WAITING_FOR_AUTH')
      assert.equal(waiting.authCheckpoint.manualRecoveriesUsed, 1)
      await loginRun(created.id)
      const done = await waitRun(created.id)
      assert.equal(done.context.before, 'manual-kept')
      assert.equal(done.stepRuns[1].attempts.length, 1)
      assert.equal(done.authCheckpoint.status, 'recovered')
      const latest = await api('/platform-config')
      await api('/platform-config/update', {
        expectedRevision: latest.revision,
        reason: '恢复隔离环境配置',
        document: cfg.document,
      })
      assert.equal(
        (await api(`/runs/${created.id}`)).snapshot.runAuthRecovery
          .maxAutoRecoveriesPerRun,
        0,
      )
    },
  )
  await check(
    'SM13/SM16 REUSE_PAGE refuses a document replaced by login redirection',
    async () => {
      const created = await run(
        [
          step('navigate', { url: `${lab.url}/app` }),
          step('echo', { value: 'form-context' }, { outputKey: 'before' }),
          step('delay', { durationMs: 1500 }),
          step(
            'navigate',
            { url: `${lab.url}/read` },
            { policy: { retryLimit: 1 } },
          ),
        ],
        { sessionPolicy: { reuse: 'REUSE_PAGE' } },
      )
      await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.context?.before === 'form-context',
        'REUSE_PAGE before expiry',
      )
      lab.state.sessions.clear()
      const done = await waitRun(created.id, 'FAILED')
      assert.equal(done.context.before, 'form-context')
      assert.equal(done.stepRuns[1].attempts.length, 1)
      assert.equal(done.authCheckpoint.status, 'unrecoverable')
      const freshRun = await run()
      await waitRun(freshRun.id, 'WAITING_FOR_AUTH')
      await loginRun(freshRun.id)
      await waitRun(freshRun.id)
    },
  )
  await check(
    'SM25 real viewer permissions reject maintenance, browser frames and cross-account writes',
    async () => {
      const roles = await api('/rbac/roles')
      const viewer = roles.items.find((r) => r.key === 'viewer')
      assert.ok(viewer)
      await api('/console/accounts', {
        displayName: '只读验收',
        email: 'session-viewer',
        password: 'viewer-password',
        roleIds: [viewer.id],
      })
      const login = await api('/auth/login', {
        email: 'session-viewer',
        password: 'viewer-password',
      })
      const headers = { authorization: `Bearer ${login.accessToken}` }
      await api(
        `${accountPath()}/session/operations`,
        { kind: 'LOGIN', idempotencyKey: randomUUID() },
        { status: 403, headers },
      )
      await api(
        `/session-operations/${manual}/auth-control/acquire`,
        {},
        { status: 403, headers },
      )
      const mismatched = await api('/targets', {
        code: `other-${Date.now()}`,
        name: '另一系统',
        entryUrl: lab.url,
      })
      await api(
        `/targets/${mismatched.id}/accounts/${account.id}/session/operations`,
        { kind: 'LOGIN', idempotencyKey: randomUUID() },
        { status: 409 },
      )
    },
  )
  await check(
    'SM20/SM21 retention, restart identity and stale generation rejection',
    async () => {
      const cfg = await api('/platform-config')
      await api('/platform-config/update', {
        expectedRevision: cfg.revision,
        reason: '隔离验收保留排程',
        document: {
          ...cfg.document,
          sessionRetention: {
            ...cfg.document.sessionRetention,
            maintenanceIntervalSeconds: 30,
          },
        },
      })
      await api(`${accountPath()}/session/retention`, {
        action: 'set',
        retainSeconds: 600,
      })
      const before = await api(`${accountPath()}/session`)
      const logs = lab.state.logins.length
      await waitOperation((await operation('RESTART')).operationId)
      const after = await api(`${accountPath()}/session`)
      assert.notEqual(after.session.id, before.session.id)
      assert.equal(after.retained, true)
      assert.equal(
        lab.state.logins.length,
        logs,
        'restart must reuse persisted cookie profile',
      )
      await api(
        `${accountPath()}/session/operations`,
        {
          kind: 'CLOSE',
          idempotencyKey: randomUUID(),
          expectedSessionId: before.session.id,
          expectedGeneration: before.session.generation,
        },
        { status: 409 },
      )
      sessionId = after.session.id
      await waitRun((await run()).id)
    },
  )
  await check(
    'SM29 real console: login, overview, detail, retention update, reload and narrow screen',
    async () => {
      const webUrl = await stack.startWeb()
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        })
        await page.goto(`${webUrl}/sign-in`)
        await page.getByLabel('账号', { exact: true }).fill('admin')
        await page
          .getByLabel('密码', { exact: true })
          .fill('e2e-admin-password')
        await page.getByRole('button', { name: '登录', exact: true }).click()
        await page.waitForURL((url) => !url.pathname.includes('sign-in'))
        await page.goto(`${webUrl}/sessions`)
        await page.getByText('Alice', { exact: true }).first().waitFor()
        await page.getByText('Alice', { exact: true }).first().click()
        await page.getByLabel('保留秒数').waitFor()
        await page.getByLabel('保留秒数').fill('900')
        await page
          .getByRole('button', { name: '延长保留', exact: true })
          .click()
        await eventually(
          () => api(`${accountPath()}/session`),
          (v) => Date.parse(v.session.retainUntil) > Date.now() + 800000,
          'UI retention persisted',
        )
        await page.reload()
        await page.getByLabel('保留秒数').waitFor()
        await page.screenshot({
          path: resolve(stack.artifacts, 'console-desktop.png'),
          fullPage: true,
        })
        await page.setViewportSize({ width: 768, height: 1024 })
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          'tablet horizontal overflow',
        )
        await page.screenshot({
          path: resolve(stack.artifacts, 'console-tablet.png'),
          fullPage: true,
        })
        await page.setViewportSize({ width: 390, height: 844 })
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          'narrow screen horizontal overflow',
        )
        await page.screenshot({
          path: resolve(stack.artifacts, 'console-narrow.png'),
          fullPage: true,
        })
      } finally {
        await browser.close()
      }
    },
  )
  await check(
    'SM21/SM38/SM44C background verification visits only retained sessions and does not extend usage',
    async () => {
      const before = await api(`/browser-sessions/${sessionId}`)
      const { sessionOperations } = schemaFor(stack.db.db)
      const background = await eventually(
        () =>
          stack.db.db
            .select()
            .from(sessionOperations)
            .where(
              and(
                eq(sessionOperations.targetId, target.id),
                eq(sessionOperations.origin, 'BACKGROUND'),
                eq(sessionOperations.status, 'SUCCEEDED'),
              ),
            ),
        (rows) => rows.length > 0,
        'retained background maintenance',
        45000,
      )
      assert.ok(
        background.every((op) => op.targetAccountId === account.id),
        'unretained Bob must never receive background maintenance',
      )
      const after = await api(`/browser-sessions/${sessionId}`)
      assert.equal(after.lastUsedAt, before.lastUsedAt)
      assert.equal(after.retainUntil, before.retainUntil)
    },
  )
  await check(
    'SM23 API restart and SSE reconnection restore persisted session state',
    async () => {
      const before = await api(`${accountPath()}/session`)
      await stack.restartApi()
      const after = await api(`${accountPath()}/session`)
      assert.equal(after.session.id, before.session.id)
      assert.equal(after.session.retainUntil, before.session.retainUntil)
      const event = await firstSse(
        `${stack.url}/api/browser-sessions/observe?targetId=${target.id}&accountId=${account.id}`,
        stack.token,
        'session',
      )
      assert.equal(event.targetAccountId, account.id)
    },
  )
  await check(
    'SM26 fake credentials stay out of logs, events and persisted evidence',
    async () => {
      const events = await api(`${accountPath()}/session/events`)
      assert.ok(!JSON.stringify(events).includes('lab-password'))
      for (const name of ['api', 'worker-0', 'worker-1']) {
        const log = readFileSync(
          resolve(stack.artifacts, `${name}.log`),
          'utf8',
        )
        assert.ok(!log.includes('lab-password'), `${name} leaked credentials`)
        assert.ok(
          !log.includes('ERR_HTTP_HEADERS_SENT'),
          `${name} rewrote SSE headers`,
        )
      }
      const runs = await api('/runs')
      for (const item of runs.items) {
        const evidence = await api(`/runs/${item.id}/evidence`)
        assert.ok(
          !JSON.stringify(evidence).includes('lab-password'),
          `evidence leaked credentials: ${item.id}`,
        )
      }
    },
  )
  await check(
    'SM20 reset clears persistent profile and never restores the old login',
    async () => {
      await waitOperation(
        (await operation('RESET_PROFILE', { confirmAccountId: account.id }))
          .operationId,
      )
      const after = await api(`${accountPath()}/session`)
      assert.equal(after.session, null)
      assert.equal(after.retained, false)
      const prepare = await operation('PREPARE')
      await waitOperation(prepare.operationId, 'WAITING_FOR_AUTH')
      await api(`/session-operations/${prepare.operationId}/cancel`, {})
      assert.equal((await api(`${accountPath()}/session`)).occupancy, null)
    },
  )
  await check(
    'SM18 cancellation releases AUTH_WAIT and rejects late completion',
    async () => {
      const created = await run()
      await waitRun(created.id, 'WAITING_FOR_AUTH')
      const granted = await api(
        `/runs/${created.id}/browser/auth-control/acquire`,
        {},
      )
      await api(`/runs/${created.id}/cancel`, {})
      await waitRun(created.id, 'CANCELLED')
      await eventually(
        () => api(`${accountPath()}/session`),
        (v) => v.occupancy === null,
        'cancel releases lease',
      )
      const response = await fetch(
        `${stack.url}/api/runs/${created.id}/resume-auth`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${stack.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: granted.token }),
        },
      )
      assert.ok(response.status >= 400)
      assert.equal((await api(`/runs/${created.id}`)).status, 'CANCELLED')
    },
  )
  await check(
    'SM18 auth-wait deadline releases occupancy and fences late control',
    async () => {
      const created = await run(undefined, {
        sessionPolicy: { authWaitSeconds: 3 },
      })
      await waitRun(created.id, 'WAITING_FOR_AUTH')
      const granted = await api(
        `/runs/${created.id}/browser/auth-control/acquire`,
        {},
      )
      const done = await eventually(
        () => api(`/runs/${created.id}`),
        (r) => r.status === 'FAILED',
        'AUTH_WAIT deadline',
        10000,
      )
      assert.equal(done.status, 'FAILED')
      assert.equal((await api(`${accountPath()}/session`)).occupancy, null)
      await api(
        `/runs/${created.id}/resume-auth`,
        { token: granted.token },
        { status: 409 },
      )
    },
  )
  await check(
    'SM22/SM33 kill AUTH_WAIT owner: survivor reaps lease, fences control, and keeps LOST key',
    async () => {
      const created = await run(undefined, {
        sessionPolicy: { leaseTtlSeconds: 6 },
      })
      await waitRun(created.id, 'WAITING_FOR_AUTH')
      const granted = await api(
        `/runs/${created.id}/browser/auth-control/acquire`,
        {},
      )
      const view = await api(`${accountPath()}/session`)
      const owner = Number(view.session.ownerWorkerId.split('-').at(-1))
      stack.workers[owner].kill('SIGKILL')
      await eventually(
        () => api(`${accountPath()}/session`),
        (v) => v.session?.status === 'LOST' && v.occupancy === null,
        'lost owner fenced',
        25000,
      )
      const recovered = await api(`/runs/${created.id}`)
      assert.equal(recovered.status, 'RECOVERING')
      assert.equal(await countFailedRecoveries(stack.db.db, created.id), 1)
      const queued = await run()
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal((await api(`/runs/${queued.id}`)).status, 'QUEUED')
      assert.equal(
        (await api(`${accountPath()}/session`)).session.id,
        view.session.id,
      )
      const response = await fetch(
        `${stack.url}/api/runs/${created.id}/resume-auth`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${stack.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: granted.token }),
        },
      )
      assert.ok(response.status >= 400)
    },
  )
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  if (stack) {
    try {
      writeFileSync(
        resolve(stack.artifacts, 'results.json'),
        JSON.stringify(results, null, 2),
      )
      if (results.some((result) => !result.passed)) {
        const { workers, browserSessions, sessionLeases, sessionOperations } =
          schemaFor(stack.db.db)
        const facts = {
          workers: await stack.db.db
            .select({
              id: workers.id,
              status: workers.status,
              instanceId: workers.instanceId,
              heartbeatAt: workers.heartbeatAt,
              heartbeatExpiresAt: workers.heartbeatExpiresAt,
            })
            .from(workers),
          sessions: await stack.db.db
            .select({
              id: browserSessions.id,
              status: browserSessions.status,
              closeReason: browserSessions.closeReason,
              health: browserSessions.health,
              owner: browserSessions.ownerWorkerId,
              instance: browserSessions.ownerWorkerInstanceId,
              hold: browserSessions.authHoldRunId,
            })
            .from(browserSessions),
          leases: await stack.db.db.select().from(sessionLeases),
          operations: await stack.db.db
            .select({
              id: sessionOperations.id,
              status: sessionOperations.status,
              sessionId: sessionOperations.expectedSessionId,
              error: sessionOperations.errorCode,
            })
            .from(sessionOperations),
        }
        writeFileSync(
          resolve(stack.artifacts, 'failure-facts.json'),
          JSON.stringify(facts, null, 2),
        )
      }
    } catch (diagnosticError) {
      console.error(
        'Could not save failure diagnostics:',
        diagnosticError.message,
      )
    } finally {
      await stack.close()
    }
  }
  await lab.close()
}
