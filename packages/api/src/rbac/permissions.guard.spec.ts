import { Controller, Get, INestApplication, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSIONS } from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { IS_PUBLIC, Public } from '../common/public.decorator'
import type { RequestAccount } from '../common/request-account'
import { PermissionsGuard } from './permissions.guard'
import { RequirePermissions } from './require-permission.decorator'
import { listenForSupertest } from '../__tests__/http-app'

class StaticAuthGuard implements CanActivate {
  constructor(
    private readonly account: RequestAccount | null,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true
    if (!this.account) {
      throw new UnauthorizedException('认证尚未实现，此路由暂不可用')
    }
    context.switchToHttp().getRequest().account = this.account
    return true
  }
}

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: boolean } {
    return { ok: true }
  }

  @Get('authed')
  authed(): { ok: boolean } {
    return { ok: true }
  }

  @Get('write')
  @RequirePermissions('account:write')
  write(): { ok: boolean } {
    return { ok: true }
  }

  @Get('both')
  @RequirePermissions('account:write', 'role:write')
  both(): { ok: boolean } {
    return { ok: true }
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

const viewer: RequestAccount = {
  ...admin,
  id: 'acc-viewer',
  displayName: 'Viewer',
  roles: [{ id: 'viewer', key: 'viewer', name: 'Viewer', kind: 'system' }],
  permissions: ['account:read', 'role:read'],
}

const disabled: RequestAccount = {
  ...admin,
  id: 'acc-off',
  status: 'disabled',
}

async function buildApp(account: RequestAccount | null): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      Reflector,
      { provide: APP_GUARD, useValue: new StaticAuthGuard(account, new Reflector()) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

describe('PermissionsGuard', () => {
  let asAdmin: INestApplication
  let asViewer: INestApplication
  let asDisabled: INestApplication
  let anonymous: INestApplication

  beforeAll(async () => {
    asAdmin = await buildApp(admin)
    asViewer = await buildApp(viewer)
    asDisabled = await buildApp(disabled)
    anonymous = await buildApp(null)
  })

  afterAll(async () => {
    await asAdmin?.close()
    await asViewer?.close()
    await asDisabled?.close()
    await anonymous?.close()
  })

  it('未声明权限的受保护路由：认证通过即可', async () => {
    await request(asViewer.getHttpServer()).get('/probe/authed').expect(200, { ok: true })
  })

  it('声明了权限且主体具备时放行', async () => {
    await request(asAdmin.getHttpServer()).get('/probe/write').expect(200, { ok: true })
    await request(asAdmin.getHttpServer()).get('/probe/both').expect(200, { ok: true })
  })

  it('缺少任一所需权限返回 403 FORBIDDEN', async () => {
    const res = await request(asViewer.getHttpServer()).get('/probe/write').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.message).toContain('account:write')
  })

  it('AND 语义：有 write 但没有第二条时仍拒绝', async () => {
    const partial: RequestAccount = { ...viewer, permissions: ['account:write'] }
    const app = await buildApp(partial)
    const res = await request(app.getHttpServer()).get('/probe/both').expect(403)
    expect(res.body.message).toContain('role:write')
    await app.close()
  })

  it('停用账号即使有权限也拒绝', async () => {
    const res = await request(asDisabled.getHttpServer()).get('/probe/write').expect(403)
    expect(res.body.message).toBe('账号已停用')
    await request(asDisabled.getHttpServer()).get('/probe/authed').expect(403)
  })

  it('无主体时受保护路由仍是 401，不是 403', async () => {
    const res = await request(anonymous.getHttpServer()).get('/probe/write').expect(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
  })

  it('@Public 不受权限声明影响（本探针未在 open 上声明权限）', async () => {
    await request(anonymous.getHttpServer()).get('/probe/open').expect(200, { ok: true })
  })
})
