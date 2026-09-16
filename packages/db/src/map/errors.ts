import { badRequest, conflict, forbidden, notFound, unavailable } from '../runs/errors.js'

export {
  DomainError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unavailable,
} from '../runs/errors.js'

export function mapWriteClosed(): never {
  throw unavailable('MAP_WRITE_CLOSED', '地图事实写入已关闭')
}

export function mapSchemaUnsupported(version: unknown): never {
  throw badRequest('MAP_SCHEMA_UNSUPPORTED', `不支持的地图事实 Schema 版本：${String(version)}`)
}

export function mapFactTooLarge(): never {
  throw badRequest('MAP_FACT_TOO_LARGE', '地图事实超过 64 KiB')
}

export function mapFactSensitive(): never {
  throw badRequest('MAP_FACT_SENSITIVE_CONTENT', '地图事实含敏感字段，已拒绝入库')
}

export function mapTargetGone(): never {
  throw conflict('MAP_TARGET_GONE', '目标系统已销毁，不能再接收地图事实')
}

export function mapTargetMismatch(message = '地图事实引用了其他目标系统'): never {
  throw badRequest('MAP_TARGET_MISMATCH', message)
}

export function mapSourceUnavailable(message = '地图事实来源不存在或已不可用'): never {
  throw badRequest('MAP_SOURCE_UNAVAILABLE', message)
}

export function mapStaleOwner(): never {
  throw forbidden('MAP_FACT_STALE_OWNER', '运行租约已过期，不能写入新的成功证据')
}

export function mapBaselineUnavailable(): never {
  throw badRequest('MAP_BASELINE_UNAVAILABLE', '基线不存在或正文已不可用，不能伪造完整差分')
}

export function mapIdempotencyConflict(): never {
  throw conflict('MAP_FACT_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的地图事实正文')
}

export function mapFactNotFound(): never {
  throw notFound('MAP_FACT_NOT_FOUND', '地图事实不存在')
}

export function mapReleaseNotFound(): never {
  throw notFound('MAP_RELEASE_NOT_FOUND', '地图封存版本不存在')
}

export function mapProjectionNotFound(): never {
  throw notFound('MAP_PROJECTION_NOT_FOUND', '地图投影不存在')
}

export function mapProjectionStale(): never {
  throw conflict('MAP_PROJECTION_STALE', '投影游标或修订已变更，需要重算')
}

export function mapProjectionFailed(message = '地图投影处理失败'): never {
  throw unavailable('MAP_PROJECTION_FAILED', message)
}

export function mapIdentityStale(): never {
  throw conflict('MAP_IDENTITY_STALE', '身份治理修订已变更')
}

export function mapIdentityConflict(message = '身份治理命令不成立'): never {
  throw conflict('MAP_IDENTITY_CONFLICT', message)
}

export function mapIdentityCycle(): never {
  throw conflict('MAP_IDENTITY_CYCLE', '身份映射形成循环')
}

export function mapSealConflict(message = '地图封存冲突'): never {
  throw conflict('MAP_SEAL_CONFLICT', message)
}

export function mapQueryViewConflict(): never {
  throw badRequest('MAP_QUERY_VIEW_CONFLICT', 'projection 与 release 不能混读')
}

export function mapNotFound(message = '地图对象不存在'): never {
  throw notFound('MAP_NOT_FOUND', message)
}

export function mapForbidden(message = '无权查看该地图来源'): never {
  throw forbidden('MAP_FORBIDDEN', message)
}

export function mapRevisionConflict(message = '地图修订已变更'): never {
  throw conflict('MAP_REVISION_CONFLICT', message)
}

export function mapCommandIdempotencyConflict(): never {
  throw conflict('MAP_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的治理命令')
}

export function mapProjectionPending(message = '地图投影尚未就绪'): never {
  throw conflict('MAP_PROJECTION_PENDING', message)
}

export function mapReleaseInvalid(message = '地图封存版本不能发布'): never {
  throw conflict('MAP_RELEASE_INVALID', message)
}

export function mapReferenceUnresolved(message = '地图引用无法唯一解析'): never {
  throw conflict('MAP_REFERENCE_UNRESOLVED', message)
}

export function mapCursorExpired(): never {
  throw conflict('MAP_CURSOR_EXPIRED', '查询游标已过期，请重新查询')
}

export function mapConsumerUnavailable(message = '没有具备地图消费能力的 Worker'): never {
  throw conflict('MAP_CONSUMER_UNAVAILABLE', message)
}

export function mapConsumptionNotEligible(message = '只读替换尚未取得可校验资格'): never {
  throw conflict('MAP_CONSUMPTION_NOT_ELIGIBLE', message)
}

export function mapReleaseNotPublished(message = '没有已发布的地图版本可供冻结'): never {
  throw badRequest('MAP_RELEASE_NOT_PUBLISHED', message)
}

export function mapReleaseWithdrawn(message = '指定的地图版本已撤回或未发布'): never {
  throw badRequest('MAP_RELEASE_WITHDRAWN', message)
}

export function mapDecisionPersistenceFailed(message = '地图选择事实写入失败'): never {
  throw unavailable('MAP_DECISION_PERSISTENCE_FAILED', message)
}

export function mapAuthPreparationRequired(message = '地图作业需要先准备已核验会话'): never {
  throw conflict('AUTH_PREPARATION_REQUIRED', message)
}

export function mapActiveSliceExists(message = '该目标已有进行中的地图片'): never {
  throw conflict('MAP_ACTIVE_SLICE_EXISTS', message)
}
