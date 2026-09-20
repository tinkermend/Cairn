import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { DB_HANDLE } from '../db/db.module'
import { OverviewController } from './overview.controller'
import { OverviewService } from './overview.service'

const mockOverviewResponse = {
  asOf: '2026-09-20T00:00:00.000Z',
  range: '7d',
  summary: {
    totalRuns: 50,
    succeededRuns: 48,
    failedRuns: 2,
    timedOutRuns: 0,
    canceledRuns: 0,
    runningRuns: 0,
    pendingRuns: 0,
    successRate: 0.96,
    avgDurationMs: 8000,
    p95DurationMs: 15000,
    runsDeltaPercentage: 10.0,
    successRateDeltaPercentage: 1.5,
  },
  timeline: [],
  outcomes: {
    passed: 45,
    violation: 3,
    failed: 2,
    notEvaluated: 0,
  },
  triggers: {
    manual: 20,
    schedule: 15,
    serviceApi: 10,
    suiteMember: 5,
  },
  topScenarios: [],
  troubledScenarios: [],
}

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    readOverviewAnalytics: vi.fn(async () => mockOverviewResponse),
  }
})

let currentAccount: { id: string; permissions: string[] } | null = {
  id: '018f3a2b-1111-7000-8000-000000000001',
  permissions: ['run:read'],
}

class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!currentAccount) throw new UnauthorizedException()
    const req = context.switchToHttp().getRequest()
    req.account = currentAccount
    return true
  }
}

describe('OverviewController HTTP', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OverviewController],
      providers: [
        OverviewService,
        { provide: DB_HANDLE, useValue: {} },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        Reflector,
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('401 未登录拒绝访问', async () => {
    currentAccount = null
    await request(app.getHttpServer()).get('/api/overview/analytics').expect(401)
  })

  it('403 无权限用户拒绝访问', async () => {
    currentAccount = { id: 'test-user', permissions: ['target:read'] }
    await request(app.getHttpServer()).get('/api/overview/analytics').expect(403)
  })

  it('200 正常角色返回完整总览分析数据', async () => {
    currentAccount = { id: 'test-user', permissions: ['run:read'] }
    const res = await request(app.getHttpServer())
      .get('/api/overview/analytics?range=7d')
      .expect(200)

    expect(res.body.summary.totalRuns).toBe(50)
    expect(res.body.summary.successRate).toBe(0.96)
    expect(res.body.outcomes.passed).toBe(45)
  })

  it('400 传递非法时间范围参数拒绝', async () => {
    currentAccount = { id: 'test-user', permissions: ['run:read'] }
    await request(app.getHttpServer())
      .get('/api/overview/analytics?range=invalid')
      .expect(400)
  })
})
