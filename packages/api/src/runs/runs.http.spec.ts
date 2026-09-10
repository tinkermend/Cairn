import {
  ConflictException,
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS, RUN_ERROR_CODES } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'

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
}

function mockService() {
  return {
    list: vi.fn(async () => ({ items: [detail] })),
    get: vi.fn(async () => detail),
    create: vi.fn(async () => ({ detail, created: true })),
    cancel: vi.fn(async () => ({ ...detail, status: 'CANCELLED' })),
    evidence: vi.fn(async () => ({ items: [] })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RunsController],
    providers: [
      Reflector,
      { provide: RunsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return app
}

describe('Runs HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
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
})
