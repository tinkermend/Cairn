import { NotFoundException } from '@nestjs/common'
import { DomainError, assertTargetPermission, type DbHandle } from '@cairn/db'
import { hasAllPermissions } from '@cairn/shared'
import type { RequestAccount as Actor } from '../../common/request-account'
import type { TargetsService } from '../../targets/targets.service'

export async function requireVisibleTarget(
  actor: Actor,
  targetId: string,
  targets: TargetsService,
  db?: DbHandle,
) {
  if (!hasAllPermissions(actor.permissions, ['target:read'])) {
    throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '没有该目标系统的访问权限，助手不能继续')
  }
  if (db && actor.id) {
    await assertTargetPermission(db, actor.id, targetId, 'target:read')
  }
  try {
    return await targets.getTarget(targetId)
  } catch (error) {
    if (error instanceof NotFoundException) {
      throw new DomainError('not_found', 'TARGET_NOT_FOUND', '目标系统不存在')
    }
    throw error
  }
}
