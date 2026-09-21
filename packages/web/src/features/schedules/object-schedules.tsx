import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ScheduleDto } from '@cairn/shared'
import { CalendarClock } from 'lucide-react'
import { fetchSchedule, fetchSchedules } from '@/lib/schedules-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScheduleEditorDialog, type ScheduleObjectContext } from './editor'
import { ScheduleDetailDialog } from './detail'

export function ObjectSchedules({ context }: { context: ScheduleObjectContext }) {
  const canRead = useCan('schedule:read')
  const [open, setOpen] = useState(false)
  if (!canRead) return null
  return <>
    <Button variant='outline' onClick={() => setOpen(true)}><CalendarClock />定时任务</Button>
    {open ? <ObjectSchedulesDialog context={context} onClose={() => setOpen(false)} /> : null}
  </>
}

function ObjectSchedulesDialog({ context, onClose }: { context: ScheduleObjectContext; onClose: () => void }) {
  const canWrite = useCan('schedule:write')
  const [pages, setPages] = useState<(string | undefined)[]>([undefined])
  const [editing, setEditing] = useState<ScheduleDto | 'new' | null>(null)
  const [detail, setDetail] = useState<ScheduleDto | null>(null)
  const cursor = pages[pages.length - 1]
  const query = useQuery({
    queryKey: ['schedules', 'object', context.targetId, context.type, context.objectId, cursor],
    queryFn: () => fetchSchedules({ targetId: context.targetId, consumerKey: context.type,
      ...(context.type === 'scenario_run' ? { scenarioId: context.objectId } : { suiteId: context.objectId }),
      limit: 10, cursor }),
  })
  // Read the current revision when opening an editor, including plans edited elsewhere.
  const current = useMutation({ mutationFn: fetchSchedule, onSuccess: setEditing })
  return <>
    <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
      <DialogHeader><DialogTitle>{context.name}的定时任务</DialogTitle><DialogDescription>与统一定时任务菜单共用同一计划。执行固定的已发布版本，草稿修改不会自动改变计划。</DialogDescription></DialogHeader>
      {canWrite ? <Button className='justify-self-start' disabled={!context.versionId} onClick={() => setEditing('new')}>新建调度</Button> : null}
      {!context.versionId ? <p className='text-label text-muted-foreground'>请先发布{context.type === 'scenario_run' ? '场景' : '场景集'}，再创建执行计划。</p> : null}
      {query.isPending ? <p role='status'>正在加载调度…</p> : null}
      {query.isError ? <div role='alert'><p>{query.error.message}</p><Button variant='outline' onClick={() => void query.refetch()}>重试</Button></div> : null}
      {query.data?.items.length === 0 ? <p className='text-body text-muted-foreground'>当前对象暂无调度。</p> : null}
      <ul className='grid gap-3'>{query.data?.items.map(schedule => <li className='flex flex-wrap items-center justify-between gap-3 rounded-md border p-3' key={schedule.scheduleId}>
        <div className='min-w-0 flex-1'><p className='break-words font-medium'>{schedule.name}</p><p className='text-label text-muted-foreground'>{schedule.enabled ? '已启用' : '已停用'} · 修订 {schedule.revision}</p></div>
        <div className='flex gap-2'><Button size='sm' variant='outline' onClick={() => setDetail(schedule)}>查看记录</Button>{canWrite ? <Button size='sm' variant='outline' disabled={current.isPending} onClick={() => current.mutate(schedule.scheduleId)}>编辑</Button> : null}</div>
      </li>)}</ul>
      {pages.length > 1 || query.data?.nextCursor ? <div className='flex items-center justify-end gap-2'><Button variant='outline' disabled={pages.length === 1 || query.isFetching} onClick={() => setPages(value => value.slice(0, -1))}>上一页</Button><span className='text-label'>第 {pages.length} 页</span><Button variant='outline' disabled={!query.data?.nextCursor || query.isFetching} onClick={() => setPages(value => [...value, query.data!.nextCursor])}>下一页</Button></div> : null}
      {current.isPending ? <p role='status'>正在读取最新修订…</p> : null}
      {current.isError ? <p role='alert'>{current.error.message}，请重新点击编辑。</p> : null}
    </DialogContent></Dialog>
    {editing ? <ScheduleEditorDialog key={editing === 'new' ? 'new' : editing.scheduleId} open onOpenChange={open => { if (!open) setEditing(null) }} existing={editing === 'new' ? null : editing} context={context} /> : null}
    <ScheduleDetailDialog schedule={detail} onOpenChange={open => { if (!open) setDetail(null) }} />
  </>
}
