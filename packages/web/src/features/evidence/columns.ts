export const OPTIONAL_COLUMNS = ['size', 'expires', 'version', 'released'] as const
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]

export const OPTIONAL_COLUMN_LABELS: Record<OptionalColumn, string> = {
  size: '体积',
  expires: '到期时间',
  version: '场景版本',
  released: '对外发布',
}

/**
 * 可选列存在地址里（`columns=size,expires`），刷新和复制链接都能复现；
 * 只认已知列名，其余丢弃。顺序固定为 OPTIONAL_COLUMNS，不随点选顺序变化。
 */
export function parseOptionalColumns(value: string | undefined): OptionalColumn[] {
  const wanted = new Set((value ?? '').split(',').map((item) => item.trim()))
  return OPTIONAL_COLUMNS.filter((column) => wanted.has(column))
}
