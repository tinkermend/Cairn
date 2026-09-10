import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { Request } from 'express'
import { IS_PUBLIC } from './public.decorator'
import { AuthService } from '../auth/auth.service'

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const req = context.switchToHttp().getRequest<Request>()
    return this.authenticate(req)
  }

  private async authenticate(req: Request): Promise<boolean> {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('未认证')
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) throw new UnauthorizedException('未认证')

    let accountId: string
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token)
      if (!payload.sub) throw new UnauthorizedException('登录已过期或无效')
      accountId = payload.sub
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      throw new UnauthorizedException('登录已过期或无效')
    }

    try {
      req.account = await this.auth.resolveAccount(accountId)
    } catch {
      throw new UnauthorizedException('登录已过期或无效')
    }
    return true
  }
}
