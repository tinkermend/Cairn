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
import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  accountListResponseSchema,
  meResponseSchema,
  permissionCatalogResponseSchema,
  roleListResponseSchema,
  roleSchema,
} from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { AccountsController } from './accounts.controller'
import { AuditController } from './audit.controller'
import { MeController } from './me.controller'
import { PermissionsGuard } from './permissions.guard'
import { RbacController } from './rbac.controller'
import { RbacService } from './rbac.service'
import { listenForSupertest } from '../__tests__/http-app'

const now = '2026-01-01T00:00:00.000Z'

const adminRole = {
  id: 'admin',
  key: 'admin',
  name: 'Administrator',
  kind: 'system' as const,
  description: 'all',
  permissions: [...PERMISSIONS],
  accountCount: 1,
  createdAt: now,
  updatedAt: now,
}

const customRole = {
  id: 'role-qa',
  key: 'qa_lead',
  name: 'QA Lead',
  kind: 'custom' as const,
  description: null,
  permissions: ['workflow:read', 'run:read'],
  accountCount: 0,
  createdAt: now,
  updatedAt: now,
}

const adminAccount = {
  id: 'acc-admin',
  displayName: 'Admin',
  email: 'admin@example.com',
  status: 'active' as const,
  roles: [{ id: 'admin', key: 'admin', name: 'Administrator', kind: 'system' as const }],
  permissions: [...PERMISSIONS],
  createdAt: now,
  updatedAt: now,
}

const adminPrincipal: RequestAccount = {
  id: adminAccount.id,
  displayName: adminAccount.displayName,
  email: adminAccount.email,
  status: adminAccount.status,
  roles: adminAccount.roles,
  permissions: adminAccount.permissions,
}

const viewerPrincipal: RequestAccount = {
  ...adminPrincipal,
  id: 'acc-viewer',
  displayName: 'Viewer',
  roles: [{ id: 'viewer', key: 'viewer', name: 'Viewer', kind: 'system' }],
  permissions: ['account:read', 'role:read', 'workflow:read', 'run:read', 'target:read', 'settings:read', 'audit:read'],
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly account: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.account) throw new UnauthorizedException('认证尚未实现，此路由暂不可用')
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

function mockService() {
  return {
    listPermissions: vi.fn(() => ({ items: [...PERMISSION_CATALOG] })),
    listRoles: vi.fn(async () => ({ items: [adminRole, customRole] })),
    getRole: vi.fn(async (id: string) => (id === customRole.id ? customRole : adminRole)),
    createRole: vi.fn(async () => customRole),
    updateRole: vi.fn(async () => ({ ...customRole, name: 'QA' })),
    replaceRolePermissions: vi.fn(async () => customRole),
    deleteRole: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => ({ items: [adminAccount] })),
    getAccount: vi.fn(async () => adminAccount),
    getMe: vi.fn(async () => ({ account: adminAccount })),
    createAccount: vi.fn(async () => adminAccount),
    updateAccount: vi.fn(async () => adminAccount),
    deleteAccount: vi.fn(async () => undefined),
    assignAccountRoles: vi.fn(async () => adminAccount),
    listAuditEvents: vi.fn(async () => ({ items: [] })),
    listLoginAuditEvents: vi.fn(async () => ({ items: [] })),
    changePassword: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    updateMe: vi.fn(async () => ({ account: adminAccount })),
    listRoleAccounts: vi.fn(async () => ({ items: [adminAccount] })),
    addRoleAccounts: vi.fn(async () => ({ addedCount: 1 })),
    removeRoleAccounts: vi.fn(async () => ({ removedCount: 1 })),
  }
}

async function buildApp(account: RequestAccount | null, service: ReturnType<typeof mockService>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [RbacController, AccountsController, MeController, AuditController],
    providers: [
      Reflector,
      { provide: RbacService, useValue: service },
      {
        provide: APP_GUARD,
        useValue: new StaticAuthGuard(account),
      },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('RBAC HTTP', () => {
  const service = mockService()
  let adminApp: INestApplication
  let viewerApp: INestApplication
  let realAuthApp: INestApplication

  beforeAll(async () => {
    adminApp = await buildApp(adminPrincipal, service)
    viewerApp = await buildApp(viewerPrincipal, service)
    realAuthApp = await buildApp(null, service)
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    await adminApp?.close()
    await viewerApp?.close()
    await realAuthApp?.close()
  })

  it('未认证访问 RBAC 路由返回 401，服务不被调用', async () => {
    await request(realAuthApp.getHttpServer()).get('/rbac/roles').expect(401)
    await request(realAuthApp.getHttpServer()).get('/me').expect(401)
    expect(service.listRoles).not.toHaveBeenCalled()
  })

  it('GET /rbac/permissions 返回与 shared 同一份目录，标签为中文', async () => {
    const res = await request(adminApp.getHttpServer()).get('/rbac/permissions').expect(200)
    expect(() => permissionCatalogResponseSchema.parse(res.body)).not.toThrow()
    expect(res.body.items).toHaveLength(PERMISSIONS.length)
    expect(res.body.items.find((item: { code: string }) => item.code === 'workflow:read')?.label).toBe(
      '查看场景',
    )
    expect(res.body.items.find((item: { code: string }) => item.code === 'ai:execute')?.label).toBe(
      '执行含 AI 步骤的运行',
    )
  })

  it('GET /rbac/roles 符合契约', async () => {
    const res = await request(adminApp.getHttpServer()).get('/rbac/roles').expect(200)
    expect(() => roleListResponseSchema.parse(res.body)).not.toThrow()
    expect(res.body.items.map((r: { key: string }) => r.key)).toEqual(['admin', 'qa_lead'])
  })

  it('viewer 可以读角色，不能创建或删除', async () => {
    await request(viewerApp.getHttpServer()).get('/rbac/roles').expect(200)
    const denied = await request(viewerApp.getHttpServer())
      .post('/rbac/roles')
      .send({ key: 'qa_lead', name: 'QA', permissions: ['workflow:read'] })
      .expect(403)
    expect(denied.body.code).toBe('FORBIDDEN')
    await request(viewerApp.getHttpServer()).post('/rbac/roles/role-qa/delete').expect(403)
    expect(service.createRole).not.toHaveBeenCalled()
    expect(service.deleteRole).not.toHaveBeenCalled()
  })

  it('admin 创建角色时校验 body，非法权限码 400', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/rbac/roles')
      .send({ key: 'qa_lead', name: 'QA', permissions: ['*:*'] })
      .expect(400)
    expect(res.body.code).toBe('BAD_REQUEST')
    expect(service.createRole).not.toHaveBeenCalled()
  })

  it('admin 创建合法自定义角色', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/rbac/roles')
      .send({ key: 'qa_lead', name: 'QA Lead', permissions: ['workflow:read', 'run:read'] })
      .expect(201)
    expect(() => roleSchema.parse(res.body)).not.toThrow()
    expect(service.createRole).toHaveBeenCalledOnce()
  })

  it('删除角色返回 204', async () => {
    await request(adminApp.getHttpServer()).post('/rbac/roles/role-qa/delete').expect(204)
    expect(service.deleteRole).toHaveBeenCalledWith('role-qa', adminPrincipal)
  })

  it('GET /console/accounts 符合契约；viewer 不能写', async () => {
    const res = await request(viewerApp.getHttpServer()).get('/console/accounts').expect(200)
    expect(() => accountListResponseSchema.parse(res.body)).not.toThrow()
    await request(viewerApp.getHttpServer())
      .post('/console/accounts')
      .send({ displayName: '乙' })
      .expect(403)
  })

  it('创建账号把当前主体作为 assigned_by 传入', async () => {
    await request(adminApp.getHttpServer())
      .post('/console/accounts')
      .send({ displayName: '运维乙', email: 'ops@example.com', password: 'password1', roleIds: ['operator'] })
      .expect(201)
    expect(service.createAccount).toHaveBeenCalledWith(
      {
        displayName: '运维乙',
        email: 'ops@example.com',
        password: 'password1',
        roleIds: ['operator'],
      },
      adminPrincipal,
    )
  })

  it('分配角色校验至少保留一个', async () => {
    const res = await request(adminApp.getHttpServer())
      .post('/console/accounts/acc-1/roles')
      .send({ roleIds: [] })
      .expect(400)
    expect(res.body.code).toBe('BAD_REQUEST')
  })

  it('GET /me 只需认证，返回当前账号', async () => {
    const res = await request(viewerApp.getHttpServer()).get('/me').expect(200)
    expect(() => meResponseSchema.parse(res.body)).not.toThrow()
    expect(service.getMe).toHaveBeenCalledWith(viewerPrincipal.id)
  })

  it('POST /me 更新显示名', async () => {
    await request(viewerApp.getHttpServer()).post('/me').send({ displayName: 'V2' }).expect(200)
    expect(service.updateMe).toHaveBeenCalledWith(viewerPrincipal.id, { displayName: 'V2' })
  })

  it('POST /me/password 返回 204', async () => {
    await request(viewerApp.getHttpServer())
      .post('/me/password')
      .send({ currentPassword: 'old-pass1', newPassword: 'new-pass1' })
      .expect(204)
    expect(service.changePassword).toHaveBeenCalledWith(viewerPrincipal.id, {
      currentPassword: 'old-pass1',
      newPassword: 'new-pass1',
    })
  })

  it('GET /console/audit 需要 audit:read', async () => {
    await request(adminApp.getHttpServer()).get('/console/audit').expect(200)
    expect(service.listAuditEvents).toHaveBeenCalledOnce()
  })

  it('GET /console/audit/operations 需要 audit:read，logins 需要 audit:login', async () => {
    await request(adminApp.getHttpServer()).get('/console/audit/operations').expect(200)
    await request(adminApp.getHttpServer()).get('/console/audit/logins').expect(200)
    expect(service.listAuditEvents).toHaveBeenCalled()
    expect(service.listLoginAuditEvents).toHaveBeenCalledOnce()
    await request(viewerApp.getHttpServer()).get('/console/audit/logins').expect(403)
    await request(viewerApp.getHttpServer()).get('/console/audit/operations').expect(200)
  })

  it('GET /rbac/roles/:id/accounts 需要 role:read', async () => {
    await request(viewerApp.getHttpServer()).get(`/rbac/roles/${customRole.id}/accounts`).expect(200)
    expect(service.listRoleAccounts).toHaveBeenCalledWith(customRole.id, expect.any(Object))
  })

  it('POST /rbac/roles/:id/accounts 需要 role:write 与 account:write，viewer 返回 403', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/rbac/roles/${customRole.id}/accounts`)
      .send({ accountIds: ['acc-1'] })
      .expect(403)

    const res = await request(adminApp.getHttpServer())
      .post(`/rbac/roles/${customRole.id}/accounts`)
      .send({ accountIds: ['acc-1'] })
      .expect(200)
    expect(res.body).toEqual({ addedCount: 1 })
    expect(service.addRoleAccounts).toHaveBeenCalledWith(
      customRole.id,
      { accountIds: ['acc-1'] },
      expect.any(Object),
    )
  })

  it('POST /rbac/roles/:id/accounts/remove 需要 role:write 与 account:write，viewer 返回 403', async () => {
    await request(viewerApp.getHttpServer())
      .post(`/rbac/roles/${customRole.id}/accounts/remove`)
      .send({ accountIds: ['acc-1'] })
      .expect(403)

    const res = await request(adminApp.getHttpServer())
      .post(`/rbac/roles/${customRole.id}/accounts/remove`)
      .send({ accountIds: ['acc-1'] })
      .expect(200)
    expect(res.body).toEqual({ removedCount: 1 })
    expect(service.removeRoleAccounts).toHaveBeenCalledWith(
      customRole.id,
      { accountIds: ['acc-1'] },
      expect.any(Object),
    )
  })
})

