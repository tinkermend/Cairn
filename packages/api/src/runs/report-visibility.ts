import { targetScopeFor, type DbHandle, type TargetScope } from '@cairn/db'
import type { RunDetailDto, RunListResponse } from '@cairn/shared'

function allows(scope: TargetScope, targetId: string): boolean {
  return scope.all || scope.ids.includes(targetId)
}

export async function visibleRunDetail(db: DbHandle, actorId: string, detail: RunDetailDto): Promise<RunDetailDto> {
  const scope = await targetScopeFor(db, actorId, 'report:read')
  if (allows(scope, detail.targetId)) return detail
  const { runReportStatus, reportId, reportError, ...visible } = detail
  return visible
}

export async function visibleRunList(db: DbHandle, actorId: string, result: RunListResponse): Promise<RunListResponse> {
  const scope = await targetScopeFor(db, actorId, 'report:read')
  return {
    ...result,
    items: result.items.map((item) => {
      if (allows(scope, item.targetId)) return item
      const { runReportStatus, reportId, ...visible } = item
      return visible
    }),
  }
}
