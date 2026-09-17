import type { ReactNode } from 'react'

/** 管理页的当前集合摘要。只展示已加载数据，不替代全局统计接口。 */
export function CollectionSummary({
  items,
}: {
  items: {
    label: string
    value: number
    description: string
    icon: ReactNode
    onClick?: () => void
    pressed?: boolean
  }[]
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {items.map((item) => {
        const content = (
          <>
            <dt className="flex items-center justify-between gap-2 text-small text-muted-foreground">
              {item.label}
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle"
              >
                {item.icon}
              </span>
            </dt>
            <dd className="mt-1 text-stat font-semibold tabular-nums">{item.value}</dd>
            <dd className="mt-1 text-label text-muted-foreground">{item.description}</dd>
          </>
        )
        if (item.onClick) {
          return (
            <button
              key={item.label}
              type="button"
              aria-pressed={item.pressed}
              onClick={item.onClick}
              className="min-w-0 rounded-lg border border-border-card bg-card p-4 text-left shadow-card focus-visible:outline-2 focus-visible:outline-ring"
            >
              {content}
            </button>
          )
        }
        return (
          <div key={item.label} className="min-w-0 rounded-lg border border-border-card bg-card p-4 shadow-card">
            {content}
          </div>
        )
      })}
    </dl>
  )
}
