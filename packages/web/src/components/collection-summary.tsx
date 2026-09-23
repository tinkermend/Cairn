import type { ReactNode } from 'react'

/**
 * 管理页的当前集合摘要，只展示已加载数据，不替代全局统计接口。
 * 冰川蓝外观由共用 CSS / Token 提供，页面只传数据与行为。
 */
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
    <div className='collection-summary-region'>
      <dl className='collection-summary'>
        {items.map((item) => {
          const content = (
            <>
              <dt className='collection-summary-label'>
                {item.label}
                <span aria-hidden='true' className='collection-summary-icon'>
                  {item.icon}
                </span>
              </dt>
              <dd className='collection-summary-value'>{item.value}</dd>
              <dd className='collection-summary-description'>
                {item.description}
              </dd>
            </>
          )
          if (item.onClick) {
            return (
              <button
                key={item.label}
                type='button'
                aria-pressed={item.pressed}
                onClick={item.onClick}
                className='collection-summary-card'
              >
                {content}
              </button>
            )
          }
          return (
            <div key={item.label} className='collection-summary-card'>
              {content}
            </div>
          )
        })}
      </dl>
    </div>
  )
}
