import {
  BadRequestException,
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
import { PERMISSIONS, SCENARIO_ERROR_CODES, TARGET_ERROR_CODES } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { ScenariosController } from './scenarios.controller'
import { ScenariosService } from './scenarios.service'

const now = '2026-09-10T00:00:00.000Z'
const scenario = {
  id: '33333333-3333-4333-8333-333333333333',
  targetId: '11111111-1111-4111-8111-111111111111',
  name: '回显',
  status: 'active' as const,
  latestVersionId: '44444444-4444-4444-8444-444444444444',
  latestVersionNo: 1,
  stepCount: 1,
  createdAt: now,
  updatedAt: now,
  steps: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      name: '回显',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'hello' },
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

function mockService() {
  return {
    list: vi.fn(async () => ({ items: [scenario] })),
    get: vi.fn(async () => scenario),
    create: vi.fn(async () => scenario),
    update: vi.fn(async () => scenario),
    remove: vi.fn(async () => undefined),
    versions: vi.fn(async () => ({ items: [] })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScenariosController],
    providers: [
      Reflector,
      { provide: ScenariosService, useValue: service },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return app
}

describe('Scenarios HTTP', () => {
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

  it('无 workflow:write 不能新建', async () => {
    await request(viewerApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
      .expect(403)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('创建返回 201，删除返回 204', async () => {
    await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
      .expect(201)
    await request(adminApp.getHttpServer()).post(`/scenarios/${scenario.id}/delete`).expect(204)
  })

  it('领域码 SCENARIO_DISABLED / TARGET_DISABLED / SCENARIO_HAS_RUNS 原样透传', async () => {
    service.create.mockRejectedValueOnce(
      new ConflictException({ code: 'TARGET_DISABLED', message: '目标系统已停用，不能新建场景' }),
    )
    const disabledTarget = await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'x', steps: scenario.steps })
    expect(disabledTarget.body.code).toBe('TARGET_DISABLED')
    expect(TARGET_ERROR_CODES).toContain(disabledTarget.body.code)

    service.create.mockRejectedValueOnce(
      new BadRequestException({ code: 'SCENARIO_UNRESOLVED_REF', message: '前向引用' }),
    )
    const forward = await request(adminApp.getHttpServer())
      .post('/scenarios')
      .send({ targetId: scenario.targetId, name: 'y', steps: scenario.steps })
    expect(forward.body.code).toBe('SCENARIO_UNRESOLVED_REF')
    expect(SCENARIO_ERROR_CODES).toContain(forward.body.code)

    service.remove.mockRejectedValueOnce(
      new ConflictException({ code: 'SCENARIO_HAS_RUNS', message: '请先删除该场景下的运行' }),
    )
    const hasRuns = await request(adminApp.getHttpServer()).post(`/scenarios/${scenario.id}/delete`)
    expect(hasRuns.body.code).toBe('SCENARIO_HAS_RUNS')

    service.get.mockRejectedValueOnce(
      new NotFoundException({ code: SCENARIO_ERROR_CODES[0], message: '场景不存在' }),
    )
    const missing = await request(adminApp.getHttpServer()).get(`/scenarios/${scenario.id}`)
    expect(missing.body.code).toBe('SCENARIO_NOT_FOUND')
  })
})
