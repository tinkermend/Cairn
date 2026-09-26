import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest } from '../__tests__/http-app'
import { SchedulesController } from './schedules.controller'
import { SchedulesService } from './schedules.service'

const scheduleId = '11111111-1111-4111-8111-111111111111'
const targetId = '22222222-2222-4222-8222-222222222222'
const accountId = '33333333-3333-4333-8333-333333333333'

const definition = {
  timezone: 'Asia/Shanghai',
  weekdays: [1, 2, 3, 4, 5],
  windowStart: '02:00',
  windowEnd: '03:00',
  misfire: 'skip' as const,
  consumer: {
    type: 'knowledge_analysis' as const,
    targetId,
    mode: 'map_quality' as const,
  },
}

const schedule = {
  scheduleId,
  targetId,
  targetAccountId: accountId,
  consumerKey: 'knowledge_analysis',
  enabled: false,
  revision: 1,
  currentVersionId: '55555555-5555-4555-8555-555555555555',
  definition,
  nextDueAt: '2026-09-17T18:00:00.000Z',
  lastOccurrence: null,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
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
  permissions: ['schedule:read'],
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
    list: vi.fn(async () => ({ items: [schedule] })),
    get: vi.fn(async () => schedule),
    create: vi.fn(async () => ({ schedule, created: true })),
    update: vi.fn(async () => ({ schedule, created: false })),
    enabled: vi.fn(async () => ({ ...schedule, enabled: true, revision: 2 })),
    preview: vi.fn(async () => ({
      asOf: '2026-09-16T00:00:00.000Z',
      windows: [],
      gaps: [{ code: 'FACTORY_DISABLED', message: '平台尚未开放自动复查' }],
    })),
    occurrences: vi.fn(async () => ({ items: [] })),
    events: vi.fn(async () => ({ items: [] })),
    trigger: vi.fn(async () => ({
      occurrence: {
        occurrenceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        scheduleId,
        scheduleVersionId: schedule.currentVersionId,
        source: 'manual',
        localSlotKey: 'manual',
        occurrenceKey: 'manual:key',
        localStartDate: '2026-09-20',
        windowStartUtc: '2026-09-20T00:00:00.000Z',
        windowEndUtc: '2026-09-20T01:00:00.000Z',
        startOffsetMinutes: 0,
        endOffsetMinutes: 0,
        timeRuleVersion: 'schedule-time@1',
        admissionStatus: 'PENDING',
        reason: null,
        jobId: null,
        createdAt: '2026-09-20T00:00:00.000Z',
        admittedAt: null,
      },
    })),
    previewQuery: vi.fn(async () => ({
      asOf: '2026-09-16T00:00:00.000Z',
      windows: [],
      gaps: [],
    })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SchedulesController],
    providers: [
      Reflector,
      { provide: SchedulesService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('Schedules HTTP', () => {
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

  it('列表需要 schedule:read，写只要求 schedule:write', async () => {
    const noRead: RequestAccount = { ...viewer, permissions: ['map:read'] }
    const readApp = await buildApp(noRead, service)
    await request(readApp.getHttpServer()).get('/schedules').expect(403)
    await readApp.close()

    await request(viewerApp.getHttpServer()).get('/schedules').expect(200)
    expect(service.list).toHaveBeenCalled()

    await request(viewerApp.getHttpServer())
      .post('/schedules')
      .send({ expectedRevision: 0, idempotencyKey: 'create-01', definition })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()

    const writer: RequestAccount = { ...viewer, permissions: ['schedule:read', 'schedule:write'] }
    const writeApp = await buildApp(writer, service)
    await request(writeApp.getHttpServer())
      .post('/schedules')
      .send({ expectedRevision: 0, idempotencyKey: 'create-01', definition })
      .expect(200)
    expect(service.create).toHaveBeenCalled()
    await writeApp.close()
  })

  it('预览只读且不访问目标；事件是 cursor GET 不是 SSE', async () => {
    await request(viewerApp.getHttpServer()).post('/schedules/preview').send({ definition }).expect(200)
    expect(service.preview).toHaveBeenCalled()

    await request(viewerApp.getHttpServer())
      .get('/schedules/preview')
      .query({ kind: 'calendar', timezone: 'Asia/Shanghai', windowStart: '02:00', windowEnd: '03:00' })
      .expect(200)
    expect(service.previewQuery).toHaveBeenCalled()

    const events = await request(viewerApp.getHttpServer()).get(`/schedules/${scheduleId}/events`).expect(200)
    expect(events.headers['content-type']).toMatch(/application\/json/)
    expect(events.headers['content-type']).not.toMatch(/text\/event-stream/)
    expect(service.events).toHaveBeenCalledWith(scheduleId, expect.objectContaining({ limit: 50 }))
  })

  it('管理员可创建、修订、启停并读取窗口', async () => {
    await request(adminApp.getHttpServer())
      .post('/schedules')
      .send({ expectedRevision: 0, idempotencyKey: 'create-01', definition })
      .expect(200)
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        idempotencyKey: 'create-01',
        definition: expect.objectContaining({ timezone: 'Asia/Shanghai', windowStart: '02:00' }),
      }),
      admin,
    )

    await request(adminApp.getHttpServer())
      .post(`/schedules/${scheduleId}`)
      .send({ expectedRevision: 1, idempotencyKey: 'update-01', definition })
      .expect(200)
    expect(service.update).toHaveBeenCalledWith(
      scheduleId,
      expect.objectContaining({ expectedRevision: 1 }),
      admin,
    )

    await request(adminApp.getHttpServer())
      .post(`/schedules/${scheduleId}/enabled`)
      .send({ expectedRevision: 1, idempotencyKey: 'enable-01', enabled: true })
      .expect(200)
    expect(service.enabled).toHaveBeenCalledWith(
      scheduleId,
      expect.objectContaining({ enabled: true }),
      admin,
    )

    await request(adminApp.getHttpServer()).get(`/schedules/${scheduleId}/occurrences`).expect(200)
    expect(service.occurrences).toHaveBeenCalled()

    await request(adminApp.getHttpServer())
      .post(`/schedules/${scheduleId}/trigger`)
      .send({ idempotencyKey: 'manual-01' })
      .expect(200)
    expect(service.trigger).toHaveBeenCalledWith(scheduleId, expect.objectContaining({ idempotencyKey: 'manual-01' }), admin)
  })
})
