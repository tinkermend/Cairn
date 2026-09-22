import { describeAuthIssue, type AccountSessionDetail } from '@cairn/shared'

export function classifyStudioSessionConnect(
  detail: AccountSessionDetail | undefined,
  pendingOperationId?: string | null,
): 'open' | 'failed' | 'pending' {
  if (detail?.session?.status === 'OPEN') return 'open'
  const operation = detail?.currentOperation
  if (pendingOperationId && operation?.id && operation.id !== pendingOperationId) return 'pending'
  if (operation?.status === 'FAILED' || operation?.status === 'CANCELLED') return 'failed'
  return 'pending'
}

export function studioDisconnectedCopy(input: {
  connecting: boolean
  lastAuthError?: string | null
}): { title: string; body: string } {
  if (input.connecting) {
    return {
      title: '正在准备会话',
      body: '正在打开受管浏览器并尝试登录。目标系统打不开时会马上结束，不会空等。',
    }
  }
  const issue = describeAuthIssue(input.lastAuthError)
  if (issue) {
    return {
      title: '画面未连接',
      body: `${issue}。可以再试一次，或到浏览器页查看这次准备的详情。`,
    }
  }
  return {
    title: '画面未连接',
    body: '受管画面连的是目标账号会话，不是试跑录像。连接已准备的会话后即可实时看页、在页面上指认；完整试跑仍用上方试跑。',
  }
}
