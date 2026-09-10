import { ErrorPage } from '@/components/error-page'

export function NotFoundError() {
  return (
    <ErrorPage
      code='404'
      title='页面不存在'
      description='地址可能已变更或被移除。请返回上一页或回到控制台首页。'
    />
  )
}
