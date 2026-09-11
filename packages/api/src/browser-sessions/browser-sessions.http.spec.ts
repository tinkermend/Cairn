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
import { BrowserSessionsController } from './browser-sessions.controller'
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
    dispose: vi.fn(async () => ({ ...session, status: 'CLOSED', closeReason: 'operator_disposed', disposable: false })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [BrowserSessionsController],
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
    expect(service.list).toHaveBeenCalled()
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

  it('未认证被拒', async () => {
    const app = await buildApp(null, service)
    await request(app.getHttpServer()).get('/browser-sessions').expect(401)
    await app.close()
  })
})
