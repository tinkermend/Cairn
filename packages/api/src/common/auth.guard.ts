import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC } from './public.decorator'

/**
 * 全局认证 Guard，默认拒绝。
 *
 * 骨架阶段只有「是否 public」这一层判定，真正的凭据校验（JWT 解析、
 * console_identities 查询）待认证功能落地时填入 authenticate()。
 * 接线先到位，是为了让后续每个新增路由从第一天起就默认受保护——
 * 而不是等鉴权做完再回头逐个补。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const req = context.switchToHttp().getRequest<Request>()
    return this.authenticate(req)
  }

  /**
   * TODO(认证功能)：解析 Bearer token → 查 console_identities →
   * 装配 console_accounts 的角色到 req.account。
   * 在此之前一律拒绝，避免出现「看起来受保护、实际放行」的假象。
   */
  private authenticate(_req: Request): boolean {
    throw new UnauthorizedException('认证尚未实现，此路由暂不可用')
  }
}
