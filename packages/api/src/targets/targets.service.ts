import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import {
  asc,
  consoleAuditEvents,
  countRunsForAccount,
  countScenariosForTarget,
  eq,
  mapPgRestriction,
  newId,
  secrets,
  sql,
  targetAccounts,
  targets,
  type DbHandle,
} from '@cairn/db'
import {
  LOCAL_SECRET_PROVIDER,
  compactLoginFields,
  targetAccountListResponseSchema,
  targetAccountSchema,
  targetListResponseSchema,
  targetSchema,
  type AuditAction,
  type CreateTargetAccountBody,
  type CreateTargetBody,
  type TargetAccountDto,
  type TargetAccountListResponse,
  type TargetDto,
  type TargetListResponse,
  type TargetLoginFields,
  type UpdateTargetAccountBody,
  type UpdateTargetBody,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

function iso(value: Date): string {
  return value.toISOString()
}

function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  if (error instanceof Error && error.cause) return pgCode(error.cause)
  return undefined
}

function constraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    return String((error as { constraint: unknown }).constraint)
  }
  if (error instanceof Error && error.cause) return constraintName(error.cause)
  return undefined
}

function rethrowUnique(error: unknown, kind: 'target' | 'account'): never {
  if (pgCode(error) === '23505') {
    const name = constraintName(error)
    const accountConflict = name?.includes('target_accounts') || kind === 'account'
    if (!accountConflict || name?.includes('targets_code')) {
      throw new ConflictException({ code: 'TARGET_CODE_CONFLICT', message: '目标系统编码已存在' })
    }
    throw new ConflictException({
      code: 'TARGET_ACCOUNT_CONFLICT',
      message: '该目标系统下登录名已存在',
    })
  }
  throw error
}

@Injectable()
export class TargetsService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    private readonly secretProvider: LocalSecretProvider,
  ) {}

  private get db() {
    return this.dbHandle.db
  }

  async listTargets(): Promise<TargetListResponse> {
    const rows = await this.db
      .select()
      .from(targets)
      .orderBy(asc(targets.createdAt), asc(targets.id))
    const counts = await this.accountCounts()
    return targetListResponseSchema.parse({
      items: rows.map((row) => this.toTarget(row, counts.get(row.id) ?? 0)),
    })
  }

  async getTarget(id: string): Promise<TargetDto> {
    const row = await this.loadTarget(id)
    const counts = await this.accountCounts(id)
    return this.toTarget(row, counts.get(id) ?? 0)
  }

  async createTarget(body: CreateTargetBody, actor: RequestAccount): Promise<TargetDto> {
    const id = newId()
    const now = new Date()
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(targets).values({
          id,
          code: body.code,
          name: body.name,
          entryUrl: body.entryUrl,
          loginUrl: body.loginUrl ?? null,
          authMethod: body.authMethod,
          captchaMode: body.captchaMode,
          status: body.status,
          loginFields: body.loginFields,
          createdAt: now,
          updatedAt: now,
        })
        await this.writeAudit(tx, actor, 'target.create', 'target', id, `${body.name}（${body.code}）`)
        if (body.account) {
          await this.insertAccount(tx, id, body.account, actor, now)
        }
      })
    } catch (error) {
      rethrowUnique(error, 'target')
    }
    return this.getTarget(id)
  }

  async updateTarget(id: string, body: UpdateTargetBody, actor: RequestAccount): Promise<TargetDto> {
    const current = await this.loadTarget(id)
    const now = new Date()
    const loginOnly =
      body.loginFields !== undefined &&
      body.name === undefined &&
      body.entryUrl === undefined &&
      body.loginUrl === undefined &&
      body.authMethod === undefined &&
      body.captchaMode === undefined &&
      body.status === undefined
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(targets)
          .set({
            name: body.name ?? current.name,
            entryUrl: body.entryUrl ?? current.entryUrl,
            loginUrl: body.loginUrl === undefined ? current.loginUrl : body.loginUrl,
            authMethod: body.authMethod ?? current.authMethod,
            captchaMode: body.captchaMode ?? current.captchaMode,
            status: body.status ?? current.status,
            loginFields:
              body.loginFields === undefined ? current.loginFields : body.loginFields,
            updatedAt: now,
          })
          .where(eq(targets.id, id))
        await this.writeAudit(
          tx,
          actor,
          'target.update',
          'target',
          id,
          loginOnly ? '更新了登录框定位' : `${body.name ?? current.name}（${current.code}）`,
        )
      })
    } catch (error) {
      rethrowUnique(error, 'target')
    }
    return this.getTarget(id)
  }

  async deleteTarget(id: string, actor: RequestAccount): Promise<void> {
    const current = await this.loadTarget(id)
    const counts = await this.accountCounts(id)
    if ((counts.get(id) ?? 0) > 0) {
      throw new ConflictException({
        code: 'TARGET_HAS_ACCOUNTS',
        message: '请先删除该目标系统下的目标账号',
      })
    }
    const scenarioCount = await countScenariosForTarget(this.db, id)
    if (scenarioCount > 0) {
      throw new ConflictException({
        code: 'TARGET_HAS_SCENARIOS',
        message: '请先删除该目标系统下的场景',
      })
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(targets).where(eq(targets.id, id))
        await this.writeAudit(tx, actor, 'target.delete', 'target', id, `${current.name}（${current.code}）`)
      })
    } catch (error) {
      const mapped = mapPgRestriction(error)
      if (mapped) {
        throw new ConflictException({ code: mapped.code, message: mapped.message })
      }
      throw error
    }
  }

  async listAccounts(targetId: string): Promise<TargetAccountListResponse> {
    await this.loadTarget(targetId)
    const rows = await this.db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.targetId, targetId))
      .orderBy(asc(targetAccounts.createdAt), asc(targetAccounts.id))
    return targetAccountListResponseSchema.parse({
      items: rows.map((row) => this.toAccount(row)),
    })
  }

  async createAccount(
    targetId: string,
    body: CreateTargetAccountBody,
    actor: RequestAccount,
  ): Promise<TargetAccountDto> {
    await this.loadTarget(targetId)
    const now = new Date()
    let id = ''
    try {
      await this.db.transaction(async (tx) => {
        id = await this.insertAccount(tx, targetId, body, actor, now)
      })
    } catch (error) {
      rethrowUnique(error, 'account')
    }
    return this.getAccount(targetId, id)
  }

  async updateAccount(
    targetId: string,
    accountId: string,
    body: UpdateTargetAccountBody,
    actor: RequestAccount,
  ): Promise<TargetAccountDto> {
    const current = await this.loadAccount(targetId, accountId)
    const now = new Date()
    const nextSecret = body.password ? this.seal(body.password) : undefined
    try {
      await this.db.transaction(async (tx) => {
        if (nextSecret) {
          await tx.insert(secrets).values({
            id: nextSecret.id,
            provider: LOCAL_SECRET_PROVIDER,
            ciphertext: nextSecret.ciphertext,
            createdAt: now,
            updatedAt: now,
          })
        }
        await tx
          .update(targetAccounts)
          .set({
            displayName: body.displayName ?? current.displayName,
            username: body.username ?? current.username,
            status: body.status ?? current.status,
            secretProvider: body.clearPassword
              ? null
              : nextSecret
                ? LOCAL_SECRET_PROVIDER
                : current.secretProvider,
            secretId: body.clearPassword ? null : nextSecret ? nextSecret.id : current.secretId,
            updatedAt: now,
          })
          .where(eq(targetAccounts.id, accountId))
        if ((nextSecret || body.clearPassword) && current.secretId) {
          await tx.delete(secrets).where(eq(secrets.id, current.secretId))
        }
        const changedMeta =
          body.displayName !== undefined ||
          body.username !== undefined ||
          body.status !== undefined
        if (changedMeta) {
          await this.writeAudit(
            tx,
            actor,
            'target_account.update',
            'target_account',
            accountId,
            `${body.displayName ?? current.displayName}（${body.username ?? current.username}）`,
          )
        }
        if (nextSecret || body.clearPassword) {
          await this.writeAudit(
            tx,
            actor,
            'target_account.password',
            'target_account',
            accountId,
            body.username ?? current.username,
          )
        }
      })
    } catch (error) {
      rethrowUnique(error, 'account')
    }
    return this.getAccount(targetId, accountId)
  }

  async deleteAccount(targetId: string, accountId: string, actor: RequestAccount): Promise<void> {
    const current = await this.loadAccount(targetId, accountId)
    const runCount = await countRunsForAccount(this.db, accountId)
    if (runCount > 0) {
      throw new ConflictException({
        code: 'TARGET_ACCOUNT_HAS_RUNS',
        message: '请先处理引用该目标账号的运行',
      })
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(targetAccounts).where(eq(targetAccounts.id, accountId))
        if (current.secretId) {
          await tx.delete(secrets).where(eq(secrets.id, current.secretId))
        }
        await this.writeAudit(
          tx,
          actor,
          'target_account.delete',
          'target_account',
          accountId,
          `${current.displayName}（${current.username}）`,
        )
      })
    } catch (error) {
      const mapped = mapPgRestriction(error)
      if (mapped) {
        throw new ConflictException({ code: mapped.code, message: mapped.message })
      }
      throw error
    }
  }

  private async getAccount(targetId: string, accountId: string): Promise<TargetAccountDto> {
    const row = await this.loadAccount(targetId, accountId)
    return this.toAccount(row)
  }

  private async loadTarget(id: string) {
    const [row] = await this.db.select().from(targets).where(eq(targets.id, id)).limit(1)
    if (!row) {
      throw new NotFoundException({ code: 'TARGET_NOT_FOUND', message: '目标系统不存在' })
    }
    return row
  }

  private async loadAccount(targetId: string, accountId: string) {
    await this.loadTarget(targetId)
    const [row] = await this.db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, accountId))
      .limit(1)
    if (!row || row.targetId !== targetId) {
      throw new NotFoundException({ code: 'TARGET_ACCOUNT_NOT_FOUND', message: '目标账号不存在' })
    }
    return row
  }

  private async accountCounts(targetId?: string): Promise<Map<string, number>> {
    const base = this.db
      .select({
        targetId: targetAccounts.targetId,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(targetAccounts)
    const rows = targetId
      ? await base.where(eq(targetAccounts.targetId, targetId)).groupBy(targetAccounts.targetId)
      : await base.groupBy(targetAccounts.targetId)
    return new Map(rows.map((row) => [row.targetId, Number(row.n)]))
  }

  private seal(password: string): { id: string; ciphertext: Buffer } {
    const id = newId()
    try {
      return { id, ciphertext: this.secretProvider.encrypt(id, password) }
    } catch {
      throw new ServiceUnavailableException()
    }
  }

  private async insertAccount(
    tx: { insert: DbHandle['db']['insert'] },
    targetId: string,
    body: CreateTargetAccountBody,
    actor: RequestAccount,
    now: Date,
  ): Promise<string> {
    const id = newId()
    const secret = body.password ? this.seal(body.password) : undefined
    if (secret) {
      await tx.insert(secrets).values({
        id: secret.id,
        provider: LOCAL_SECRET_PROVIDER,
        ciphertext: secret.ciphertext,
        createdAt: now,
        updatedAt: now,
      })
    }
    await tx.insert(targetAccounts).values({
      id,
      targetId,
      displayName: body.displayName,
      username: body.username,
      secretProvider: secret ? LOCAL_SECRET_PROVIDER : null,
      secretId: secret?.id ?? null,
      status: body.status,
      createdAt: now,
      updatedAt: now,
    })
    await this.writeAudit(
      tx,
      actor,
      'target_account.create',
      'target_account',
      id,
      `${body.displayName}（${body.username}）`,
    )
    if (secret) {
      await this.writeAudit(tx, actor, 'target_account.password', 'target_account', id, body.username)
    }
    return id
  }

  private toTarget(
    row: typeof targets.$inferSelect,
    accountCount: number,
  ): TargetDto {
    return targetSchema.parse({
      id: row.id,
      code: row.code,
      name: row.name,
      entryUrl: row.entryUrl,
      loginUrl: row.loginUrl,
      authMethod: row.authMethod,
      captchaMode: row.captchaMode,
      status: row.status,
      loginFields: compactLoginFields((row.loginFields as TargetLoginFields | null) ?? null),
      accountCount,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })
  }

  private toAccount(row: typeof targetAccounts.$inferSelect): TargetAccountDto {
    return targetAccountSchema.parse({
      id: row.id,
      targetId: row.targetId,
      displayName: row.displayName,
      username: row.username,
      hasPassword: Boolean(row.secretId),
      status: row.status,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })
  }

  private async writeAudit(
    tx: { insert: DbHandle['db']['insert'] },
    actor: RequestAccount,
    action: AuditAction,
    resource: string,
    resourceId: string,
    summary: string,
  ): Promise<void> {
    await tx.insert(consoleAuditEvents).values({
      id: newId(),
      actorConsoleAccountId: actor.id,
      action,
      resource,
      resourceId,
      summary,
      createdAt: new Date(),
    })
  }
}
