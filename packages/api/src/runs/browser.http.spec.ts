import { INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { BrowserService } from './browser.service'
import { ObserveService } from './observe.service'
import { RunsController } from './runs.controller'
import { RunsService } from './runs.service'
import { listenForSupertest } from '../__tests__/http-app'

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

const executor: RequestAccount = {
  ...admin,
  id: 'acc-exec',
  permissions: ['run:read', 'run:execute'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

const runId = '66666666-6666-4666-8666-666666666666'
const meta = {
  runId,
  runStatus: 'WAITING_FOR_AUTH',
  sessionId: '77777777-7777-4777-8777-777777777777',
  sessionGeneration: 1,
  ownerWorkerId: 'local-worker',
  framesAvailable: false,
  viewingOtherPage: false,
  currentPage: null,
  pages: [],
  authHold: null,
  authControl: { epoch: 0, actorId: null, expiresAt: null, heldByViewer: false },
  capabilities: {
    screencast: 'open',
    authInput: 'open',
    popupHandoff: 'open',
    chineseInsertText: 'open',
  },
  degradedReason: 'worker_unreachable',
}

function mockBrowser() {
  return {
    meta: vi.fn(async () => meta),
    streamFrames: vi.fn(async () => undefined),
    acquire: vi.fn(async () => ({ token: 'a'.repeat(32), epoch: 1, expiresAt: '2026-09-13T00:00:30.000Z' })),
    heartbeat: vi.fn(async () => ({ expiresAt: '2026-09-13T00:00:30.000Z', epoch: 1 })),
    input: vi.fn(async () => ({ commandId: '00000000-0000-4000-8000-000000000001', seq: 1, status: 'accepted' })),
    release: vi.fn(async () => ({ released: true })),
    resumeAuth: vi.fn(async () => ({ id: runId, status: 'RECOVERING' })),
    observe: vi.fn(async () => ({
      outcome: 'FOUND',
      page: { url: 'https://shop.example.com' },
      diagnostics: { outcome: 'FOUND', candidatesTried: [] },
      source: 'managed',
    })),
    debug: vi.fn(async () => ({ id: runId, status: 'HOLDING' })),
  }
}

async function buildApp(account: RequestAccount, browser = mockBrowser()) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RunsController],
    providers: [
      Reflector,
      { provide: RunsService, useValue: {} },
      { provide: ObserveService, useValue: {} },
      { provide: BrowserService, useValue: browser },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  return listenForSupertest(moduleRef.createNestApplication({ logger: false }))
}

describe('受管浏览器 HTTP', () => {
  let adminApp: INestApplication
  let viewerApp: INestApplication
  let execApp: INestApplication
  const browser = mockBrowser()

  beforeAll(async () => {
    adminApp = await buildApp(admin, browser)
    viewerApp = await buildApp(viewer, browser)
    execApp = await buildApp(executor, browser)
  })

  afterAll(async () => {
    await adminApp.close()
    await viewerApp.close()
    await execApp.close()
  })

  it('viewer 不能看画面或接管登录', async () => {
    await request(viewerApp.getHttpServer()).get(`/runs/${runId}/browser`).expect(403)
    await request(viewerApp.getHttpServer()).post(`/runs/${runId}/browser/auth-control/acquire`).send({}).expect(403)
    await request(viewerApp.getHttpServer()).post(`/runs/${runId}/resume-auth`).send({}).expect(403)
    expect(browser.meta).not.toHaveBeenCalled()
    expect(browser.acquire).not.toHaveBeenCalled()
    expect(browser.resumeAuth).not.toHaveBeenCalled()
  })

  it('仅有 run:execute 不能 resume-auth 或授输入权', async () => {
    await request(execApp.getHttpServer()).post(`/runs/${runId}/resume-auth`).send({}).expect(403)
    await request(execApp.getHttpServer()).post(`/runs/${runId}/browser/auth-control/acquire`).send({}).expect(403)
  })

  it('管理员可以读取元数据并申请控制', async () => {
    const res = await request(adminApp.getHttpServer()).get(`/runs/${runId}/browser`).expect(200)
    expect(res.body.runId).toBe(runId)
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|:8091|playwright/i)
    await request(adminApp.getHttpServer()).post(`/runs/${runId}/browser/auth-control/acquire`).send({}).expect(200)
    expect(browser.acquire).toHaveBeenCalled()
  })

  it('observe 需要 run:read + session:view + workflow:write，debug 需要 run:execute + workflow:write', async () => {
    await request(viewerApp.getHttpServer()).post(`/runs/${runId}/observe`).send({ op: 'highlight' }).expect(403)
    await request(viewerApp.getHttpServer()).post(`/runs/${runId}/debug`).send({ action: 'stop' }).expect(403)
    await request(adminApp.getHttpServer()).post(`/runs/${runId}/observe`).send({ op: 'highlight' }).expect(200)
    await request(adminApp.getHttpServer()).post(`/runs/${runId}/debug`).send({ action: 'stop' }).expect(200)
    expect(browser.observe).toHaveBeenCalled()
    expect(browser.debug).toHaveBeenCalled()
  })
})
