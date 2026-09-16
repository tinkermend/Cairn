import {
  ConflictException,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, RUN_ERROR_CODES, runPlacement } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { BrowserService } from './browser.service'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'
import { ObserveService } from './observe.service'
import { listenForSupertest } from '../__tests__/http-app'

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  permissions: ['workflow:read', 'run:read'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

const detail = {
  id: '66666666-6666-4666-8666-666666666666',
  status: 'QUEUED',
  cancelRequested: false,
  targetId: '11111111-1111-4111-8111-111111111111',
  targetAccountId: null,
  scenarioId: '33333333-3333-4333-8333-333333333333',
  scenarioVersionId: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-09-10T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  evidenceStatus: 'PENDING',
  lease: null,
  placement: runPlacement({
    state: 'not_applicable',
    sessionId: null,
    ownerWorkerId: null,
    sessionStatus: null,
  }),
}

const observation = {
  run: detail,
  evidence: { items: [] },
  eventSeq: 1,
  earliestEventSeq: 1,
}

function mockService() {
  return {
    list: vi.fn(async () => ({ items: [detail] })),
    get: vi.fn(async () => detail),
    create: vi.fn(async () => ({ detail, created: true })),
    cancel: vi.fn(async () => ({ ...detail, status: 'CANCELLED' })),
    review: vi.fn(async () => ({ ...detail, status: 'FAILED' })),
    resumeAuth: vi.fn(async () => ({ ...detail, status: 'RECOVERING' })),
    evidence: vi.fn(async (): Promise<{ items: unknown[] }> => ({ items: [] })),
    evidenceContent: vi.fn(),
    previewDelete: vi.fn(async () => ({ previewToken: 'tok', counts: {}, blockers: [] })),
    delete: vi.fn(async () => ({
      resourceId: detail.id,
      resourceType: 'run' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: '2026-09-10T00:00:00.000Z',
    })),
    cleanupStatus: vi.fn(async () => ({
      resourceId: detail.id,
      resourceType: 'run' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: '2026-09-10T00:00:00.000Z',
    })),
    retryCleanup: vi.fn(async () => ({
      resourceId: detail.id,
      resourceType: 'run' as const,
      status: 'completed' as const,
      totalObjects: 0,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 0,
      purgedBytes: 0,
      lastError: null,
      completedAt: '2026-09-10T00:00:00.000Z',
    })),
    mapDecisions: vi.fn(async () => ({ items: [] })),
  }
}

function mockBrowser() {
  return {
    meta: vi.fn(async () => ({ runId: detail.id, framesAvailable: false })),
    streamFrames: vi.fn(async () => undefined),
    acquire: vi.fn(async () => ({ token: 't'.repeat(32) })),
    heartbeat: vi.fn(async () => ({ epoch: 1 })),
    input: vi.fn(async () => ({ status: 'accepted' })),
    release: vi.fn(async () => ({ released: true })),
    resumeAuth: vi.fn(async () => ({ ...detail, status: 'RECOVERING' })),
  }
}

function mockObserve() {
  return {
    observation: vi.fn(async (): Promise<typeof observation | null> => observation),
    stream: vi.fn(async ({ response }: { response: { status: (code: number) => void; setHeader: (k: string, v: string) => void; write: (chunk: string) => void; end: () => void } }) => {
      response.status(200)
      response.setHeader('Content-Type', 'text/event-stream')
      response.write(
        'event: ready\ndata: {"kind":"ready","runId":"66666666-6666-4666-8666-666666666666","eventSeq":1,"earliestEventSeq":1,"realtime":false}\n\n',
      )
      response.end()
    }),
  }
}

async function buildApp(
  account: RequestAccount | null,
  service: ReturnType<typeof mockService>,
  observe: ReturnType<typeof mockObserve> = mockObserve(),
  browser: ReturnType<typeof mockBrowser> = mockBrowser(),
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RunsController],
    providers: [
      Reflector,
      { provide: RunsService, useValue: service },
      { provide: ObserveService, useValue: observe },
      { provide: BrowserService, useValue: browser },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Runs HTTP', () => {
  const service = mockService()
  const browser = mockBrowser()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service, mockObserve(), browser)
    viewerApp = await buildApp(viewer, service, mockObserve(), browser)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    service.create.mockResolvedValue({ detail, created: true })
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('无 run:execute 不能创建', async () => {
    await request(viewerApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('仅有 run:execute、没有 target:read 不能创建', async () => {
    const executeOnly: RequestAccount = { ...admin, id: 'acc-exec', permissions: ['run:execute'] }
    const app = await buildApp(executeOnly, service)
    await request(app.getHttpServer()).post('/runs').send({ scenarioId: detail.scenarioId }).expect(403)
    expect(service.create).not.toHaveBeenCalled()
    await app.close()
  })

  it('执行者具备开跑组合权限可以创建', async () => {
    const operator: RequestAccount = {
      ...admin,
      id: 'acc-operator',
      permissions: ['run:execute', 'target:read', 'workflow:read'],
    }
    const app = await buildApp(operator, service)
    await request(app.getHttpServer()).post('/runs').send({ scenarioId: detail.scenarioId }).expect(201)
    expect(service.create).toHaveBeenCalledOnce()
    await app.close()
  })

  it('无 run:read 不能看详情', async () => {
    const noRead: RequestAccount = { ...viewer, permissions: ['workflow:read'] }
    const app = await buildApp(noRead, service)
    await request(app.getHttpServer()).get(`/runs/${detail.id}`).expect(403)
    await app.close()
  })

  it('创建返回 201，幂等命中返回 200', async () => {
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, idempotencyKey: 'idem-key-ok' })
      .expect(201)
    service.create.mockResolvedValueOnce({ detail, created: false })
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, idempotencyKey: 'idem-key-ok' })
      .expect(200)
  })

  it('input 键 constructor / __proto__ 被拒；请求体禁止 secretRef / password', async () => {
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, input: { constructor: 1 } })
      .expect(400)
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, input: JSON.parse('{"__proto__":1}') })
      .expect(400)
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, secretRef: { provider: 'local', secretId: 'x' } })
      .expect(400)
    await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, password: 'hunter2' })
      .expect(400)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('领域码 RUN_IDEMPOTENCY_CONFLICT / SCENARIO_DISABLED 原样透传', async () => {
    service.create.mockRejectedValueOnce(
      new ConflictException({ code: 'RUN_IDEMPOTENCY_CONFLICT', message: '相同幂等键对应不同的运行输入' }),
    )
    const conflict = await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId, idempotencyKey: 'idem-key-ok' })
    expect(conflict.body.code).toBe('RUN_IDEMPOTENCY_CONFLICT')
    expect(RUN_ERROR_CODES).toContain(conflict.body.code)

    service.create.mockRejectedValueOnce(
      new ConflictException({ code: 'SCENARIO_DISABLED', message: '场景已停用，不能创建新运行' }),
    )
    const disabled = await request(adminApp.getHttpServer())
      .post('/runs')
      .send({ scenarioId: detail.scenarioId })
    expect(disabled.body.code).toBe('SCENARIO_DISABLED')
  })

  it('GET /runs/:id/evidence 返回对象指针、无正文', async () => {
    const item = {
      schemaVersion: 1,
      id: '77777777-7777-4777-8777-777777777777',
      runId: detail.id,
      type: 'log',
      status: 'available',
      createdAt: '2026-09-10T00:00:00.000Z',
      objectKey: `v1/runs/${detail.id}/77777777-7777-4777-8777-777777777778`,
      contentType: 'text/plain',
      byteSize: 12,
      digest: `sha256:${'ab'.repeat(32)}`,
    }
    service.evidence.mockResolvedValueOnce({ items: [item] })
    const res = await request(adminApp.getHttpServer()).get(`/runs/${detail.id}/evidence`).expect(200)
    expect(res.body.items[0]).toMatchObject({
      objectKey: item.objectKey,
      contentType: 'text/plain',
      byteSize: 12,
      digest: item.digest,
    })
    expect(res.body.items[0].payload).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('hello-object')
  })

  it('viewer 能看 placement，信封不出现容量失败码', async () => {
    service.get.mockResolvedValueOnce({
      ...detail,
      placement: runPlacement({
        state: 'session_lost',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ownerWorkerId: 'worker-a',
        sessionStatus: 'LOST',
      }),
    })
    const res = await request(viewerApp.getHttpServer()).get(`/runs/${detail.id}`).expect(200)
    expect(res.body.placement).toMatchObject({
      state: 'session_lost',
      ownerWorkerId: 'worker-a',
    })
    expect(JSON.stringify(res.body)).not.toMatch(/WORKER_CAPACITY_EXCEEDED|SESSION_CAPACITY_EXCEEDED/)
  })

  it('带 run:read 能取回截图正文，且带 nosniff', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    service.evidenceContent.mockResolvedValueOnce({
      body: png,
      contentType: 'image/png',
      byteSize: png.byteLength,
      filename: 'screenshot.png',
    })
    const res = await request(viewerApp.getHttpServer())
      .get(`/runs/${detail.id}/evidence/77777777-7777-4777-8777-777777777777/content`)
      .expect(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-disposition']).toContain('screenshot.png')
    expect(res.body).toEqual(png)
  })

  it('无 run:read 不能下载证据正文', async () => {
    const noRead: RequestAccount = { ...viewer, permissions: ['workflow:read'] }
    const app = await buildApp(noRead, service)
    await request(app.getHttpServer())
      .get(`/runs/${detail.id}/evidence/77777777-7777-4777-8777-777777777777/content`)
      .expect(403)
    expect(service.evidenceContent).not.toHaveBeenCalled()
    await app.close()
  })

  it('跨 Run 的 evidenceId 与不可用证据都是 404，不吐字节', async () => {
    service.evidenceContent.mockRejectedValueOnce(
      new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' }),
    )
    const missing = await request(adminApp.getHttpServer())
      .get(`/runs/${detail.id}/evidence/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content`)
      .expect(404)
    expect(missing.body.code).toBe('EVIDENCE_NOT_FOUND')
    expect(missing.body).not.toHaveProperty('body')

    service.evidenceContent.mockRejectedValueOnce(
      new NotFoundException({ code: 'EVIDENCE_NOT_AVAILABLE', message: '证据不可用：worker_lost' }),
    )
    const unavailable = await request(adminApp.getHttpServer())
      .get(`/runs/${detail.id}/evidence/77777777-7777-4777-8777-777777777777/content`)
      .expect(404)
    expect(unavailable.body.code).toBe('EVIDENCE_NOT_AVAILABLE')
    expect(unavailable.body.message).toContain('worker_lost')
    expect(unavailable.status).not.toBe(500)
  })

  it('无 run:review 不能核查', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/runs/${detail.id}/review`)
      .send({ conclusion: 'fail' })
      .expect(403)
    expect(service.review).not.toHaveBeenCalled()
  })

  it('无 run:execute 不能确认目标系统登录', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/runs/${detail.id}/resume-auth`)
      .send({})
      .expect(403)
    expect(browser.resumeAuth).not.toHaveBeenCalled()
  })

  it('核查与确认目标系统登录走控制面 POST', async () => {
    await request(adminApp.getHttpServer())
      .post(`/runs/${detail.id}/review`)
      .send({ conclusion: 'fail', note: '副作用未确认' })
      .expect(200)
    expect(service.review).toHaveBeenCalledWith(
      detail.id,
      { conclusion: 'fail', note: '副作用未确认' },
      admin,
    )
    await request(adminApp.getHttpServer()).post(`/runs/${detail.id}/resume-auth`).send({}).expect(200)
    expect(browser.resumeAuth).toHaveBeenCalled()
  })

  it('GET observation 与详情同权，返回一致版本', async () => {
    const res = await request(adminApp.getHttpServer()).get(`/runs/${detail.id}/observation`).expect(200)
    expect(res.body).toMatchObject({
      run: { id: detail.id, status: 'QUEUED' },
      eventSeq: 1,
      earliestEventSeq: 1,
    })
    await request(viewerApp.getHttpServer()).get(`/runs/${detail.id}/observation`).expect(200)
  })

  it('无 run:read 不能观察或订阅 SSE', async () => {
    const noRead: RequestAccount = { ...viewer, permissions: ['workflow:read'] }
    const app = await buildApp(noRead, service)
    await request(app.getHttpServer()).get(`/runs/${detail.id}/observation`).expect(403)
    await request(app.getHttpServer()).get(`/runs/${detail.id}/events`).expect(403)
    await app.close()
  })

  it('不存在的 Run 观察与 SSE 都是 404', async () => {
    const observe = mockObserve()
    observe.observation.mockResolvedValueOnce(null)
    const app = await buildApp(admin, service, observe)
    const missing = await request(app.getHttpServer()).get(`/runs/${detail.id}/observation`).expect(404)
    expect(missing.body.code).toBe('RUN_NOT_FOUND')
    observe.observation.mockResolvedValueOnce(null)
    await request(app.getHttpServer()).get(`/runs/${detail.id}/events`).expect(404)
    expect(observe.stream).not.toHaveBeenCalled()
    await app.close()
  })

  it('SSE 使用 Last-Event-ID，不把凭证放进 URL', async () => {
    const observe = mockObserve()
    const app = await buildApp(admin, service, observe)
    const cursor = `${detail.id}:1`
    const res = await request(app.getHttpServer())
      .get(`/runs/${detail.id}/events`)
      .set('Last-Event-ID', cursor)
      .expect(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    expect(observe.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: detail.id,
        lastEventId: cursor,
      }),
    )
    expect(res.request.url).not.toMatch(/token=|access_token=/)
    await app.close()
  })

  it('可读运行地图选择记录，不走轮询协议', async () => {
    await request(adminApp.getHttpServer()).get(`/runs/${detail.id}/map-decisions`).expect(200)
    expect(service.mapDecisions).toHaveBeenCalledWith(detail.id, { limit: 50 })
    await request(adminApp.getHttpServer()).get(`/runs/${detail.id}/map-decisions?cursor=invalid`).expect(400)
    await request(viewerApp.getHttpServer()).get(`/runs/${detail.id}/map-decisions`).expect(403)
  })

  it('删除无对象返回 200，有待清理对象返回 202', async () => {
    const service = mockService()
    const app = await buildApp(admin, service)
    await request(app.getHttpServer()).post(`/runs/${detail.id}/delete`).expect(200)
    service.delete.mockResolvedValueOnce({
      resourceId: detail.id,
      resourceType: 'run',
      status: 'pending',
      totalObjects: 2,
      purgedObjects: 0,
      failedObjects: 0,
      totalBytes: 128,
      purgedBytes: 0,
    })
    const accepted = await request(app.getHttpServer()).post(`/runs/${detail.id}/delete`).expect(202)
    expect(accepted.body.totalObjects).toBe(2)
    await app.close()
  })
})
