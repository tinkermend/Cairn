import {
  Injectable,
  Optional,
  ForbiddenException,
  PayloadTooLargeException,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { ServicesService } from "../services/services.service";
import {
  IS_SERVICE_API,
  SERVICE_REQUIRED_SCOPES,
} from "../services/services.controller";
import type { ServiceScope } from "@cairn/shared";
import { IS_PUBLIC } from "./public.decorator";
import { AuthService } from "../auth/auth.service";
import { clientContextFromRequest } from "../auth/client-context";
import { config } from "../config/env";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    @Optional() private readonly services?: ServicesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (
      this.reflector.getAllAndOverride<boolean>(IS_SERVICE_API, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      const scopes = this.reflector.get<ServiceScope[]>(
        SERVICE_REQUIRED_SCOPES,
        context.getHandler(),
      );
      if (!scopes?.length || !this.services)
        throw new ForbiddenException("服务接口未声明权限");
      const clientIp =
        clientContextFromRequest(req, config.CAIRN_TRUST_PROXY_HOPS).ip ?? null;
      req.servicePrincipal = await this.services.authenticate(
        req.headers.authorization,
        clientIp,
        ({ callerId, credentialId }) => {
          // This callback only runs after the key secret has passed constant-time
          // verification. Never create a caller log context from a guessed key id.
          req.serviceRequestLog = { callerId, credentialId, clientIp };
        },
      );
      req.servicePrincipal.requestId = req.requestId;
      if (!scopes.every((s) => req.servicePrincipal!.scopes.includes(s)))
        throw new ForbiddenException({
          code: "SERVICE_SCOPE_DENIED",
          message: "服务凭据缺少所需权限",
        });
      if (req.body && Buffer.byteLength(JSON.stringify(req.body)) > 65536)
        throw new PayloadTooLargeException();
      return true;
    }
    return this.authenticate(req);
  }

  private async authenticate(req: Request): Promise<boolean> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("未认证");
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new UnauthorizedException("未认证");

    let accountId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      if (!payload.sub) throw new UnauthorizedException("登录已过期或无效");
      accountId = payload.sub;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("登录已过期或无效");
    }

    try {
      req.account = await this.auth.resolveAccount(accountId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new UnauthorizedException("登录已过期或无效");
      }
      // 查询失败不代表凭证失效，交给异常过滤器按服务故障处理。
      throw error;
    }
    return true;
  }
}
