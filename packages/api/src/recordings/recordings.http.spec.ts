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
import { PERMISSIONS, RECORDER_SOURCE_VERSION } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { RecordingBindingsController, RecordingsController } from './recordings.controller'
import { RecordingsService } from './recordings.service'
import { listenForSupertest } from '../__tests__/http-app'

const now = '2026-09-13T00:00:00.000Z'
const draft = {
  id: '66666666-6666-4666-8666-666666666666',
  targetId: '11111111-1111-4111-8111-111111111111',
  targetName: '演示商城',
  name: '录制 shop.example',
  recordingId: '22222222-2222-4222-8222-222222222222',
  sourceVersion: RECORDER_SOURCE_VERSION,
  eventCount: 1,
  itemCount: 1,
  unresolvedCount: 0,
  createdBy: { id: 'acc-admin', displayName: 'Admin' },
  createdAt: now,
  updatedAt: now,
  items: [],
  diagnostics: [],
  events: [],
}

const body = {
  targetId: draft.targetId,
  recordingId: draft.recordingId,
  sourceVersion: RECORDER_SOURCE_VERSION,
  idempotencyKey: 'rec-0001-key',
  events: [
    {
      name: 'navigate',
      url: 'https://shop.example/login',
      signals: [],
      pageAlias: 'page',
      framePath: [],
    },
  ],
}

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
  permissions: ['workflow:read', 'target:read'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function mockService() {
  return {
    open: vi.fn(async () => ({ binding: null })),
    claim: vi.fn(async () => draft),
    close: vi.fn(async () => draft),
    list: vi.fn(async () => ({ items: [draft] })),
    get: vi.fn(async () => draft),
    create: vi.fn(async () => draft),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RecordingsController, RecordingBindingsController],
    providers: [
      Reflector,
      { provide: RecordingsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Recordings HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
  })

  beforeEach(() => vi.clearAllMocks())

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('无 workflow:write 不能上传', async () => {
    await request(viewerApp.getHttpServer()).post('/recordings').send(body).expect(403)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('无 workflow:write 不能读列表和详情', async () => {
    await request(viewerApp.getHttpServer()).get('/recordings').expect(403)
    await request(viewerApp.getHttpServer()).get(`/recordings/${draft.id}`).expect(403)
    expect(service.list).not.toHaveBeenCalled()
    expect(service.get).not.toHaveBeenCalled()
  })

  it('创建返回 201，领域码原样透传', async () => {
    await request(adminApp.getHttpServer()).post('/recordings').send(body).expect(201)
    service.create.mockRejectedValueOnce(
      new ConflictException({ code: 'RECORDING_IDEMPOTENCY_CONFLICT', message: '相同幂等键对应不同的录制内容' }),
    )
    const conflicted = await request(adminApp.getHttpServer()).post('/recordings').send(body)
    expect(conflicted.body.code).toBe('RECORDING_IDEMPOTENCY_CONFLICT')
  })

  it('无 target:read 不能领取绑定', async () => {
    const writer = { ...admin, permissions: ['workflow:write'] }
    const app = await buildApp(writer, service)
    await request(app.getHttpServer())
      .post('/recording-bindings/claim')
      .send({
        ticket: 'a'.repeat(64),
        apiOrigin: 'http://localhost:3030',
      })
      .expect(403)
    expect(service.claim).not.toHaveBeenCalled()
    await request(app.getHttpServer()).get('/recording-bindings/open').expect(403)
    expect(service.open).not.toHaveBeenCalled()
    await app.close()
  })

  it('打开中的绑定返回 { binding }', async () => {
    await request(adminApp.getHttpServer()).get('/recording-bindings/open').expect(200, { binding: null })
    expect(service.open).toHaveBeenCalled()
  })

  it('不能把 steps 当录制体', async () => {
    await request(adminApp.getHttpServer())
      .post('/recordings')
      .send({ ...body, steps: [{ type: 'navigate', url: 'https://example.com' }] })
      .expect(400)
    expect(service.create).not.toHaveBeenCalled()
  })
})
