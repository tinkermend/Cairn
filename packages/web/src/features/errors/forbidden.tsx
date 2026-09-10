import { ErrorPage } from '@/components/error-page'

export function ForbiddenError() {
  return (
    <ErrorPage
      code='403'
      title='没有访问权限'
      description='当前账号无权查看此资源。请返回或联系管理员，不要重试无效请求。'
    />
  )
}
