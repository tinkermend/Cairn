import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TargetDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetAiActionTrace } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const INHERIT = 'inherit'

export function AiActionTraceCard({ target }: { target: TargetDto }) {
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const override = target.aiActionTrace ?? null
  const mutation = useMutation({
    mutationFn: (mode: 'inherit' | 'off') => updateTargetAiActionTrace(target.id, { mode }),
    onSuccess: async (_target, mode) => {
      toast.success(modeLabel(mode))
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新 AI 动作采集失败')
    },
  })

  return (
    <Card className='min-w-0'>
      <CardHeader>
        <CardTitle className='text-section font-semibold'>AI 动作采集</CardTitle>
        <p className='mt-1 text-label text-muted-foreground'>
          平台开启「记录 AI 动作事实」后，这个系统的 AI 步骤会在动作发出前记录目标候选与值来源，用于评估固化。可以在这里单独关闭；只影响之后新建的运行。
        </p>
      </CardHeader>
      <CardContent>
        <div className='flex items-center justify-between gap-2'>
          <Label htmlFor='target-ai-action-trace'>采集开关</Label>
          <span className='text-label text-muted-foreground'>
            {override === 'off' ? '本目标关闭' : '继承自平台'}
          </span>
        </div>
        <Select
          disabled={!canWrite || mutation.isPending}
          value={override ?? INHERIT}
          onValueChange={(value) => mutation.mutate(value === INHERIT ? 'inherit' : 'off')}
        >
          <SelectTrigger id='target-ai-action-trace' className='w-full' aria-label='AI 动作采集开关'>
            <SelectValue placeholder='继承自平台' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>继承自平台</SelectItem>
            <SelectItem value='off'>本目标关闭</SelectItem>
          </SelectContent>
        </Select>
      </CardContent>
    </Card>
  )
}

function modeLabel(next: 'inherit' | 'off') {
  return next === 'off' ? '已关闭该目标的 AI 动作采集' : '已恢复沿用平台配置'
}
