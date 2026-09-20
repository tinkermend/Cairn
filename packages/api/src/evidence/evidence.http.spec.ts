import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { EvidenceController, EvidenceRetentionController } from './evidence.controller'
import { EvidenceService } from './evidence.service'

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: ['run:read', 'run:delete'],
}

const reader: RequestAccount = {
  ...admin,
  id: 'acc-reader',
  permissions: ['run:read'],
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
    search: vi.fn(async () => ({
      items: [],
      asOf: '2026-09-19T00:00:00.000Z',
      readAt: '2026-09-19T00:00:00.000Z',
      timeWindowLifted: false,
      sort: 'createdAt_desc',
      summary: { evidenceCount: 0, objectCount: 0, knownBytes: 0, unknownByteObjects: 0 },
    })),
    get: vi.fn(async () => ({
      item: { evidence: { id: '11111111-1111-4111-8111-111111111111' } },
      related: { sameAttempt: [], runVideo: null },
    })),
    summary: vi.fn(async () => ({
      asOf: '2026-09-19T00:00:00.000Z',
      readAt: '2026-09-19T00:00:00.000Z',
      canListDeletedRunObjects: false,
    })),
    objects: vi.fn(async () => ({
      items: [],
      asOf: '2026-09-19T00:00:00.000Z',
      readAt: '2026-09-19T00:00:00.000Z',
      view: 'pending_cleanup',
      withheldDeletedRunItems: false,
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [EvidenceController, EvidenceRetentionController],
    providers: [
      Reflector,
      { provide: EvidenceService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Evidence HTTP', () => {
  const service = mockService()
  let app: INestApplication

  beforeAll(async () => {
    app = await buildApp(admin, service)
  })
  afterAll(async () => {
    await app?.close()
  })

  it('拒绝未定义检索参数', async () => {
    for (const query of [{ q: '登录失败' }, { keyword: 'err' }, { search: 'trace' }]) {
      const res = await request(app.getHttpServer()).get('/evidence').query(query).expect(400)
      expect(res.body.code).toBe('BAD_REQUEST')
    }
    expect(service.search).not.toHaveBeenCalled()
  })

  it('接受结构化筛选', async () => {
    await request(app.getHttpServer())
      .get('/evidence')
      .query({ types: 'screenshot,video', runId: '11111111-1111-4111-8111-111111111111' })
      .expect(200)
    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['screenshot', 'video'] }),
      admin.id,
    )
  })

  it('读取单条证据', async () => {
    await request(app.getHttpServer()).get('/evidence/11111111-1111-4111-8111-111111111111').expect(200)
    expect(service.get).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', admin.id)
  })

  it('读取留存汇总与对象清单', async () => {
    await request(app.getHttpServer()).get('/evidence-retention/summary').expect(200)
    await request(app.getHttpServer()).get('/evidence-retention/objects').query({ view: 'pending_cleanup' }).expect(200)
    expect(service.summary).toHaveBeenCalled()
    expect(service.objects).toHaveBeenCalled()
  })
})

describe('Evidence HTTP 权限', () => {
  it('无 run:read 不能列表', async () => {
    const service = mockService()
    const app = await buildApp({ ...reader, permissions: ['monitor:read'] }, service)
    await request(app.getHttpServer()).get('/evidence').expect(403)
    await app.close()
  })

  it('无 run:delete 仍可看汇总，但 deleted_run 清单交给领域层判定', async () => {
    const service = mockService()
    const app = await buildApp(reader, service)
    await request(app.getHttpServer()).get('/evidence-retention/summary').expect(200)
    await request(app.getHttpServer()).get('/evidence-retention/objects').query({ view: 'deleted_run' }).expect(200)
    expect(service.summary).toHaveBeenCalledWith(reader)
    expect(service.objects).toHaveBeenCalledWith(expect.objectContaining({ view: 'deleted_run' }), reader)
    await app.close()
  })
})
