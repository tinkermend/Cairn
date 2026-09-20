/** Dual-source authoring → persisted trial → Engine → managed Chromium / installed SDK.
 * Only the VL provider is replaced with a local, page-grounded fixture. Business writes,
 * leases, AI budgets, attempts, outcomes, object evidence and validation are real.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseDemonstrationFile } from '@cairn/authoring'
import {
  ensureTargetAccountCredential,
  getOrCreatePlatformConfig,
  getScenarioValidation,
} from '@cairn/db'
import {
  applyDemonstrationImport,
  claimRun,
  createDemonstration,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  newId,
  openIsolatedDb,
  prepareTrialVersion,
  previewDemonstrationImport,
  registerWorker,
  requestRunCancel,
  schemaFor,
  type DbHandle,
} from '@cairn/db/testing'
import {
  AI_ATOMIC_ACTIONS_PROTOCOL,
  DEMONSTRATION_PROTOCOL,
  DEV_CREDENTIAL_KEY,
  FACTORY_PLATFORM_CONFIG,
  IMPORTED_OUTCOME_PROTOCOL,
  targetAuthProfileDefinitionSchema,
  type DemonstrationProfile,
  type ApplyDemonstrationBody,
} from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { LocalObjectStore } from '@cairn/storage'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { testAiExecution } from '../__tests__/harness.js'
import { BrowserSessionManager } from '../browser/session-manager.js'
import { createBrowserPort } from '../browser/port.js'
import { ObjectService } from '../objects/object.service.js'
import { ExecutionEngine } from '../engine/engine.js'
import { AiStepExecutor } from '../engine/ai-executor.js'
import { BrowserStepExecutor } from '../engine/browser-executor.js'
import { FixtureStepExecutor } from '../engine/fixture-executor.js'
import { StepExecutorRegistry } from '../engine/step-executor.js'
import { createAiPort } from './port.js'
import * as formal from './midscene/formal-agent.js'
import { createFakeChatClient } from './midscene/model-client.js'

describe('demonstration sources × real Engine / Chromium', { timeout: 240_000 }, () => {
  let handle: DbHandle
  let manager: BrowserSessionManager
  let engine: ExecutionEngine
  let server: ReturnType<typeof createServer>
  let origin: string
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let instanceId: string
  let objectRoot: string
  let profileRoot: string
  let rearranged = false
  let authValid = true
  const submissions: string[] = []
  const modelPrompts: string[] = []
  const login =
    '<form method="POST" action="/login"><input name="username"><input name="password" type="password"><button type="submit">登录</button></form>'

  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_test_di_${Date.now().toString(36)}`)
    const t = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    workerId = `di-lab-${newId()}`
    instanceId = newId()
    const secretId = newId()
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://127.0.0.1').pathname
      if (path === '/login' && req.method === 'POST') {
        req.resume()
        authValid = true
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'di=ok; Path=/; HttpOnly' })
        res.end()
        return
      }
      if (path === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(login)
        return
      }
      const authenticated = authValid && (req.headers.cookie ?? '').includes('di=ok')
      if (path === '/auth') {
        res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: authenticated, user: authenticated ? 'lab' : null }))
        return
      }
      if (!authenticated) {
        res.writeHead(302, { Location: '/login' })
        res.end()
        return
      }
      if (path === '/submit' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          const value = Buffer.concat(chunks).toString()
          submissions.push(value)
          if (value === 'EXPIRED') {
            authValid = false
            res.writeHead(401)
            res.end('AUTH EXPIRED')
            return
          }
          const respond = () => {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end(value === 'EMPTY' ? 'EMPTY' : 'DONE')
          }
          if (value === 'DELAY') setTimeout(respond, 5000).unref()
          else respond()
        })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const input =
        '<label>订单号<input id="order" aria-label="订单号" style="width:240px;height:40px"></label>'
      const button = '<button id="submit" style="width:140px;height:40px">提交订单</button>'
      res.end(`<html><body style="padding:${rearranged ? 140 : 20}px">${rearranged ? button + '<br>' + input : input + button}<div id="result">INITIAL</div><script>
        document.querySelector('#submit').onclick = async () => {
          const response = await fetch('/submit', {method:'POST', body:document.querySelector('#order').value});
          if (response.status === 401) { location.href='/login'; return; }
          document.querySelector('#result').textContent = await response.text();
        };
      </script></body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture port')
    origin = `http://127.0.0.1:${address.port}`
    await handle.db
      .insert(t.consoleAccounts)
      .values({ id: actorId, displayName: 'DI lab', status: 'active' })
    const [admin] = await handle.db
      .select()
      .from(t.consoleRoles)
      .where(eq(t.consoleRoles.key, 'admin'))
      .limit(1)
    await handle.db
      .insert(t.consoleAccountRoles)
      .values({
        consoleAccountId: actorId,
        consoleRoleId: admin!.id,
        targetScopeMode: 'all',
        targetScopeIds: [],
      })
    await handle.db
      .insert(t.targets)
      .values({
        id: targetId,
        code: `di${Date.now().toString(36)}`,
        name: '示教受控业务',
        entryUrl: `${origin}/`,
        loginUrl: `${origin}/login`,
        authMethod: 'password',
        captchaMode: 'none',
        currentAuthProfileRevision: 1,
        loginFields: {
          username: { by: 'name', value: 'username' },
          password: { by: 'name', value: 'password' },
          submit: { by: 'css', value: 'button[type=submit]' },
        },
      })
    await handle.db
      .insert(t.secrets)
      .values({ id: secretId, provider: 'local', ciphertext: secrets.encrypt(secretId, 'lab') })
    await handle.db
      .insert(t.targetAccounts)
      .values({
        id: accountId,
        targetId,
        displayName: 'lab',
        username: 'lab',
        secretProvider: 'local',
        secretId,
        status: 'active',
        expectedIdentity: 'lab',
      })
    await ensureTargetAccountCredential(handle, {
      account: {
        id: accountId,
        targetId,
        displayName: 'lab',
        username: 'lab',
        configRevision: 1,
        secretId,
        secretProvider: 'local',
      },
      sealed: { id: secretId, provider: 'local' },
      actor: { id: actorId },
    })
    await handle.db
      .insert(t.targetAuthProfiles)
      .values({
        id: newId(),
        targetId,
        revision: 1,
        digest: 'a'.repeat(64),
        definition: targetAuthProfileDefinitionSchema.parse({
          verify: {
            mode: 'http',
            path: '/auth',
            success: { status: 200, jsonPath: '$.ok', equals: true },
            failure: { status: 401 },
          },
          identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' },
          scope: { origins: [origin], pathPrefixes: ['/auth'] },
        }),
      })
    await handle.db
      .update(t.targetAuthProfiles)
      .set({
        validation: {
          recordedAt: new Date().toISOString(),
          actorId,
          operationId: newId(),
          steps: {
            valid_pass: {
              authState: 'AUTHENTICATED',
              identityState: 'MATCH',
              observedIdentity: 'lab',
              unknownClass: null,
              evidenceSummary: 'local fixture',
              authProfileRevision: 1,
              diagnosticCode: 'verified',
            },
            server_revoked: {
              authState: 'EXPIRED',
              identityState: 'UNVERIFIED',
              observedIdentity: null,
              unknownClass: null,
              evidenceSummary: 'local fixture',
              authProfileRevision: 1,
              diagnosticCode: 'verified',
            },
            other_account: {
              authState: 'AUTHENTICATED',
              identityState: 'MISMATCH',
              observedIdentity: 'other',
              unknownClass: null,
              evidenceSummary: 'local fixture',
              authProfileRevision: 1,
              diagnosticCode: 'verified',
            },
          },
        },
      })
      .where(eq(t.targetAuthProfiles.targetId, targetId))
    await getOrCreatePlatformConfig(handle, {
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        sessionAuth: { ...FACTORY_PLATFORM_CONFIG.sessionAuth, autoLoginMaxPerWindow: 20 },
        runAuthRecovery: { maxAutoRecoveriesPerRun: 0, maxManualRecoveriesPerRun: 0 },
      },
      reason: 'isolated demonstration business fixture',
    })
    await registerWorker(handle.db, {
      workerId,
      instanceId,
      capacity: 1,
      lostAfterSeconds: 3600,
      protocolCapabilities: [
        ...WORKER_TEST_PROTOCOLS,
        AI_ATOMIC_ACTIONS_PROTOCOL,
        IMPORTED_OUTCOME_PROTOCOL,
      ],
    })
    objectRoot = mkdtempSync(join(tmpdir(), 'cairn-di-objects-'))
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-di-browser-'))
    const objects = new ObjectService(handle, new LocalObjectStore(objectRoot, 32 * 1024 * 1024), {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 32 * 1024 * 1024,
      traceMaxBytes: 128 * 1024 * 1024,
      videoMaxBytes: 128 * 1024 * 1024,
      uploadMaxAttempts: 3,
    })
    manager = new BrowserSessionManager(
      handle,
      {
        workerId,
        workerInstanceId: instanceId,
        profileRoot,
        headless: true,
        maxSessions: 2,
        defaultLeaseTtlSeconds: 120,
        defaultAuthWaitSeconds: 10,
        heartbeatMs: 10_000,
      },
      secrets,
      objects,
    )
    await manager.reconcileOwn()
    const createAgent = formal.createFormalMidsceneAgent
    vi.spyOn(formal, 'createFormalMidsceneAgent').mockImplementation((args) =>
      createAgent({
        ...args,
        wrapClient: () =>
          args.wrapClient(
            createFakeChatClient(async (_n, params) => {
              const prompt = JSON.stringify(params)
              modelPrompts.push(prompt)
              let answer: object
              if (args.readonly)
                answer = {
                  data: {
                    StatementIsTruthy:
                      (await args.page.locator('#result').textContent()) === 'DONE',
                  },
                  thought: '读取本地受控业务的实际结果',
                }
              else {
                const selector = prompt.includes('提交订单') ? '#submit' : '#order'
                const box = await args.page.locator(selector).boundingBox()
                const viewport = args.page.viewportSize()!
                if (!box) throw new Error('fixture element missing')
                answer = {
                  bbox: [box.x, box.y, box.x + box.width, box.y + box.height].map((v, i) =>
                    Math.round((v / (i % 2 ? viewport.height : viewport.width)) * 1000),
                  ),
                }
              }
              const content = args.readonly
                ? `<observation>受控页面的实际结果</observation><data-json>${JSON.stringify((answer as { data: object }).data)}</data-json>`
                : JSON.stringify(answer)
              return {
                id: 'di-local-vl',
                object: 'chat.completion',
                created: 1,
                model: 'cairn-fake',
                choices: [
                  { index: 0, finish_reason: 'stop', message: { role: 'assistant', content } },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }
            }),
          ),
      }),
    )
    const browser = createBrowserPort(manager, objects)
    const ai = createAiPort({
      manager,
      handle,
      objects,
      resolveApiKey: async () => 'offline-fixture',
    })
    engine = new ExecutionEngine(
      handle,
      browser,
      secrets,
      new StepExecutorRegistry([
        new FixtureStepExecutor(),
        new BrowserStepExecutor(handle, browser),
        new AiStepExecutor(ai),
      ]),
    )
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await manager?.shutdown()
    await handle?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    for (const dir of [profileRoot, objectRoot])
      if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it.each(['playwright-crx@0.15.0', 'midscene-yaml-flow@1'] as const)(
    '%s: parameters, layout, empty/delayed results and revoked auth',
    async (profile: DemonstrationProfile) => {
      rearranged = false
      authValid = true
      const text =
        profile === 'midscene-yaml-flow@1'
          ? `web: {url: '${origin}/'}\ntasks:\n- flow:\n  - aiInput: 订单号\n    value: SO-1\n  - aiTap: 提交订单\n  - aiAssert: 显示成功结果`
          : [
              { name: 'navigate', url: `${origin}/` },
              { name: 'fill', selector: '#order', text: 'SO-1', pageAlias: 'page' },
              {
                name: 'click',
                selector: '#submit',
                pageAlias: 'page',
                button: 'left',
                clickCount: 1,
                modifiers: 0,
              },
              { name: 'assertText', selector: '#result', text: 'DONE', pageAlias: 'page' },
            ]
              .map((value) => JSON.stringify(value))
              .join('\n')
      const source = parseDemonstrationFile({ text, profile, targetId, captureId: newId() })
      const saved = await createDemonstration(
        handle.db,
        { source, name: profile, idempotencyKey: newId(), acknowledgedOmittedConfig: true },
        { id: actorId },
      )
      const scenario = await createScenarioWithVersion(handle.db, {
        targetId,
        name: profile,
        actor: { id: actorId },
        steps: [
          {
            id: newId(),
            name: '结束',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { value: 'end' },
          },
        ],
      })
      const request = {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        recordingDraftId: saved.recordingDraftId,
        baseRevision: 1,
        placement: { kind: 'start' as const },
      }
      const preview = await previewDemonstrationImport(handle.db, scenario.id, request, actorId)
      expect(preview.suggestions.filter((s) => s.status !== 'mapped')).toEqual([])
      const decisions: ApplyDemonstrationBody['decisions'] = preview.suggestions.map((s) => ({
        id: s.id,
        disposition: 'accept',
        ...(s.parameter ? { parameter: { key: 'orderNo', label: '订单号' } } : {}),
      }))
      const applied = await applyDemonstrationImport(
        handle.db,
        scenario.id,
        {
          ...request,
          factDigest: preview.factDigest,
          suggestionDigest: preview.suggestionDigest,
          adapterVersion: preview.adapterVersion,
          ruleVersion: preview.ruleVersion,
          idempotencyKey: newId(),
          decisions,
        },
        { id: actorId },
      )
      const trial = await prepareTrialVersion(handle.db, scenario.id, {
        revision: applied.scenario.draft!.revision,
        runInput: { orderNo: 'SO-1' },
        actor: { id: actorId },
      })
      const passedIds: string[] = []
      for (const value of ['SO-1', 'SO-2', 'REARRANGED', 'EMPTY', 'DELAY', 'EXPIRED']) {
        rearranged = value === 'REARRANGED'
        authValid = true
        const countBefore = submissions.length
        const created = await createRunWithSnapshot(handle.db, {
          scenarioId: scenario.id,
          scenarioVersionId: trial.versionId,
          allowTrialVersion: true,
          targetAccountId: accountId,
          input: { orderNo: value },
          actor: { id: actorId },
          debugMode: 'runThrough',
          evidencePolicy: { screenshot: 'always', video: 'off', trace: 'off', required: ['input'] },
          aiExecution: testAiExecution({ requestTimeoutMs: 10_000, hangWaitMs: 1000 }),
        })
        const grant = await claimRun(handle, { workerId, instanceId, leaseTtlSeconds: 180 })
        expect(grant?.runId).toBe(created.detail.id)
        await engine.execute(created.detail.id, { grant: grant! })
        const detail = await getRun(handle.db, created.detail.id)
        expect(submissions.slice(countBefore)).toEqual([value])
        expect(detail.stepRuns.every((s) => s.attempts.length <= 1)).toBe(true)
        const validation = await getScenarioValidation(handle, scenario.id, actorId)
        const sample = validation.samples.find((s) => s.runId === detail.id)!
        if (['SO-1', 'SO-2', 'REARRANGED'].includes(value)) {
          expect(
            {
              status: detail.status,
              outcome: detail.outcomeStatus,
              evidence: detail.evidenceStatus,
            },
            JSON.stringify({ value, outcomes: detail.outcomeResults }),
          ).toEqual({ status: 'SUCCEEDED', outcome: 'PASS', evidence: 'COMPLETE' })
          expect(sample.state).toBe('sample_passed')
          passedIds.push(sample.inputDigest!)
        } else {
          expect(sample.state).not.toBe('sample_passed')
          expect(detail.outcomeStatus).not.toBe('PASS')
          if (value !== 'EXPIRED')
            expect(detail.outcomeResults.some((r) => r.verdict === 'FAIL')).toBe(true)
          if (['RUNNING', 'WAITING_FOR_AUTH', 'HOLDING', 'NEEDS_REVIEW'].includes(detail.status))
            await requestRunCancel(handle.db, detail.id, { id: actorId })
        }
      }
      expect(new Set(passedIds).size).toBe(3)
      expect(modelPrompts.every((prompt) => !prompt.includes('<action-type>'))).toBe(true)
      const result = await getScenarioValidation(handle, scenario.id, actorId)
      expect(result.state).not.toBe('sample_passed')
      expect(result.samples.filter((s) => s.state === 'sample_passed')).toHaveLength(3)
    },
  )
})
