import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { hasAllPermissions, type PermissionCode } from '@cairn/shared'
import '../common/request-account'
import { REQUIRE_PERMISSIONS } from './require-permission.decorator'

/**
 * 授权 Guard。认证（AuthGuard）之后执行。
 *
 * 没有 @RequirePermissions 的路由到此即放行——调用方已经通过认证。
 * 有声明时按 AND 检查 req.account.permissions；前端隐藏菜单不是安全边界。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[] | undefined>(REQUIRE_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ])
    const req = context.switchToHttp().getRequest<Request>()
    const account = req.account
    if (account?.status === 'disabled') {
      throw new ForbiddenException('账号已停用')
    }
    if (!required || required.length === 0) return true
    if (!account) {
      throw new UnauthorizedException('未认证')
    }
    if (!hasAllPermissions(account.permissions, required)) {
      throw new ForbiddenException(`缺少权限：${required.join(', ')}`)
    }
    return true
  }
}
