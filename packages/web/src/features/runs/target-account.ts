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
