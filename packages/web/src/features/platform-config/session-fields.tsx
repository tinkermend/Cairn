import { PLATFORM_SESSION_REUSE_POLICIES } from '@cairn/shared'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SESSION_REUSE_LABELS } from './labels'

export function SessionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <FormField
        name='session.reuse'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认页面复用</FormLabel>
            <Select
              disabled={!canWrite}
              value={field.value ?? ''}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {PLATFORM_SESSION_REUSE_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {SESSION_REUSE_LABELS[policy]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              重建会话仍是单次运行操作，不作为平台默认。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.idleTtlSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>空闲寿命（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.maxLifetimeSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>最大寿命（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>必须大于空闲寿命。只影响新会话。</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.reclaim'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认回收模式</FormLabel>
            <Select
              disabled={!canWrite}
              value={field.value ?? 'IDLE'}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value='IDLE'>按空闲回收</SelectItem>
                <SelectItem value='AUTH_DRIVEN'>认证有效即保活</SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              只影响新会话。认证保活仍受最大寿命约束。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.keepAliveSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>保活续期（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              认证核验通过后，AUTH_DRIVEN 会话从当下重新计算保活截止。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.authProbeIntervalSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>兜底巡检间隔（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              AUTH_DRIVEN 会话用该间隔排后台核验；须小于保活续期。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.lostDisposition'
        render={({ field }) => (
          <FormItem>
            <FormLabel>失联处置</FormLabel>
            <Select
              disabled={!canWrite}
              value={field.value ?? 'MANUAL'}
              onValueChange={field.onChange}
            >
              <FormControl>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value='MANUAL'>失联后需人工处置</SelectItem>
                <SelectItem value='AUTO'>失联后自动让路</SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              执行节点崩溃换代后，默认仍等人点「处置失联」。自动让路只释放账本键，不能证明旧浏览器已退出。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.evictionPriority'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认驱逐优先级</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              容量不足时数值越小越先被驱逐；空闲策略仍优先于保活会话。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.authWaitSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>人工认证等待（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionScheduling.profileAffinityWaitSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>Profile 亲和等待（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              原节点 READY
              时，其他节点要等满这段时间才能接手。修改后立即影响后续领取。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionScheduling.operationQueueTimeoutSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>维护操作排队期限（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              请求时冻结，已排队操作的期限不随这次修改变化。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.freshnessSecondsDefault'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认核验新鲜度（秒，冻结）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              新 Run 写入快照；已开跑的 Run 不改。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.freshnessSecondsMin'
        render={({ field }) => (
          <FormItem>
            <FormLabel>新鲜度下限（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              收窄后若已发布 Target 越界，保存会被拒绝。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.freshnessSecondsMax'
        render={({ field }) => (
          <FormItem>
            <FormLabel>新鲜度上限（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionRetention.maxRetainSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>单次人工保留上限（秒，实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              仅约束人工保留意图，不约束策略保活。新的设置／延长按当前值校验；已写下的截止不回溯缩短。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionRetention.reservedFreeSlotsPerWorker'
        render={({ field }) => (
          <FormItem>
            <FormLabel>每节点预留空闲位</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              仅约束人工保留。保留配额 = 登记的 max_sessions − 该值。结果 ≤ 0
              的节点不接受人工保留。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionRetention.maintenanceIntervalSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>保留会话后台核验间隔（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              人工保留会话的缺省排程间隔。AUTH_DRIVEN 会话用自己冻结的巡检间隔。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionRetention.renewBeforeSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>到期前提前续登（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='runAuthRecovery.maxAutoRecoveriesPerRun'
        render={({ field }) => (
          <FormItem>
            <FormLabel>每 Run 自动登录恢复次数</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              创建 Run 时冻结；改值不回溯在途运行。0 表示不自动恢复。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='runAuthRecovery.maxManualRecoveriesPerRun'
        render={({ field }) => (
          <FormItem>
            <FormLabel>每 Run 人工认证恢复次数</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              创建 Run 时冻结；改值不回溯在途运行。0 表示不进入人工恢复。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.autoLoginMaxPerWindow'
        render={({ field }) => (
          <FormItem>
            <FormLabel>窗口内自动登录次数（实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              立即作用于下一次自动登录判定，不冻结进 Run。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.captchaMaxAttempts'
        render={({ field }) => (
          <FormItem>
            <FormLabel>验证码机器尝试次数（实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              开跑前与会话维护立即生效，无需重启 Worker。1–5 次。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.captchaSolveTimeoutMs'
        render={({ field }) => (
          <FormItem>
            <FormLabel>验证码求解超时（毫秒，实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.captchaHumanWaitSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>验证码人工接管等待（秒，实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>
              机器预算耗尽后 AUTH_WAIT 防抢占期限。只影响验证码熔断，不改普通认证等待。
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.sliderDragMinDurationMs'
        render={({ field }) => (
          <FormItem>
            <FormLabel>滑块拖拽最短耗时（毫秒，实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='sessionAuth.sliderDragMaxDurationMs'
        render={({ field }) => (
          <FormItem>
            <FormLabel>滑块拖拽最长耗时（毫秒，实时）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}
