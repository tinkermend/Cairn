import {
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SYSTEM_ROLE_DEFINITIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from './permissions.guard'
import { AccountsController } from './accounts.controller'
import { AuditController } from './audit.controller'
import { RbacService } from './rbac.service'
import { RecordingsController } from '../recordings/recordings.controller'
import { RecordingsService } from '../recordings/recordings.service'
import { RunsController } from '../runs/runs.controller'
import { RunsService } from '../runs/runs.service'
import { ScenariosController } from '../scenarios/scenarios.controller'
import { ScenariosService } from '../scenarios/scenarios.service'
import { listenForSupertest } from '../__tests__/http-app'

const scenarioId = '33333333-3333-4333-8333-333333333333'
const createScenarioBody = {
  targetId: '11111111-1111-4111-8111-111111111111',
  name: '回显',
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

function principal(
  key: 'author' | 'operator' | 'viewer',
  extra: Partial<RequestAccount> = {},
): RequestAccount {
  return {
    id: `acc-${key}`,
    displayName: SYSTEM_ROLE_DEFINITIONS[key].name,
    email: `${key}@example.com`,
    status: 'active',
    roles: [{ id: key, key, name: SYSTEM_ROLE_DEFINITIONS[key].name, kind: 'system' }],
    permissions: [...SYSTEM_ROLE_DEFINITIONS[key].permissions],
    ...extra,
  }
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function mockServices() {
  return {
    rbac: {
      listAccounts: vi.fn(async () => ({ items: [] })),
      listAuditEvents: vi.fn(async () => ({ items: [] })),
      listLoginAuditEvents: vi.fn(async () => ({ items: [] })),
    },
    recordings: {
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => ({ id: 'rec-1' })),
      create: vi.fn(async () => ({ id: 'rec-1' })),
    },
    runs: {
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => ({ id: 'run-1' })),
      create: vi.fn(async () => ({ detail: { id: 'run-1' }, created: true })),
    },
    scenarios: {
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async () => ({ id: scenarioId })),
      create: vi.fn(async () => ({ id: scenarioId })),
      trial: vi.fn(async () => ({ detail: { id: 'run-1' }, created: true })),
    },
  }
}

async function buildApp(account: RequestAccount, services: ReturnType<typeof mockServices>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [
      AccountsController,
      AuditController,
      RecordingsController,
      RunsController,
      ScenariosController,
    ],
    providers: [
      Reflector,
      { provide: RbacService, useValue: services.rbac },
      { provide: RecordingsService, useValue: services.recordings },
      { provide: RunsService, useValue: services.runs },
      { provide: ScenariosService, useValue: services.scenarios },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('产品角色能力闸门', () => {
  const services = mockServices()
  let authorApp: INestApplication
  let operatorApp: INestApplication
  let viewerApp: INestApplication
  let executeOnlyApp: INestApplication

  beforeAll(async () => {
    authorApp = await buildApp(principal('author'), services)
    operatorApp = await buildApp(principal('operator'), services)
    viewerApp = await buildApp(principal('viewer'), services)
    executeOnlyApp = await buildApp(
      principal('viewer', { id: 'acc-exec', permissions: ['run:execute'] }),
      services,
    )
  })

  afterAll(async () => {
    await authorApp.close()
    await operatorApp.close()
    await viewerApp.close()
    await executeOnlyApp.close()
  })

  it('执行者不能写场景、读录制或进治理，但能开跑', async () => {
    await request(operatorApp.getHttpServer()).post('/scenarios').send(createScenarioBody).expect(403)
    await request(operatorApp.getHttpServer()).get('/recordings').expect(403)
    await request(operatorApp.getHttpServer()).get('/console/accounts').expect(403)
    await request(operatorApp.getHttpServer()).get('/console/audit/operations').expect(403)
    await request(operatorApp.getHttpServer()).post('/runs').send({ scenarioId }).expect(201)
    expect(services.scenarios.create).not.toHaveBeenCalled()
    expect(services.recordings.list).not.toHaveBeenCalled()
    expect(services.rbac.listAccounts).not.toHaveBeenCalled()
    expect(services.runs.create).toHaveBeenCalled()
  })

  it('编写者能写场景并开跑，不能管账号，没有 session:dispose', async () => {
    expect(principal('author').permissions).not.toContain('session:dispose')
    await request(authorApp.getHttpServer()).post('/scenarios').send(createScenarioBody).expect(201)
    await request(authorApp.getHttpServer()).post(`/scenarios/${scenarioId}/trial`).send({ revision: 1 }).expect(201)
    await request(authorApp.getHttpServer()).post('/runs').send({ scenarioId }).expect(201)
    await request(authorApp.getHttpServer()).get('/console/accounts').expect(403)
    expect(services.scenarios.create).toHaveBeenCalled()
  })

  it('只读能看场景和运行，不能开跑、不能读录制、不能进治理', async () => {
    await request(viewerApp.getHttpServer()).get('/scenarios').expect(200)
    await request(viewerApp.getHttpServer()).get('/runs').expect(200)
    await request(viewerApp.getHttpServer()).post('/runs').send({ scenarioId }).expect(403)
    await request(viewerApp.getHttpServer()).get('/recordings').expect(403)
    await request(viewerApp.getHttpServer()).get('/console/accounts').expect(403)
    await request(viewerApp.getHttpServer()).get('/console/audit/operations').expect(403)
  })

  it('仅有 run:execute 不能开跑', async () => {
    await request(executeOnlyApp.getHttpServer()).post('/runs').send({ scenarioId }).expect(403)
  })
})
