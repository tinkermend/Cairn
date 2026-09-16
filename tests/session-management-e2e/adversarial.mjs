import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startStack, eventually, firstSse } from './stack.mjs'
import { startSessionTarget } from './target.mjs'
import { schemaFor } from '../../packages/db/dist/test-entry.js'

const lab = await startSessionTarget()
const results = []
let caseRuns = []
let stack,
  target,
  fixtureNo = 0
const locator = (css) => ({
  candidates: [{ by: 'css', value: css }],
  framePath: [],
})
const step = (type, input, extra = {}) => ({
  id: randomUUID(),
  name: type,
  type,
  effectType: 'READ_ONLY',
  input,
  ...extra,
})
const finished = (r) =>
  [
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'NEEDS_REVIEW',
    'WAITING_FOR_AUTH',
  ].includes(r.status)
async function check(name, fn) {
  if (process.env.CAIRN_FAULT_FILTER && !name.includes(process.env.CAIRN_FAULT_FILTER)) return
  const started = Date.now()
  caseRuns = []
  try {
    await fn()
    results.push({ name, passed: true, durationMs: Date.now() - started })
    console.log(`PASS ${name}`)
  } catch (error) {
    results.push({ name, passed: false, error: error.stack })
    console.error(`FAIL ${name}\n${error.stack}`)
    process.exitCode = 1
  } finally {
    lab.state.verifyFault = null
    lab.state.verifyStatus = null
    lab.state.loginDropUsers.clear()
    lab.releaseBarriers()
    for (const r of caseRuns) {
      const current = await api(`/runs/${r.id}`).catch(() => null)
      if (current && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(current.status)) {
        await api(`/runs/${r.id}/cancel`, {}).catch(() => undefined)
      }
    }
  }
}
const api = (...args) => stack.request(...args)
const path = (account) => `/targets/${target.id}/accounts/${account.id}`
const view = (account) => api(`${path(account)}/session`)
async function waitRun(run, status) {
  const value = await eventually(
    () => api(`/runs/${run.id}`),
    finished,
    'fault Run terminal',
    30000,
  )
  if (status) assert.equal(value.status, status, JSON.stringify({ id: value.id, status: value.status, stepRuns: value.stepRuns }))
  return value
}
async function operation(account, kind, expectedStatus = 'SUCCEEDED') {
  await noOccupancy(account)
  const current = await view(account)
  const request = await api(`${path(account)}/session/operations`, {
    kind,
    idempotencyKey: randomUUID(),
    ...(current.session
      ? {
          expectedSessionId: current.session.id,
          expectedGeneration: current.session.generation,
        }
      : {}),
  })
  const done = await eventually(
    () => api(`/session-operations/${request.operationId}`),
    finished,
    'fault operation terminal',
    20000,
  )
  assert.equal(done.status, expectedStatus, JSON.stringify(done))
  return done
}
async function account(label, password = 'lab-password') {
  const username = `${label}-${++fixtureNo}`
  lab.state.users.set(username, 'lab-password')
  const created = await api(`/targets/${target.id}/accounts`, {
    displayName: username,
    username,
    password,
  })
  return api(`${path(created)}/identity`, {
    expectedRevision: created.configRevision,
    expectedIdentity: username,
  })
}
async function run(
  account,
  steps = [
    step('navigate', { url: `${lab.url}/read` }),
    step('echo', { value: 'business-ran' }, { outputKey: 'business' }),
  ],
  options = {},
) {
  const scenario = await api('/scenarios', {
    targetId: target.id,
    name: `fault-${randomUUID()}`,
    steps,
  })
  const created = await api('/runs', {
    scenarioId: scenario.id,
    targetAccountId: account.id,
    ...options,
  })
  caseRuns.push(created)
  return created
}
async function arrival(gate) {
  let timer
  try {
    await Promise.race([gate.arrived, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('target barrier was never reached')), 10000)
    })])
  } finally { clearTimeout(timer) }
}
async function noOccupancy(account) {
  await eventually(
    () => view(account),
    (v) => v.occupancy === null,
    'fault must release occupation',
    10000,
  )
}
async function cancel(run, account) {
  await api(`/runs/${run.id}/cancel`, {})
  await waitRun(run, 'CANCELLED')
  await noOccupancy(account)
}
async function markUnknown(account) {
  lab.state.verifyStatus = 500
  try {
    await operation(account, 'VERIFY_AUTH', 'FAILED')
  } finally {
    lab.state.verifyStatus = null
  }
}
async function humanLogin(run, username) {
  const base = `/runs/${run.id}/browser`
  const control = await api(`${base}/auth-control/acquire`, {})
  let seq = 0
  for (const command of [
    { type: 'insert_text', text: username },
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
      token: control.token,
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
    (values) => values.includes(username),
    'human login accepted',
  )
  return control
}
async function saveFacts() {
  const {
    browserSessions,
    sessionLeases,
    workers,
    runs,
    targetAccountAuthBudget,
  } = schemaFor(stack.db.db)
  writeFileSync(
    resolve(stack.artifacts, 'fault-facts.json'),
    JSON.stringify(
      {
        sessions: await stack.db.db
          .select({
            id: browserSessions.id,
            status: browserSessions.status,
            health: browserSessions.health,
            reason: browserSessions.closeReason,
            account: browserSessions.targetAccountId,
          })
          .from(browserSessions),
        leases: await stack.db.db.select().from(sessionLeases),
        workers: await stack.db.db
          .select({
            id: workers.id,
            status: workers.status,
            instanceId: workers.instanceId,
          })
          .from(workers),
        runs: await stack.db.db
          .select({ id: runs.id, status: runs.status, context: runs.context })
          .from(runs),
        budgets: await stack.db.db.select().from(targetAccountAuthBudget),
        target: {
          logins: lab.state.logins,
          commits: lab.state.commits,
          reads: lab.state.reads,
        },
      },
      null,
      2,
    ),
  )
}

try {
  stack = await startStack()
  console.log(`Artifacts: ${stack.artifacts}`)
  await check('N00 malformed IDs are rejected at HTTP boundary', async () => {
    for (const route of ['/browser-sessions/undefined', '/session-operations/bad', '/targets/bad/accounts/bad/session']) {
      await api(route, undefined, { status: 400 })
    }
    await api('/browser-sessions/bad/dispose', {}, { status: 400 })
  })
  const config = await api('/platform-config')
  await api('/platform-config/update', {
    expectedRevision: config.revision,
    reason: '隔离故障验证时间预算',
    document: {
      ...config.document,
      sessionAuth: {
        ...config.document.sessionAuth,
        verifyTimeoutMs: 1200,
        loginTimeoutMs: 3000,
        verifyRetryBackoffSeconds: [1],
      },
    },
  })
  target = await api('/targets', {
    code: `fault-${Date.now()}`,
    name: '会话故障注入',
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
  const seed = await account('seed')
  await waitRun(await run(seed), 'SUCCEEDED')
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
  const validation = await api(
    `/targets/${target.id}/auth-profile/validations`,
    {
      targetAccountId: seed.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    },
  )
  const validationId = validation.operation.id
  await eventually(
    () => api(`/session-operations/${validationId}`),
    (r) => r.status === 'WAITING_FOR_AUTH',
    'validation waiting',
  )
  await api(
    `/targets/${target.id}/auth-profile/validations/${validationId}/observe`,
    { step: 'valid_pass' },
  )
  const cookies = new Map(lab.state.sessions)
  lab.state.sessions.clear()
  await api(
    `/targets/${target.id}/auth-profile/validations/${validationId}/observe`,
    { step: 'server_revoked' },
  )
  lab.state.sessions = new Map([...cookies].map(([key]) => [key, 'bob']))
  await api(
    `/targets/${target.id}/auth-profile/validations/${validationId}/observe`,
    { step: 'other_account' },
  )
  lab.state.sessions = cookies
  await operation(seed, 'CLOSE')

  for (const fault of ['403', 'invalid-json', 'disconnect', 'hang']) {
    await check(
      `N01 ${fault}: no guessed authentication, no credentials or business actions`,
      async () => {
        const a = await account(`network-${fault}`)
        if (fault === '403') lab.state.verifyStatus = 403
        else lab.state.verifyFault = fault
        const created = await run(a)
        await eventually(
          () => view(a),
          (v) =>
            v.session?.authState === 'UNKNOWN' &&
            (v.occupancy === null || v.occupancy.purpose === 'AUTH_WAIT'),
          'network failure must release execution',
          15000,
        )
        assert.equal(
          lab.state.logins.filter((l) => l.user === a.username).length,
          0,
        )
        assert.equal(
          lab.state.reads.filter((r) => r.user === a.username).length,
          0,
        )
        assert.ok(
          (await api(`/runs/${created.id}`)).stepRuns.every(
            (s) => s.attempts.length === 0,
          ),
        )
        await cancel(created, a)
        lab.state.verifyStatus = null
        lab.state.verifyFault = null
        await waitRun(await run(a), 'SUCCEEDED')
        await operation(a, 'CLOSE')
      },
    )
  }

  await check(
    'N02 wrong password: one submission; budget survives real Worker restart',
    async () => {
      const a = await account('wrong-password', 'wrong-test-password')
      const first = await run(a)
      await waitRun(first, 'WAITING_FOR_AUTH')
      assert.equal(
        lab.state.logins.filter((l) => l.user === a.username).length,
        1,
      )
      const owner = Number(
        (await view(a)).session.ownerWorkerId.split('-').at(-1),
      )
      await cancel(first, a)
      await operation(a, 'CLOSE')
      await stack.restartWorker(owner)
      const second = await run(a)
      await waitRun(second, 'WAITING_FOR_AUTH')
      assert.equal(
        lab.state.logins.filter((l) => l.user === a.username).length,
        1,
        'restart must not reset account login budget',
      )
      await cancel(second, a)
      await operation(a, 'CLOSE')
    },
  )

  await check(
    'N03 login accepted but response lost: one platform attempt; no retry in a later Run',
    async () => {
      const a = await account('lost-login-response')
      lab.state.loginDropUsers.add(a.username)
      const first = await run(a)
      await waitRun(first, 'WAITING_FOR_AUTH')
      const received = lab.state.logins.filter((l) => l.user === a.username).length
      assert.ok(received >= 1 && received <= 2, 'Chromium may transparently retry a response with zero bytes')
      const { targetAccountAuthBudget } = schemaFor(stack.db.db)
      const budget = (await stack.db.db.select().from(targetAccountAuthBudget)).find(b => b.targetAccountId === a.id)
      assert.equal(budget.autoLoginCount, 1)
      console.log(`  response lost: platform submissions=1, target POSTs=${received}`)
      await cancel(first, a)
      const second = await run(a)
      await waitRun(second, 'WAITING_FOR_AUTH')
      assert.equal(
        lab.state.logins.filter((l) => l.user === a.username).length,
        received,
      )
      await cancel(second, a)
      await operation(a, 'CLOSE')
    },
  )

  await check(
    'N04 account revoked while positive verification is in flight: no business dispatch',
    async () => {
      const a = await account('revoke-account')
      await waitRun(await run(a), 'SUCCEEDED')
      await markUnknown(a)
      const before = lab.state.reads.filter((r) => r.user === a.username).length
      const gate = lab.holdNextProbe()
      const created = await run(a)
      try {
        await arrival(gate)
        await api(path(a), { status: 'disabled' })
      } finally {
        gate.release()
      }
      const result = await waitRun(created)
      assert.equal(result.status, 'FAILED', 'revoked account must fail closed')
      assert.ok(result.stepRuns.every((s) => s.attempts.length === 0))
      assert.equal(
        lab.state.reads.filter((r) => r.user === a.username).length,
        before,
      )
      await noOccupancy(a)
    },
  )

  await check(
    'N05 password cleared during expired probe: frozen secret cannot be submitted',
    async () => {
      const a = await account('revoke-secret')
      const gate = lab.holdNextProbe()
      const created = await run(a)
      try {
        await arrival(gate)
        await api(path(a), { clearPassword: true })
      } finally {
        gate.release()
      }
      await waitRun(created, 'FAILED')
      assert.equal(
        lab.state.logins.filter((l) => l.user === a.username).length,
        0,
      )
      await noOccupancy(a)
      await operation(a, 'CLOSE')
    },
  )

  await check('N05B password cleared while login page is loading: cached plaintext never submitted', async () => {
    const a = await account('revoke-resolved-secret')
    const gate = lab.holdNextLoginPage()
    const created = await run(a)
    try {
      await arrival(gate)
      await api(path(a), { clearPassword: true })
    } finally { gate.release() }
    await waitRun(created, 'FAILED')
    assert.equal(lab.state.logins.filter(l => l.user === a.username).length, 0)
    await noOccupancy(a)
    await operation(a, 'CLOSE')
  })

  await check(
    'N06 cancel in-flight verification: late successful response cannot revive Run',
    async () => {
      const a = await account('late-verify')
      await waitRun(await run(a), 'SUCCEEDED')
      await markUnknown(a)
      const gate = lab.holdNextProbe()
      const created = await run(a)
      try {
        await arrival(gate)
        await cancel(created, a)
      } finally {
        gate.release()
      }
      await new Promise((r) => setTimeout(r, 1800))
      const done = await api(`/runs/${created.id}`)
      assert.equal(done.status, 'CANCELLED')
      assert.ok(done.stepRuns.every((s) => s.attempts.length === 0))
      await noOccupancy(a)
    },
  )

  await check(
    'N07 human logs into another identity: completion rejected and steps remain undispatched',
    async () => {
      const a = await account('wrong-human', 'wrong-test-password')
      const created = await run(a)
      await waitRun(created, 'WAITING_FOR_AUTH')
      const control = await humanLogin(created, 'bob')
      await api(
        `/runs/${created.id}/resume-auth`,
        { token: control.token },
        { status: 409 },
      )
      const waiting = await api(`/runs/${created.id}`)
      assert.equal(waiting.status, 'WAITING_FOR_AUTH')
      assert.ok(waiting.stepRuns.every((s) => s.attempts.length === 0))
      await cancel(created, a)
      await operation(a, 'CLOSE')
    },
  )

  await check('N07B account revoked while a human holds control: input and completion rejected', async () => {
    const a = await account('revoked-human', 'wrong-test-password')
    const created = await run(a)
    await waitRun(created, 'WAITING_FOR_AUTH')
    const base = `/runs/${created.id}/browser`
    const control = await api(`${base}/auth-control/acquire`, {})
    const frame = await firstSse(`${stack.url}/api${base}/frames`, stack.token, 'frame')
    await api(path(a), { status: 'disabled' })
    await api(`${base}/auth-control/input`, {
      token: control.token,
      command: { type: 'insert_text', text: 'blocked', commandId: randomUUID(), seq: 1,
        pageRef: frame.pageRef, frameId: frame.frameId, viewport: { width: frame.width, height: frame.height } },
    }, { status: 409 })
    await api(`/runs/${created.id}/resume-auth`, { token: control.token }, { status: 409 })
    const done = await api(`/runs/${created.id}`)
    assert.equal(done.status, 'WAITING_FOR_AUTH')
    assert.ok(done.stepRuns.every(s => s.attempts.length === 0))
    await cancel(created, a)
  })

  await check(
    'N08 side effect response lost: NEEDS_REVIEW, no platform retry',
    async () => {
      const a = await account('lost-business-response')
      const created = await run(a, [
        step('navigate', { url: `${lab.url}/app` }),
        step(
          'click',
          { target: locator('#commit-drop') },
          {
            effectType: 'SIDE_EFFECT',
            policy: { timeoutMs: 3000, retryLimit: 2 },
          },
        ),
      ])
      await waitRun(created, 'NEEDS_REVIEW')
      const received = lab.state.commits.filter((c) => c.user === a.username).length
      assert.ok(received >= 1 && received <= 2)
      await new Promise(r => setTimeout(r, 1000))
      assert.equal(lab.state.commits.filter((c) => c.user === a.username).length, received)
      console.log(`  response lost: platform attempts=1, target POSTs=${received}`)
      assert.equal(
        (await api(`/runs/${created.id}`)).stepRuns[1].attempts.length,
        1,
      )
      await noOccupancy(a)
      await operation(a, 'CLOSE')
    },
  )

  await check(
    'N09 live zombie Worker: expired ownership cannot publish late success or double-submit',
    async () => {
      const a = await account('zombie-worker')
      const gate = lab.holdNextCommit()
      const created = await run(
        a,
        [
          step('navigate', { url: `${lab.url}/app` }),
          step(
            'click',
            { target: locator('#commit-hold') },
            {
              effectType: 'SIDE_EFFECT',
              policy: { timeoutMs: 25000, retryLimit: 2 },
            },
          ),
        ],
        { sessionPolicy: { leaseTtlSeconds: 6 } },
      )
      let child
      try {
        await arrival(gate)
        const owner = Number(
          (await view(a)).session.ownerWorkerId.split('-').at(-1),
        )
        const queued = await run(a, [step('wait', { kind: 'time', durationMs: 20000 })])
        child = stack.workers[owner]
        child.kill('SIGSTOP')
        await eventually(() => view(a), v => v.session?.status === 'LOST', 'survivor isolates live zombie', 20000)
        await new Promise((r) => setTimeout(r, 1000))
        assert.equal((await api(`/runs/${queued.id}`)).status, 'QUEUED')
        assert.equal(
          lab.state.commits.filter((c) => c.user === a.username).length,
          1,
        )
        gate.release()
        child.kill('SIGCONT')
        await cancel(queued, a)
        await eventually(
          () => api(`/runs/${created.id}`),
          (r) => r.status !== 'RUNNING',
          'old Run lease fenced',
          10000,
        )
        await new Promise((r) => setTimeout(r, 2500))
        const result = await api(`/runs/${created.id}`)
        assert.notEqual(result.status, 'SUCCEEDED')
        assert.notEqual(result.stepRuns[1].attempts[0]?.status, 'SUCCEEDED')
        assert.equal(
          lab.state.commits.filter((c) => c.user === a.username).length,
          1,
        )
        assert.equal((await api(`/runs/${queued.id}`)).status, 'CANCELLED')
        await eventually(() => api('/workers'), r => r.items.filter(w => w.workerId.startsWith('session-e2e-')).every(w => w.status === 'READY'), 'both Workers recover without duplicate registration', 15000)
      } finally {
        child?.kill('SIGCONT')
        gate.release()
      }
    },
  )
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  if (stack) {
    try {
      writeFileSync(
        resolve(stack.artifacts, 'adversarial-results.json'),
        JSON.stringify(results, null, 2),
      )
      await saveFacts()
    } finally {
      await stack.close()
    }
  }
  await lab.close()
}
