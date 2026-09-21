import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  RESOLUTION_CEILING_LABELS,
  RESOLUTION_PREFERENCE_LABELS,
  RESOLUTION_POLICIES,
  type ResolutionPolicy,
  type TargetDto,
  type TargetResolutionPolicyPatch,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetResolutionPolicy } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
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

function inheritLabel(overridden: boolean) {
  return overridden ? '本目标覆盖' : '继承自平台'
}

export function ResolutionPolicyCard({ target }: { target: TargetDto }) {
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const override = target.resolutionPolicy ?? null
  const effective = target.effectiveResolution
  const mutation = useMutation({
    mutationFn: (body: TargetResolutionPolicyPatch) => updateTargetResolutionPolicy(target.id, body),
    onSuccess: async () => {
      toast.success('已更新目标解析策略')
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新目标解析策略失败')
    },
  })

  return (
    <Card className='min-w-0'>
      <CardHeader>
        <CardTitle className='text-section font-semibold'>目标解析</CardTitle>
        <p className='mt-1 text-label text-muted-foreground'>
          这个系统默认先用规则还是先用 AI。不能超过平台的 AI 定位能力上限；未配置时继承平台默认。只影响之后新建的运行。
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='target-resolution-preference'>解析优先顺序</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.preference != null)}
              </span>
            </div>
            <Select
              disabled={!canWrite || mutation.isPending}
              value={override?.preference ?? INHERIT}
              onValueChange={(value) => {
                mutation.mutate({
                  preference: value === INHERIT ? null : (value as ResolutionPolicy),
                })
              }}
            >
              <SelectTrigger id='target-resolution-preference' className='w-full' aria-label='解析优先顺序'>
                <SelectValue placeholder={effective ? RESOLUTION_PREFERENCE_LABELS[effective.preference] : '继承自平台'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  继承自平台{effective ? `（${RESOLUTION_PREFERENCE_LABELS[effective.preference]}）` : ''}
                </SelectItem>
                {RESOLUTION_POLICIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RESOLUTION_PREFERENCE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {override?.preference != null ? (
              <Button
                variant='ghost'
                size='sm'
                disabled={!canWrite}
                onClick={() => mutation.mutate({ preference: null })}
              >
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='target-resolution-ceiling'>该系统解析上限</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.ceiling != null)}
              </span>
            </div>
            <Select
              disabled={!canWrite || mutation.isPending}
              value={override?.ceiling ?? INHERIT}
              onValueChange={(value) => {
                mutation.mutate({
                  ceiling: value === INHERIT ? null : (value as ResolutionPolicy),
                })
              }}
            >
              <SelectTrigger id='target-resolution-ceiling' className='w-full' aria-label='该系统解析上限'>
                <SelectValue placeholder={effective ? RESOLUTION_CEILING_LABELS[effective.ceiling] : '不超过平台上限'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>
                  不超过平台上限{effective ? `（${RESOLUTION_CEILING_LABELS[effective.ceiling]}）` : ''}
                </SelectItem>
                {RESOLUTION_POLICIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {RESOLUTION_CEILING_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-label text-muted-foreground'>
              比平台更宽的选项会被压回平台上限。合规敏感系统可锁为仅规则。
            </p>
            {override?.ceiling != null ? (
              <Button
                variant='ghost'
                size='sm'
                disabled={!canWrite}
                onClick={() => mutation.mutate({ ceiling: null })}
              >
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
