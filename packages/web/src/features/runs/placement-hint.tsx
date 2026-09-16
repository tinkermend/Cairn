import { Link } from '@tanstack/react-router'
import type { RunPlacement } from '@cairn/shared'
import { PLACEMENT_COPY, WAIT_REASON_COPY } from './labels'

export function PlacementHint({
  placement,
  targetId,
  accountId,
}: {
  placement: RunPlacement
  targetId?: string | null
  accountId?: string | null
}) {
  if (placement.state === 'not_applicable' || placement.state === 'claimed' || placement.state === 'claimable') {
    return null
  }
  const copy =
    placement.waitReason != null ? WAIT_REASON_COPY[placement.waitReason] : PLACEMENT_COPY[placement.state]
  if (!copy) return null
  return (
    <p
      className={
        placement.state === 'session_lost' || placement.waitReason === 'SESSION_LOST'
          ? 'mt-2 text-body text-status-warning-foreground'
          : 'mt-2 text-body text-muted-foreground'
      }
    >
      {copy}
      {placement.sessionId && targetId && accountId ? (
        <>
          {' '}
          会话{' '}
          <Link className='underline' to='/sessions/$targetId/$accountId' params={{ targetId, accountId }}>
            {placement.sessionId}
          </Link>
        </>
      ) : placement.sessionId ? (
        ` 会话 ${placement.sessionId}`
      ) : (
        ''
      )}
      {placement.generation ? ` · 代次 ${placement.generation}` : ''}
      {placement.ownerWorkerId ? ` · Worker ${placement.ownerWorkerId}` : ''}
      {placement.acquireReason === 'created' ? ' · 新建会话' : null}
      {placement.acquireReason === 'reused' ? ' · 复用会话' : null}
      {placement.profileFallback ? ' · 需要重新登录' : null}
      {placement.occupyingRunId ? (
        <>
          {' '}
          · 占用运行{' '}
          <Link className='underline' to='/runs/$runId' params={{ runId: placement.occupyingRunId }}>
            {placement.occupyingRunId}
          </Link>
        </>
      ) : null}
      {placement.occupyingOperationId ? ` · 占用操作 ${placement.occupyingOperationId}` : ''}
      {placement.profileAffinityUntil
        ? ` · 放开时刻 ${new Date(placement.profileAffinityUntil).toLocaleString()}`
        : ''}
    </p>
  )
}
