export function preferredPasswordAccountId(
  items: Array<{ id: string; status: string; hasPassword: boolean }>,
): string {
  return (
    items.find((item) => item.status === 'active' && item.hasPassword)?.id ??
    items.find((item) => item.status === 'active')?.id ??
    ''
  )
}

export function passwordAccounts(
  items: Array<{ id: string; status: string; hasPassword: boolean }>,
) {
  return items.filter((item) => item.status === 'active')
}
