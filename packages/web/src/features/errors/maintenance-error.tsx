import { Button } from '@/components/ui/button'
import { ErrorPage } from '@/components/error-page'

export function MaintenanceError() {
  return (
    <ErrorPage
      code='503'
      title='系统维护中'
      description='控制台暂时不可用，请稍后再试。已打开的页面数据不会作为最新结果。'
      actions={
        <div className='mt-4'>
          <Button variant='outline'>了解更多</Button>
        </div>
      }
    />
  )
}
