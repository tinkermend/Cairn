import {
  AUDIT_USER_AGENT_MAX,
  entityIdSchema,
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

/** 审计主体。可为 ExecutionActor 或仅带 id 的控制台/服务主体。 */
export type AuditActor = ExecutionActor | { id: string; kind?: 'console' | 'service' }

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
  actor: AuditActor,
  action: AuditAction,
  resource: string,
  resourceId: string | null,
  summary: string,
  client?: AuditClient,
): Promise<void> {
  if (action === 'auth.login') {
    throw new Error('登录事件必须走 recordLoginAudit')
  }
  const isService = actor.kind === 'service'
  const isActorValidUuid = typeof actor.id === 'string' && entityIdSchema.safeParse(actor.id).success
  const credentialId =
    'credentialId' in actor && typeof actor.credentialId === 'string' && entityIdSchema.safeParse(actor.credentialId).success
      ? actor.credentialId
      : null
  const requestId = 'requestId' in actor && typeof actor.requestId === 'string' ? actor.requestId : undefined
  const hasCompleteServiceActor = Boolean(isService && isActorValidUuid && credentialId)

  const { consoleAuditEvents } = schemaFor(tx)
  await tx.insert(consoleAuditEvents).values({
    id: newId(),
    actorConsoleAccountId: !isService && isActorValidUuid ? actor.id : null,
    actorServiceCallerId: hasCompleteServiceActor ? actor.id : null,
    actorServiceCredentialId: hasCompleteServiceActor ? credentialId : null,
    requestId: isService ? requestId : undefined,
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
