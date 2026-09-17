import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export function ExecutionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <FormField
        name='mapScheduledRefreshEnabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 md:col-span-2'>
            <div>
              <FormLabel>开放地图自动复查</FormLabel>
              <FormDescription>
                出厂关闭。打开后 Worker
                才会物化到期窗口；已保存的计划不会补跑错过的窗口。
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        name='moduleFallback.enabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 md:col-span-2'>
            <div>
              <FormLabel>开放动作模块冻结回退</FormLabel>
              <FormDescription>
                出厂关闭。未完成独立评价前不要对业务打开；打开后也只能用于只读模块的冻结候选。
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        name='runtimeInvariants.allowEachStepProbe'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 md:col-span-2'>
            <div>
              <FormLabel>允许每步探测错误弹窗</FormLabel>
              <FormDescription>
                出厂关闭。打开后仍须在场景里显式选择「每一步后探测」；已开始的运行以快照为准。
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        name='mapExplorationEnabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 md:col-span-2'>
            <div>
              <FormLabel>开放有界地图探索</FormLabel>
              <FormDescription>
                出厂关闭。打开后仍需每个目标单独开启探索政策，且不会自动升可信。
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        name='execution.defaultTimeoutMs'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认步骤超时（ms）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              未写超时的步骤继承此值。单次运行或步骤仍可覆盖。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormItem>
        <FormLabel>默认自动重试</FormLabel>
        <p className='text-body'>0，不可改</p>
        <FormDescription>
          平台默认重试保持关闭。AI Action 即使步骤未写重试也不会自动重试。
        </FormDescription>
      </FormItem>
      <FormField
        name='moduleResolver.maxCandidates'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块映射候选上限</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              编写期按说法查找时最多返回的候选数。立即生效。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleResolver.aiCandidateLimit'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块映射 AI 候选上限</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              预留给 AI 层；当前未开放，不调用模型。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleResolver.logRetentionDays'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块映射记录保留天数</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              过期记录按创建时间清理，不影响已写入草稿的调用。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleQuality.windowDays'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块质量窗口（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              只允许 7 或 30。立即生效，不改变执行。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleQuality.minSamples'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块质量最少样本</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              少于此数只显示样本不足，不给百分比。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleQuality.degradedVerifiedRateBelow'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块降级通过率阈值</FormLabel>
            <FormControl>
              <Input
                type='number'
                step='0.01'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              正式运行通过率低于此值标为降级，只作提示。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='moduleQuality.recentFailureStreak'
        render={({ field }) => (
          <FormItem>
            <FormLabel>模块连续失败次数</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              最近连续这么多次模块归因失败也标降级。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}
