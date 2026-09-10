import { ErrorPage } from '@/components/error-page'

export function UnauthorisedError() {
  return (
    <ErrorPage
      code='401'
      title='需要登录'
      description='请使用有权限的控制台账号登录后再访问此页面。'
    />
  )
}
