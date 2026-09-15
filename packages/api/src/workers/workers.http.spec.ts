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
import { DomainError } from '@cairn/db'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { DB_HANDLE } from '../db/db.module'
import { WorkersController } from './workers.controller'
import { WorkersService } from './workers.service'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    listWorkers: vi.fn(),
    getWorkerDetail: vi.fn(),
  }
})

const { listWorkers, getWorkerDetail } = await import('@cairn/db')

const INSTANCE = '11111111-1111-4111-8111-111111111111'
const AS_OF = '2026-09-14T00:00:00.000Z'

function summary(canSeeEndpoint: boolean) {
  return {
    workerId: 'worker-a',
    instanceId: INSTANCE,
    status: 'READY' as const,
    heartbeatAt: AS_OF,
    lostAfterSeconds: 60,
    heartbeatExpiresAt: '2026-09-14T00:01:00.000Z',
    heartbeatFresh: true,
    capacity: 2,
    maxSessions: 2,
    counts: {
      occupiedSlots: 1,
      lostOccupied: 0,
      executingSlots: 0,
      running: 0,
      holding: 0,
      waitingForAuth: 0,
      leftoverAuthHolds: 0,
      expiredLeaseResidue: 0,
      runCapacityUsed: 0,
    },
    handleSample: {
      liveHandleCount: 1,
      sampledSlotCount: 1,
      handleMismatchStreak: 0,
      handleSampledAt: AS_OF,
      mismatchState: 'none' as const,
    },
    routeAvailability: 'eligible' as const,
    routeReason: null,
    endpointSource: 'database' as const,
    internalEndpoint: canSeeEndpoint
      ? { baseUrl: 'http://127.0.0.1:8091', host: '127.0.0.1', port: 8091, protocol: 'http' as const }
      : null,
  }
}

const admin: RequestAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active',
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' }],
  permissions: [...PERMISSIONS],
}

const author: RequestAccount = {
  ...admin,
  id: 'acc-author',
  permissions: ['session:read', 'run:read'],
}

const operator: RequestAccount = {
  ...admin,
  id: 'acc-operator',
  permissions: ['session:read', 'session:dispose', 'run:read'],
}

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  permissions: ['run:read', 'target:read'],
}

const customDispose: RequestAccount = {
  ...admin,
  id: 'acc-custom',
  roles: [{ id: 'custom', key: 'custom', name: 'Custom', kind: 'custom' }],
  permissions: ['session:read', 'session:dispose'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

async function buildApp(account: RequestAccount | null) {
  const moduleRef = await Test.createTestingModule({
    controllers: [WorkersController],
    providers: [
      Reflector,
      WorkersService,
      { provide: DB_HANDLE, useValue: { driver: 'postgres' } },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Workers HTTP', () => {
  let adminApp: INestApplication
  let authorApp: INestApplication
  let operatorApp: INestApplication
  let customApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(admin)
    authorApp = await buildApp(author)
    operatorApp = await buildApp(operator)
    customApp = await buildApp(customDispose)
  })

  beforeEach(() => {
    vi.mocked(listWorkers).mockImplementation(async (_db, _query, options) => ({
      items: [summary(options.canSeeEndpoint)],
      asOf: AS_OF,
    }))
    vi.mocked(getWorkerDetail).mockImplementation(async (_db, workerId, _query, options) => ({
      worker: { ...summary(options.canSeeEndpoint), workerId },
      sessions: { items: [] },
      asOf: AS_OF,
    }))
  })

  afterAll(async () => {
    await adminApp.close()
    await authorApp.close()
    await operatorApp.close()
    await customApp.close()
  })

  it('viewer 没有 session:read 时直接 GET 拒绝', async () => {
    const app = await buildApp(viewer)
    await request(app.getHttpServer()).get('/workers').expect(403)
    await request(app.getHttpServer()).get('/workers/worker-a').expect(403)
    await app.close()
  })

  it('author 可见节点但不能看到可重建入口的字段', async () => {
    const list = await request(authorApp.getHttpServer()).get('/workers').expect(200)
    expect(list.body.items[0].internalEndpoint).toBeNull()
    expect(JSON.stringify(list.body)).not.toMatch(/127\.0\.0\.1|8091|"host"|"baseUrl"|"protocol"/)
    const detail = await request(authorApp.getHttpServer()).get('/workers/worker-a').expect(200)
    expect(detail.body.worker.internalEndpoint).toBeNull()
    expect(JSON.stringify(detail.body)).not.toMatch(/127\.0\.0\.1|8091|"host"|"baseUrl"|"protocol"/)
  })

  it('运维权限与自定义 read+dispose 角色可见内部入口', async () => {
    const adminList = await request(adminApp.getHttpServer()).get('/workers').expect(200)
    expect(adminList.body.items[0].internalEndpoint).toEqual({
      baseUrl: 'http://127.0.0.1:8091',
      host: '127.0.0.1',
      port: 8091,
      protocol: 'http',
    })
    const operatorDetail = await request(operatorApp.getHttpServer()).get('/workers/worker-a').expect(200)
    expect(operatorDetail.body.worker.internalEndpoint?.baseUrl).toBe('http://127.0.0.1:8091')
    const customList = await request(customApp.getHttpServer()).get('/workers').expect(200)
    expect(customList.body.items[0].internalEndpoint?.host).toBe('127.0.0.1')
  })

  it('节点不存在返回 404；开放服务路径不挂治理路由', async () => {
    vi.mocked(getWorkerDetail).mockRejectedValueOnce(
      new DomainError('not_found', 'WORKER_NOT_FOUND', '执行节点不存在'),
    )
    const missing = await request(adminApp.getHttpServer()).get('/workers/missing').expect(404)
    expect(missing.body.code).toBe('WORKER_NOT_FOUND')
    await request(adminApp.getHttpServer()).get('/open/v1/workers').expect(404)
  })
})
