import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/status-badge'

export function CatalogName({
  name,
  deleted,
  children,
}: {
  name: string
  deleted?: boolean
  children: ReactNode
}) {
  if (deleted) {
    return (
      <span className='inline-flex flex-wrap items-center gap-1.5'>
        <span>{name}</span>
        <StatusBadge tone='neutral'>已删除</StatusBadge>
      </span>
    )
  }
  return children
}
