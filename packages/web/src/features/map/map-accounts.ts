import { accountAllowsMap, type TargetAccountDto } from '@cairn/shared'

export function mapCapableAccounts(items: TargetAccountDto[]): TargetAccountDto[] {
  return items.filter((item) => item.status === 'active' && accountAllowsMap(item.usage))
}

export const MAP_ACCOUNT_REQUIRED = '请先在目标账号上标记地图用途。'