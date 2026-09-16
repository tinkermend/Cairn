import {
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { AccountSessionController, BrowserSessionsController, SessionOperationsController } from './browser-sessions.controller'
import { BrowserSessionsService } from './browser-sessions.service'

const SESSION_ID = '77777777-7777-4777-8777-777777777777'

const session = {
  id: SESSION_ID,
  targetId: '11111111-1111-4111-8111-111111111111',
  targetAccountId: '22222222-2222-4222-8222-222222222222',
  status: 'LOST',
  health: 'UNKNOWN',
  authState: 'UNKNOWN',
  ownerWorkerId: 'local-worker',
  ownerWorkerInstanceId: null,
  generation: 1,
  reusePolicy: 'NEW_PAGE',
  profileKey: '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
  idleTtlSeconds: 600,
  lastUsedAt: '2026-09-11T00:00:00.000Z',
  expiresAt: '2026-09-11T04:00:00.000Z',
  authHold: null,
  closeReason: 'owner_lost',
  createdAt: '2026-09-11T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
  activeLease: null,
  disposable: true,
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
  permissions: ['session:read', 'run:read'],
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
    list: vi.fn(async () => ({ items: [session] })),
    overview: vi.fn(async () => ({
      items: [],
      summary: {
        total: 0,
        available: 0,
        needsCheck: 0,
        needsLogin: 0,
        identityMismatch: 0,
        maintenance: 0,
        executing: 0,
        lost: 0,
        unprepared: 0,
        retained: 0,
      },
      asOf: '2026-09-16T00:00:00.000Z',
    })),
    requestAccountOperation: vi.fn(async () => ({
      operationId: '88888888-8888-4888-8888-888888888888',
      reusedRunId: null,
      created: true,
    })),
    dispose: vi.fn(async () => ({ ...session, status: 'CLOSED', closeReason: 'operator_disposed', disposable: false })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [BrowserSessionsController, AccountSessionController, SessionOperationsController],
    providers: [
      Reflector,
      { provide: BrowserSessionsService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('BrowserSessions HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin, service)
    viewerApp = await buildApp(viewer, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
  })

  it('list 需要 session:read', async () => {
    const noRead: RequestAccount = { ...viewer, permissions: ['run:read'] }
    const app = await buildApp(noRead, service)
    await request(app.getHttpServer()).get('/browser-sessions').expect(403)
    await app.close()

    await request(viewerApp.getHttpServer()).get('/browser-sessions').expect(200)
    expect(service.list).toHaveBeenCalledWith({})
  })

  it('非法会话、操作及账号 ID 在访问存储前返回 400', async () => {
    for (const path of ['/browser-sessions/undefined', '/session-operations/not-a-uuid', `/targets/${session.targetId}/accounts/bad/session`]) {
      await request(adminApp.getHttpServer()).get(path).expect(400)
    }
    await request(adminApp.getHttpServer()).post('/browser-sessions/bad/dispose').send({}).expect(400)
    expect(service.dispose).not.toHaveBeenCalled()
  })

  it('列表可按 ownerWorkerId 筛选且信封不变', async () => {
    await request(viewerApp.getHttpServer())
      .get('/browser-sessions')
      .query({ ownerWorkerId: 'local-worker' })
      .expect(200)
    expect(service.list).toHaveBeenCalledWith({ ownerWorkerId: 'local-worker' })
  })

  it('处置需要 session:dispose，viewer 只有 read 时被拒', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/browser-sessions/${SESSION_ID}/dispose`)
      .send({})
      .expect(403)
    expect(service.dispose).not.toHaveBeenCalled()
  })

  it('处置返回 200 与会话现状', async () => {
    const res = await request(adminApp.getHttpServer())
      .post(`/browser-sessions/${SESSION_ID}/dispose`)
      .send({ note: '已确认旧进程退出' })
      .expect(200)
    expect(res.body.status).toBe('CLOSED')
    expect(service.dispose).toHaveBeenCalledWith(
      SESSION_ID,
      { note: '已确认旧进程退出' },
      expect.objectContaining({ id: 'acc-admin' }),
    )
  })

  it('无 note 也接受；未知字段与超长 note 被拒', async () => {
    await request(adminApp.getHttpServer())
      .post(`/browser-sessions/${SESSION_ID}/dispose`)
      .send({})
      .expect(200)
    await request(adminApp.getHttpServer())
      .post(`/browser-sessions/${SESSION_ID}/dispose`)
      .send({ force: true })
      .expect(400)
    await request(adminApp.getHttpServer())
      .post(`/browser-sessions/${SESSION_ID}/dispose`)
      .send({ note: 'x'.repeat(513) })
      .expect(400)
  })

  it('overview 在 :sessionId 之前且只需要 session:read', async () => {
    await request(viewerApp.getHttpServer()).get('/browser-sessions/overview').expect(200)
    expect(service.overview).toHaveBeenCalled()
  })

  it('关闭会话需要 session:manage', async () => {
    const operator: RequestAccount = {
      ...admin,
      id: 'acc-op',
      permissions: ['session:read', 'session:control', 'session:manage'],
    }
    const author: RequestAccount = {
      ...admin,
      id: 'acc-author',
      permissions: ['session:read', 'session:control'],
    }
    const opApp = await buildApp(operator, service)
    const authorApp = await buildApp(author, service)
    const targetId = '11111111-1111-4111-8111-111111111111'
    const accountId = '22222222-2222-4222-8222-222222222222'
    await request(authorApp.getHttpServer())
      .post(`/targets/${targetId}/accounts/${accountId}/session/operations`)
      .send({ kind: 'CLOSE', idempotencyKey: 'close-account-xxxxxxxx' })
      .expect(403)
    await request(opApp.getHttpServer())
      .post(`/targets/${targetId}/accounts/${accountId}/session/operations`)
      .send({ kind: 'CLOSE', idempotencyKey: 'close-account-xxxxxxxx' })
      .expect(202)
    expect(service.requestAccountOperation).toHaveBeenCalled()
    await opApp.close()
    await authorApp.close()
  })

  it('未认证被拒', async () => {
    const app = await buildApp(null, service)
    await request(app.getHttpServer()).get('/browser-sessions').expect(401)
    await app.close()
  })
})
