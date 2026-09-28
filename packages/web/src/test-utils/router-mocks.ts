import type { AnchorHTMLAttributes, ReactNode } from 'react'

/** 测试里替身 TanStack Link 的入参：路由相关字段只用于断言，不参与渲染。 */
export type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to?: string
  params?: unknown
  search?: unknown
  children?: ReactNode
}

/** 测试里替身 useAuthStore(selector) 时 selector 收到的最小状态。 */
export type MockAuthState = {
  auth: { user: Partial<import('@/stores/auth-store').AuthUser> | null }
}
