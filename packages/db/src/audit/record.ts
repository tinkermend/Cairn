import {
  AUDIT_USER_AGENT_MAX,
  executionActorSchema,
  normalizeLoginIdentifier,
  type ExecutionActor,
  type AuditAction,
  type AuditClient,
  type LoginFailureReason,
  type LoginAuditOutcome,
} from '@cairn/shared'
import { schemaFor } from '../native.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'

/** 审计主体。只带 id——展示用的名字由读取侧 join，不写进事件行。 */
export type AuditActor = { id: string }

export type LoginAuditWrite = {
  identifier: string
  outcome: LoginAuditOutcome
  failureReason?: LoginFailureReason | null
  accountId?: string | null
  client?: AuditClient
}

function clientFields(client?: AuditClient) {
  const userAgent = client?.userAgent?.trim()
  return {
    clientIp: client?.ip?.trim() || null,
    userAgent: userAgent ? userAgent.slice(0, AUDIT_USER_AGENT_MAX) : null,
    clientKind: client?.kind ?? (client ? 'web' : null),
  }
}

/**
 * 写一条控制台操作审计。
 *
 * 必须与它所记录的事实**同事务**调用——审计行先于或后于事实落地都会说谎。
 */
export async function recordAudit(
  tx: Db,
  actor: ExecutionActor,
  action: AuditAction,
  resource: string,
  resourceId: string | null,
  summary: string,
  client?: AuditClient,
): Promise<void> {
  if (action === 'auth.login') {
    throw new Error('登录事件必须走 recordLoginAudit')
  }
  actor = executionActorSchema.parse(actor)
  const { consoleAuditEvents } = schemaFor(tx)
  await tx.insert(consoleAuditEvents).values({
    id: newId(),
    actorConsoleAccountId: actor.kind === 'service' ? null : actor.id,
    actorServiceCallerId: actor.kind === 'service' ? actor.id : null,
    actorServiceCredentialId: actor.kind === 'service' ? actor.credentialId : null,
    requestId: actor.kind === 'service' ? actor.requestId : undefined,
    action,
    resource,
    resourceId,
    summary,
    category: 'operation',
    loginIdentifier: null,
    outcome: null,
    failureReason: null,
    ...clientFields(client),
    createdAt: new Date(),
  })
}

export async function recordLoginAudit(tx: Db, input: LoginAuditWrite): Promise<void> {
  const identifier = normalizeLoginIdentifier(input.identifier).slice(0, 64)
  if (!identifier) throw new Error('登录审计缺少登录名')
  if (input.outcome === 'success') {
    if (input.failureReason) throw new Error('成功登录不得带失败原因')
    if (!input.accountId) throw new Error('成功登录必须关联账号')
  } else {
    if (!input.failureReason) throw new Error('失败登录必须带失败原因')
    if (input.failureReason === 'unknown_account' && input.accountId) {
      throw new Error('未知账号不得关联 actor')
    }
    if (input.failureReason !== 'unknown_account' && !input.accountId) {
      throw new Error('已知账号失败必须关联 actor')
    }
  }

  const accountId = input.accountId ?? null
  const { consoleAuditEvents } = schemaFor(tx)
  await tx.insert(consoleAuditEvents).values({
    id: newId(),
    actorConsoleAccountId: accountId,
    action: 'auth.login',
    resource: 'auth',
    resourceId: accountId,
    summary: input.outcome === 'success' ? '登录成功' : '登录失败',
    category: 'login',
    loginIdentifier: identifier,
    outcome: input.outcome,
    failureReason: input.failureReason ?? null,
    ...clientFields(input.client),
    createdAt: new Date(),
  })
}
