import type { MapSummaryResponse } from '@cairn/shared'

export const MAP_PROJECTION_STATUS_LABELS: Record<MapSummaryResponse['projectionStatus'], string> = {
  missing: '未生成',
  active: '当前生效',
  shadow: '重建中',
  ready: '重建完成待切换',
  failed: '处理失败',
  superseded: '已被替换',
}

export const MAP_LIFECYCLE_LABELS: Record<string, string> = {
  DISCOVERED: '已发现',
  OBSERVED: '已观察',
  VERIFIED: '已验证',
  TRUSTED: '已确认',
  DEGRADED: '已降级',
  STALE: '已过期',
  RETIRED: '已退役',
}

export const MAP_DIMENSION_LABELS: Record<string, string> = {
  identity: '身份',
  locator: '定位',
  action: '动作',
  business: '业务结果',
}

export const MAP_GRADE_LABELS: Record<string, string> = {
  confirmed_reference: '确切引用',
  potential_match: '可能关联',
  unknown_coverage: '覆盖未知',
}
