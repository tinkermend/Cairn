import type { AuditAction } from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { consoleAuditEvents } from '../schema/audit.js'

/** 审计主体。只带 id——展示用的名字由读取侧 join，不写进事件行。 */
export type AuditActor = { id: string }

/**
 * 写一条控制台审计。
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
