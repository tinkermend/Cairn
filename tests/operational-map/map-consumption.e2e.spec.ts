/** Real HTTP → database → Engine → managed Chromium → durable result/decision/evidence.
 * Only identity injection and unused SSE/control services are fixtures; business ports are real.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Test } from '@nestjs/testing'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import type { INestApplication, ExecutionContext } from '@nestjs/common'
import request from 'supertest'
import {
  newId, openIsolatedDb, consoleAccounts, targets, targetAccounts, secrets,
  createScenarioWithVersion, claimRun, registerWorker, getRun, listRunEvidence, type DbHandle,
  readMapFacts,
} from '@cairn/db/testing'
import {
  commitMapProjectionBatch, ensureMapProjection, loadMapProjectionState, listMapAssets,
  sealAndPublishMapRelease, grantMapConsumptionEligibility, upsertMapScenarioBinding,
} from '@cairn/db'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { DEV_CREDENTIAL_KEY, SESSION_OCCUPANCY_PROTOCOL, MAP_ASSETS_PROTOCOL, MAP_IDENTITY_RULE_VERSION, MAP_CONSUMPTION_PROTOCOL,
  PERMISSIONS, mapListQuerySchema, type MapProjectionPlan, type MapConditionSnapshot,
  type Step, type TargetDescriptor,
} from '@cairn/shared'
import type { BrowserSessionManager as SessionManager } from '../../packages/worker/dist/browser/session-manager.js'
import { DB_HANDLE } from '../../packages/api/src/db/db.module'
import { MapController } from '../../packages/api/src/map/map.controller'
import { MapService } from '../../packages/api/src/map/map.service'
import { RunsController } from '../../packages/api/src/runs/runs.controller'
import { RunsService } from '../../packages/api/src/runs/runs.service'
import { ObserveService } from '../../packages/api/src/runs/observe.service'
import { BrowserService } from '../../packages/api/src/runs/browser.service'
import { PermissionsGuard } from '../../packages/api/src/rbac/permissions.guard'
import { AllExceptionsFilter } from '../../packages/api/src/common/all-exceptions.filter'
import { listenForSupertest } from '../../packages/api/src/__tests__/http-app'

function emptyPlan(nextCursor: number, overrides: Partial<MapProjectionPlan> = {}): MapProjectionPlan {
  return {
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    pages: [],
    objects: [],
    assignments: [],
    implementations: [],
    descriptors: [],
    assets: [],
    conflicts: [],
    nextCursor,
    ...overrides,
  }
}


describe('OM-F HTTP × Worker × Chromium end to end', { timeout: 60_000 }, () => {
  let handle: DbHandle
  let app: INestApplication
  let manager: SessionManager
  let BrowserSessionManager: typeof import('../../packages/worker/dist/browser/session-manager.js').BrowserSessionManager
  let createBrowserPort: typeof import('../../packages/worker/dist/browser/port.js').createBrowserPort
  let createPassiveMapObservationPort: typeof import('../../packages/worker/src/browser/map-observer.js').createPassiveMapObservationPort
  let ExecutionEngine: typeof import('../../packages/worker/dist/engine/engine.js').ExecutionEngine
  let server: ReturnType<typeof createServer>
  let baseUrl = ''
  let html = ''
  let profileRoot = ''
  let actorId: string
  let accountId: string
  const workerId = `omf-e2e-${newId()}`
  const workerInstanceId = newId()
  const secretProvider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
  let candidateDescriptor: TargetDescriptor
  function actor() { return { kind: 'console' as const, id: actorId } }
  function condition(targetId: string): MapConditionSnapshot {
    return { targetId, accountBinding: { presence: 'known', targetAccountId: accountId },
      unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'] }
  }
  beforeAll(async () => {
    // Transform both applications through Vitest so their opaque DB-handle registry
    // is shared. Loading worker CommonJS dist alongside API ESM creates two registries.
    const workerSource = resolve(__dirname, '../../packages/worker/src')
    ;({ BrowserSessionManager } = await import(`${workerSource}/browser/session-manager.ts`))
    ;({ createBrowserPort } = await import(`${workerSource}/browser/port.ts`))
    ;({ createPassiveMapObservationPort } = await import(`${workerSource}/browser/map-observer.ts`))
    ;({ ExecutionEngine } = await import(`${workerSource}/engine/engine.ts`))
    handle = await openIsolatedDb(`omf_e2e_${Date.now().toString(36)}`)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: 'OMF E2E', email: `${actorId}@example.com`, status: 'active' })
    server = createServer((req, res) => {
      if (req.url === '/login' && req.method === 'POST') { req.resume(); res.writeHead(302, { Location: '/orders', 'Set-Cookie': 'omf=ok; Path=/' }); res.end(); return }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(req.url === '/login' ? '<form method="POST" action="/login"><input name="username"><input name="password" type="password"><button type="submit">Login</button></form>' : html)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('port')
    baseUrl = `http://127.0.0.1:${addr.port}`
    await registerWorker(handle.db, { workerId, instanceId: workerInstanceId, capacity: 10, maxSessions: 16,
      lostAfterSeconds: 3600, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, MAP_CONSUMPTION_PROTOCOL] })
    profileRoot = mkdtempSync(join(tmpdir(), 'cairn-omf-e2e-'))
    manager = new BrowserSessionManager(handle, { workerId, workerInstanceId, profileRoot, headless: true,
      maxSessions: 16, defaultLeaseTtlSeconds: 120, defaultAuthWaitSeconds: 60, heartbeatMs: 5000 }, secretProvider)
    const module = await Test.createTestingModule({ controllers: [MapController, RunsController], providers: [
      MapService, RunsService, { provide: DB_HANDLE, useValue: handle },
      { provide: ObserveService, useValue: {} }, { provide: BrowserService, useValue: {} },
      { provide: APP_GUARD, useValue: { canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().account = { ...actor(), displayName: 'OMF E2E', status: 'active', roles: [], permissions: [...PERMISSIONS] }
        return true
      } } },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new PermissionsGuard(reflector), inject: [Reflector] },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ] }).compile()
    app = module.createNestApplication()
    await listenForSupertest(app)
  })
  afterAll(async () => {
    await app?.close()
    await manager?.shutdown()
    await handle?.close()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true })
  })
  async function seedAndPublish(targetId: string) {
    const projection = await ensureMapProjection(handle, targetId)
    const state = await loadMapProjectionState(handle, projection.id)
    const pageKey = `page:v1:top:omf:top`
    const objectKey = `object:v1:omf-title`
    const implKey = `impl:v1:omf`
    await commitMapProjectionBatch(handle, {
      projectionId: projection.id,
      expectedCursor: state.cursor,
      expectedRevision: state.revision,
      plan: emptyPlan(state.cursor + 1, {
        pages: [
          {
            kind: 'top',
            allocationKey: pageKey,
            routeTemplate: `${baseUrl}/orders`,
            frameKey: 'top',
            reasons: ['allocation-key'],
            matchResult: 'MATCH',
          },
        ],
        objects: [
          {
            allocationKey: objectKey,
            pageAllocationKey: pageKey,
            regionKey: 'action',
            stableToken: 'title',
            reasons: ['allocation-key'],
            matchResult: 'MATCH',
          },
        ],
        implementations: [{ objectAllocationKey: objectKey, implementationKey: implKey, condition: condition(targetId) }],
        descriptors: [
          {
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            features: {
              semanticName: '订单标题',
              locators: candidateDescriptor,
            },
            condition: condition(targetId),
          },
        ],
        assets: [
          {
            pageAllocationKey: pageKey,
            objectAllocationKey: objectKey,
            implementationKey: implKey,
            lifecycle: 'VERIFIED',
            importance: 0,
            executable: true,
            rejectReasons: [],
            dimensions: [
              { dimension: 'locator', verdict: 'confirmed', confirmedCount: 1, rejectedCount: 0, unknownCount: 0 },
            ],
            sampleCount: 1,
            changeCount: 1,
          },
        ],
      }),
    })
    const listed = await listMapAssets(handle, targetId, 'objects', mapListQuerySchema.parse({}))
    const item = listed.items[0]
    if (!item) throw new Error('没有对象')
    const ready = await loadMapProjectionState(handle, projection.id)
    const published = await sealAndPublishMapRelease(
      handle,
      targetId,
      {
        projectionId: projection.id,
        expectedProjectionRevision: ready.revision,
        expectedPublicationRevision: 0,
        idempotencyKey: `cmd:omf-pub-${targetId}`.slice(0, 192),
        reason: '发布消费夹具',
      },
      actor(),
    )
    return { item, published }
  }


  async function prepare(mode: 'off' | 'shadow' | 'read_only_fallback', options: {
    baseline?: string; anchor?: TargetDescriptor['anchor']; assert?: boolean; candidate?: TargetDescriptor;
  } = {}) {
    const targetId = newId()
    accountId = newId()
    candidateDescriptor = options.candidate ?? { framePath: [], candidates: [{ by: 'css', value: '.new' }] }
    await handle.db.insert(targets).values({ id: targetId, code: `omf-${targetId}`, name: 'OMF controlled fixture', entryUrl: baseUrl, loginUrl: `${baseUrl}/login`, authMethod: 'password', captchaMode: 'none', loginFields: { username: { by: 'name', value: 'username' }, password: { by: 'name', value: 'password' }, submit: { by: 'css', value: 'button[type=submit]' } } })
    const secretId = newId()
    await handle.db.insert(secrets).values({ id: secretId, provider: 'local', ciphertext: secretProvider.encrypt(secretId, 'omf-fixture') })
    await handle.db.insert(targetAccounts).values({ secretId, secretProvider: 'local', id: accountId, targetId, displayName: 'fixture', username: 'fixture', status: 'active' })
    const { item, published } = await seedAndPublish(targetId)
    if (mode === 'read_only_fallback') await grantMapConsumptionEligibility(handle, { targetId, reportId: `fixture:${newId()}` })
    await request(app.getHttpServer()).post(`/targets/${targetId}/map/consumption-policy`).send({
      expectedRevision: 0, idempotencyKey: `policy:${newId()}`, mode, reason: 'controlled E2E only', maxResolveMs: 3000,
    }).expect(200)
    const target = { framePath: [], candidates: [{ by: 'css' as const, value: options.baseline ?? '.old' }], ...(options.anchor ? { anchor: options.anchor } : {}) }
    const read: Step = options.assert ? { id: newId(), name: '验证指定订单', type: 'assert', effectType: 'READ_ONLY', policy: { timeoutMs: 20_000 },
      input: { target, expect: { kind: 'text_equals', value: 'paid' } } } :
      { id: newId(), name: '读取指定订单', type: 'extract', effectType: 'READ_ONLY', policy: { timeoutMs: 20_000 }, outputKey: 'value', input: { target, as: 'text' } }
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name: `OMF-${newId()}`, actor: { id: actorId }, steps: [
      { id: newId(), name: '进入受控页', type: 'navigate', effectType: 'IDEMPOTENT', input: { url: baseUrl } }, read,
    ] })
    await upsertMapScenarioBinding(handle, targetId, { scenarioId: scenario.id, scenarioVersionId: scenario.latestVersionId,
      stepId: read.id, expectedDraftRevision: scenario.draft!.revision, assetRef: item.assetRef,
      scopeKind: 'version', basis: 'explicit_user' }, actor())
    const response = await request(app.getHttpServer()).post('/runs').send({
      scenarioId: scenario.id, targetAccountId: accountId, mapCapturePolicy: { enabled: true },
    }).expect(201)
    expect(response.body.snapshot.mapConsumption.mode).toBe(mode)
    if (mode !== 'off') {
      expect(response.body.snapshot.mapConsumption.releaseId).toBe(published.release.releaseId)
      expect(response.body.snapshot.mapConsumption.bindings).toHaveLength(1)
    }
    return { runId: response.body.id as string, targetId }
  }
  async function execute(runId: string, options: { replaceAfterLocate?: boolean; cancelAfterLocate?: boolean } = {}) {
    const grant = await claimRun(handle, { workerId, instanceId: workerInstanceId, leaseTtlSeconds: 120 })
    expect(grant?.runId).toBe(runId)
    const port = createBrowserPort(manager)
    const engine = new ExecutionEngine(handle, { ...port, async execute(session, command, signal, evidence) {
      if ((command.type === 'extract' || command.type === 'assert') && command.expectedTargetToken) {
        const recorded = await request(app.getHttpServer()).get(`/runs/${runId}/map-decisions`).expect(200)
        expect(recorded.body.items.some((item: { decision: string }) => item.decision === 'selected')).toBe(true)
      }
      const result = await port.execute(session, command, signal, evidence)
      if (command.type === 'locate' && result.ok) {
        if (options.replaceAfterLocate) await manager.withManagedPage(session, undefined, page => page.setContent('<h1 class="new">wrong replacement</h1>'))
        if (options.cancelAfterLocate) await request(app.getHttpServer()).post(`/runs/${runId}/cancel`).expect(200)
      }
      return result
    } }, undefined, undefined, undefined, createPassiveMapObservationPort(manager))
    await engine.execute(runId, { grant: grant! })
    const detail = await getRun(handle.db, runId)
    const response = await request(app.getHttpServer()).get(`/runs/${runId}/map-decisions`).expect(200)
    const evidence = await listRunEvidence(handle.db, runId)
    expect(evidence.items.length).toBeGreaterThan(0)
    return { detail, decisions: response.body.items as import('@cairn/shared').MapSelectionDecision[] }
  }
  it('off 保持原结果且没有地图决策', async () => {
    html = '<h1 class="old">original</h1><h1 class="new">wrong</h1>'
    const { runId } = await prepare('off')
    const { detail, decisions } = await execute(runId)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.value).toBe('original')
    expect(decisions).toHaveLength(0)
  })
  it('原定位成功，地图中另一个对象不能取代它', async () => {
    html = '<h1 class="old">original</h1><h1 class="new">wrong</h1>'
    const { runId } = await prepare('read_only_fallback')
    const { detail, decisions } = await execute(runId)
    expect(detail.context.value).toBe('original')
    expect(decisions.at(-1)?.reasonCode).toBe('BASELINE_FOUND')
  })
  it('shadow 记录可用候选，但保留 TARGET_NOT_FOUND', async () => {
    html = '<h1 class="new">renamed</h1>'
    const { runId } = await prepare('shadow')
    const { detail, decisions } = await execute(runId)
    expect(detail.status).toBe('FAILED')
    expect(decisions.at(-1)?.decision).toBe('shadow_only')
    expect(detail.context.value).toBeUndefined()
  })
  it('fallback 先落决策，再提取改名对象并保存原输出契约', async () => {
    html = '<h1 class="new">renamed</h1>'
    const { runId, targetId } = await prepare('read_only_fallback')
    const { detail, decisions } = await execute(runId)
    expect(detail.status).toBe('SUCCEEDED')
    expect(detail.context.value).toBe('renamed')
    expect(decisions.at(-1)).toMatchObject({ decision: 'selected', extraAiCalls: 0, baselineOutcome: 'TARGET_NOT_FOUND' })
    expect(decisions.at(-1)?.selectedDescriptorDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(decisions.at(-1)?.conditionSnapshot?.locale).toBeTruthy()
    expect(decisions.at(-1)?.conditionSnapshot?.viewport?.widthPx).toBeGreaterThan(0)
    expect(decisions.at(-1)?.conditionSnapshot?.unknownFields).not.toContain('locale')
    expect(decisions.at(-1)?.conditionSnapshot?.unknownFields).not.toContain('viewport')
    expect(detail.stepRuns.at(-1)?.attempts).toHaveLength(1)
    const facts = await readMapFacts(handle.db, { targetId })
    expect(facts.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'verification', verification: expect.objectContaining({ dimension: 'locator', verdict: 'confirmed' }) }),
      expect.objectContaining({ type: 'verification', verification: expect.objectContaining({ dimension: 'business', verdict: 'not_observed' }) }),
    ]))
  })
  it('保留行 anchor，不能用别的已付款订单使原断言假通过', async () => {
    html = '<ul><li>order-A <span class="new">unpaid</span></li><li>order-B <span class="new">paid</span></li></ul>'
    const { runId } = await prepare('read_only_fallback', { assert: true, anchor: { scope: 'row', withinText: 'order-A' } })
    const { detail, decisions } = await execute(runId)
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns.at(-1)?.attempts[0]?.error?.code).toBe('ASSERT_FAILED')
    expect(decisions.at(-1)?.decision).toBe('selected')
  })
  it('多个同名节点拒绝回退', async () => {
    html = '<h1 class="new">one</h1><h1 class="new">two</h1>'
    const { runId } = await prepare('read_only_fallback')
    const { detail, decisions } = await execute(runId)
    expect(detail.status).toBe('FAILED')
    expect(decisions.at(-1)?.decision).toBe('skipped')
    expect(detail.context.value).toBeUndefined()
  })
  it('选定前后页面节点被替换，整条运行失败且不读取替换对象', async () => {
    html = '<h1 class="new">original node</h1>'
    const { runId } = await prepare('read_only_fallback')
    const { detail, decisions } = await execute(runId, { replaceAfterLocate: true })
    expect(detail.status).toBe('FAILED')
    expect(detail.context.value).toBeUndefined()
    expect(detail.stepRuns.at(-1)?.attempts[0]?.error?.code).toBe('SURFACE_LOST')
    expect(decisions.at(-1)?.decision).toBe('selected')
  })
  it('通过 API 取消运行后，决策写入围栏阻止候选读取', async () => {
    html = '<h1 class="new">must not read</h1>'
    const { runId } = await prepare('read_only_fallback')
    const { detail, decisions } = await execute(runId, { cancelAfterLocate: true })
    expect(detail.status).toBe('CANCELLED')
    expect(detail.context.value).toBeUndefined()
    expect(decisions.some(item => item.decision === 'selected')).toBe(false)
  })

})
