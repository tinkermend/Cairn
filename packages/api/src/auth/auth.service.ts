import { ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { findLocalIdentity, type DbHandle } from '@cairn/db'
import {
  parseDurationSeconds,
  type AccountDto,
  type AuditClient,
  type LoginFailureReason,
  type LoginResponse,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { config } from '../config/env'
import { RbacService } from '../rbac/rbac.service'
import { hashSecret, verifySecret } from './password'
import type { RequestAccount } from '../common/request-account'

export function toRequestAccount(account: AccountDto): RequestAccount {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
    roles: account.roles,
    permissions: account.permissions,
  }
}

@Injectable()
export class AuthService {
  private readonly expiresIn = config.CAIRN_JWT_EXPIRES_IN
  private readonly logger = new Logger(AuthService.name)

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
  ) {}

  async login(email: string, password: string, client: AuditClient = {}): Promise<LoginResponse> {
    const identifier = email.trim().toLowerCase()
    const identity = await this.findLocalIdentity(email)
    const ok = identity?.secret ? await verifySecret(password, identity.secret) : await this.dummyVerify(password)
    if (!identity || !ok) {
      await this.safeRecordLoginFailure({
        identifier,
        reason: identity ? 'invalid_password' : 'unknown_account',
        accountId: identity?.consoleAccountId ?? null,
        client,
      })
      throw new UnauthorizedException('账号或密码不正确')
    }

    const account = await this.rbac.getAccount(identity.consoleAccountId)
    if (account.status !== 'active') {
      await this.safeRecordLoginFailure({
        identifier,
        reason: 'account_disabled',
        accountId: account.id,
        client,
      })
      throw new ForbiddenException('账号已停用')
    }

    await this.rbac.completeSuccessfulLogin({
      identityId: identity.id,
      accountId: account.id,
      identifier,
      client,
    })

    const accessToken = await this.jwt.signAsync({ sub: account.id })
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: parseDurationSeconds(this.expiresIn),
      account,
    }
  }

  async resolveAccount(accountId: string): Promise<RequestAccount> {
    return toRequestAccount(await this.rbac.getAccount(accountId))
  }

  private async findLocalIdentity(email: string) {
    return findLocalIdentity(this.dbHandle, email)
  }

  private async safeRecordLoginFailure(input: {
    identifier: string
    reason: LoginFailureReason
    accountId?: string | null
    client?: AuditClient
  }): Promise<void> {
    try {
      await this.rbac.recordLoginFailure(input)
    } catch (error) {
      this.logger.error({
        msg: '登录失败审计写入失败',
        identifier: input.identifier,
        reason: input.reason,
        err: error,
      })
    }
  }

  /** 即使用户不存在也走一遍哈希，避免按耗时枚举账号。 */
  private async dummyVerify(password: string): Promise<boolean> {
    await hashSecret(password)
    return false
  }
}
