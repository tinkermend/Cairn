import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { and, consoleIdentities, eq, sql, type DbHandle } from '@cairn/db'
import { parseDurationSeconds, type AccountDto, type LoginResponse } from '@cairn/shared'
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

  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
  ) {}

  private get db() {
    return this.dbHandle.db
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const identity = await this.findLocalIdentity(email)
    const ok = identity?.secret ? await verifySecret(password, identity.secret) : await this.dummyVerify(password)
    if (!identity || !ok) {
      throw new UnauthorizedException('账号或密码不正确')
    }

    const account = await this.rbac.getAccount(identity.consoleAccountId)
    if (account.status !== 'active') {
      throw new ForbiddenException('账号已停用')
    }

    await this.db
      .update(consoleIdentities)
      .set({ lastUsedAt: new Date() })
      .where(eq(consoleIdentities.id, identity.id))

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
    const subject = email.trim().toLowerCase()
    const [row] = await this.db
      .select()
      .from(consoleIdentities)
      .where(and(eq(consoleIdentities.provider, 'local'), sql`lower(${consoleIdentities.subject}) = ${subject}`))
      .limit(1)
    return row ?? null
  }

  /** 即使用户不存在也走一遍哈希，避免按耗时枚举邮箱。 */
  private async dummyVerify(password: string): Promise<boolean> {
    await hashSecret(password)
    return false
  }
}
