import { accountAllowsBusiness } from '@cairn/shared'

export function preferredPasswordAccountId(
  items: Array<{ id: string; status: string; hasPassword: boolean; usage?: string }>,
): string {
  const usable = passwordAccounts(items)
  return (
    usable.find((item) => item.hasPassword)?.id ??
    usable[0]?.id ??
    ''
  )
}

export function passwordAccounts<T extends { id: string; status: string; hasPassword: boolean; usage?: string }>(
  items: T[],
) {
  return items.filter((item) => item.status === 'active' && accountAllowsBusiness(item.usage))
}

export type UnusableAccountReason = 'none' | 'disabled' | 'map_only' | 'mixed'

const UNUSABLE_ACCOUNT_COPY: Record<UnusableAccountReason, string> = {
  none: '这个系统还没有登记目标账号。',
  disabled: '这个系统的目标账号都已停用，不能用来跑场景。',
  map_only: '这个系统的账号被标成仅知识采集，不能用来跑场景。',
  mixed: '这个系统的目标账号要么已停用，要么被标成仅知识采集，都不能跑场景。',
}

/**
 * 选择器为空时的真实原因。passwordAccounts 同时滤掉停用账号与仅知识采集账号，
 * 只说其中一种就是在编原因——空态必须按实际构成分支。
 */
export function unusableAccountReason(
  items: Array<{ id: string; status: string; hasPassword: boolean; usage?: string }>,
): UnusableAccountReason | undefined {
  if (passwordAccounts(items).length > 0) return undefined
  if (items.length === 0) return 'none'
  const hasDisabled = items.some((item) => item.status !== 'active')
  const hasMapOnly = items.some((item) => !accountAllowsBusiness(item.usage))
  if (hasDisabled && hasMapOnly) return 'mixed'
  if (hasMapOnly) return 'map_only'
  return 'disabled'
}

export function unusableAccountCopy(reason: UnusableAccountReason): string {
  return UNUSABLE_ACCOUNT_COPY[reason]
}
