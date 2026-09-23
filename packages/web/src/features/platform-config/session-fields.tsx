import { PLATFORM_SESSION_REUSE_POLICIES } from '@cairn/shared'
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { SESSION_REUSE_LABELS } from './labels'
import {
  FieldGrid,
  NumberSetting,
  SettingLabel,
  SettingSection,
} from './setting-layout'

export function SessionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='space-y-6'>
      <SettingSection
        title='寿命'
        hint='决定新会话能活多久，以及空闲后是否回收。'
      >
        <FieldGrid>
          <FormField
            name='session.reuse'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='默认页面复用'
                  help='这里只定默认是否沿用当前页面。需要重新打开页面时，在单次运行里操作。'
                />
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
                <FormMessage />
              </FormItem>
            )}
          />
          <NumberSetting
            name='session.idleTtlSeconds'
            label='空闲寿命'
            unit='秒'
            canWrite={canWrite}
          />
          <NumberSetting
            name='session.maxLifetimeSeconds'
            label='最大寿命'
            unit='秒'
            mark='新会话'
            canWrite={canWrite}
            help='必须大于空闲寿命。'
          />
          <FormField
            name='session.reclaim'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='默认回收模式'
                  mark='新会话'
                  help='即便登录仍有效，会话也不会超过最大寿命。'
                />
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
                <FormMessage />
              </FormItem>
            )}
          />
          <NumberSetting
            name='session.keepAliveSeconds'
            label='保活续期'
            unit='秒'
            canWrite={canWrite}
            help='登录状态检查通过后，选择「认证有效即保活」的会话从现在重新计算可保留时间。'
          />
          <NumberSetting
            name='session.authProbeIntervalSeconds'
            label='登录状态检查间隔'
            unit='秒'
            canWrite={canWrite}
            help='选择「认证有效即保活」时，按这个间隔在后台检查登录是否仍有效。须短于保活续期。'
          />
        </FieldGrid>
      </SettingSection>

      <SettingSection
        title='账号与回收'
        hint='同一账号默认只开一台浏览器。'
      >
        <FieldGrid>
          <FormField
            name='session.accountSessionMode'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='账号会话'
                  help='允许多开后，仍要在每个账号上单独提高同时在线数。每台浏览器各自登录，不共用登录状态。'
                />
                <Select
                  disabled={!canWrite}
                  value={field.value ?? 'exclusive'}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value='exclusive'>一账号一台浏览器</SelectItem>
                    <SelectItem value='concurrent'>允许同账号多开</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='session.lostDisposition'
            render={({ field }) => (
              <FormItem>
                <SettingLabel
                  label='失联处置'
                  help='执行节点中断后，默认仍要人工确认。自动让路只会放开这个账号的占用，不能保证原来的浏览器已经退出。'
                />
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
                <FormMessage />
              </FormItem>
            )}
          />
          <NumberSetting
            name='session.evictionPriority'
            label='会话回收优先级'
            canWrite={canWrite}
            help='浏览器名额不够时，数值越小越先被关掉。空闲会话仍比保活会话更先回收。'
          />
          <NumberSetting
            name='session.authWaitSeconds'
            label='人工认证等待'
            unit='秒'
            canWrite={canWrite}
          />
          <NumberSetting
            name='sessionScheduling.profileAffinityWaitSeconds'
            label='原节点优先等待'
            unit='秒'
            mark='实时'
            canWrite={canWrite}
            help='原来的执行节点仍可用时，其他节点要等满这段时间才能接手。修改后，后续分配立即按新值执行。'
          />
          <NumberSetting
            name='sessionScheduling.operationQueueTimeoutSeconds'
            label='维护操作排队期限'
            unit='秒'
            mark='冻结'
            canWrite={canWrite}
            help='提交维护请求时就确定期限。已经排队的操作不会因这次修改而改变。'
          />
        </FieldGrid>
      </SettingSection>

      <SettingSection
        title='认证等待'
        hint='标为「冻结」的项在运行创建时确定，已经开始的运行不会改。'
      >
        <FieldGrid>
          <NumberSetting
            name='sessionAuth.freshnessSecondsDefault'
            label='默认核验新鲜度'
            unit='秒'
            mark='冻结'
            canWrite={canWrite}
            help='新运行创建时确定。已经开始的运行不改。'
          />
          <NumberSetting
            name='sessionAuth.freshnessSecondsMin'
            label='新鲜度下限'
            unit='秒'
            canWrite={canWrite}
            help='如果已发布的目标系统超出新的范围，这次保存会被拒绝。'
          />
          <NumberSetting
            name='sessionAuth.freshnessSecondsMax'
            label='新鲜度上限'
            unit='秒'
            canWrite={canWrite}
          />
          <NumberSetting
            name='sessionRetention.maxRetainSeconds'
            label='单次人工保留上限'
            unit='秒'
            mark='实时'
            canWrite={canWrite}
            help='只限制人工保留，不影响按策略自动保活。新的保留和延长按当前值检查；已经确定的截止时间不会被缩短。'
          />
          <NumberSetting
            name='sessionRetention.reservedFreeSlotsPerWorker'
            label='每节点预留空闲位'
            canWrite={canWrite}
            help='只用于人工保留。可保留名额等于该节点登记的会话上限减去这里的值。结果不大于 0 的节点不接受人工保留。'
          />
          <NumberSetting
            name='sessionRetention.maintenanceIntervalSeconds'
            label='保留会话后台核验间隔'
            unit='秒'
            canWrite={canWrite}
            help='人工保留的会话，默认按这个间隔在后台检查登录。选择「认证有效即保活」的会话使用它自己的检查间隔。'
          />
          <NumberSetting
            name='sessionRetention.renewBeforeSeconds'
            label='到期前提前续登'
            unit='秒'
            canWrite={canWrite}
          />
          <NumberSetting
            name='runAuthRecovery.maxAutoRecoveriesPerRun'
            label='每次运行自动登录恢复次数'
            mark='冻结'
            canWrite={canWrite}
            help='运行创建时确定。填 0 表示不自动重新登录。'
          />
          <NumberSetting
            name='runAuthRecovery.maxManualRecoveriesPerRun'
            label='每次运行人工认证恢复次数'
            mark='冻结'
            canWrite={canWrite}
            help='运行创建时确定。填 0 表示不转给人工处理。'
          />
        </FieldGrid>
      </SettingSection>

      <SettingSection
        title='登录与验证码'
        hint='标为「实时」的项马上作用于下一次登录，不改变已经开始的运行。'
      >
        <FieldGrid>
          <MsSecondsField
            name='sessionAuth.loginLeaveTimeoutMs'
            label='提交后等待离开登录页'
            canWrite={canWrite}
            min={1}
            step={1}
            help='目标系统没有单独填写时使用这里的值，不得大于自动登录的超时。页面跳得慢时，请在该目标上加大。'
          />
          <MsSecondsField
            name='sessionAuth.landingSettleBudgetMs'
            label='登录后关闭引导的时间'
            canWrite={canWrite}
            min={1}
            step={1}
            help='登录成功后，用来关掉欢迎页和引导层的总时间。整理失败不会让登录失败。不得大于自动登录的超时。'
          />
          <MsSecondsField
            name='sessionAuth.landingSettleWatchMs'
            label='引导层出现等待'
            canWrite={canWrite}
            min={0}
            step={0.1}
            decimal
            help='进入页面后再等一段时间，以便关掉延迟出现的欢迎层。必须短于登录后关闭引导的时间。'
          />
          <NumberSetting
            name='sessionAuth.landingSettleMaxDismissals'
            label='一次最多关闭引导层'
            mark='实时'
            canWrite={canWrite}
            min={1}
            max={8}
            help='只会点关闭、跳过一类按钮，不会代点同意或开始体验。'
          />
          <NumberSetting
            name='sessionAuth.autoLoginMaxPerWindow'
            label='时段内自动登录次数'
            mark='实时'
            canWrite={canWrite}
            help='同一账号在一个统计时段内最多自动登录这么多次。用尽后会暂停，时段结束或这个账号的配置有变化后重新计数。'
          />
          <NumberSetting
            name='sessionAuth.captchaMaxAttempts'
            label='验证码机器尝试次数'
            mark='实时'
            canWrite={canWrite}
            help='登录前和会话维护时立即生效，不必重启执行节点。允许 1 到 5 次。'
          />
          <NumberSetting
            name='sessionAuth.captchaSolveTimeoutMs'
            label='验证码求解超时'
            unit='毫秒'
            mark='实时'
            canWrite={canWrite}
            help='机器识别一次验证码的最长时间。'
          />
          <NumberSetting
            name='sessionAuth.captchaHumanWaitSeconds'
            label='验证码人工接管等待'
            unit='秒'
            mark='实时'
            canWrite={canWrite}
            help='机器尝试用完后，留给人工处理验证码的时间。不影响普通的人工认证等待。'
          />
          <NumberSetting
            name='sessionAuth.sliderDragMinDurationMs'
            label='滑块拖动最短时间'
            unit='毫秒'
            mark='实时'
            canWrite={canWrite}
            help='拖动滑块验证码至少用这么久，避免拖得过快被目标系统拒绝。'
          />
          <NumberSetting
            name='sessionAuth.sliderDragMaxDurationMs'
            label='滑块拖动最长时间'
            unit='毫秒'
            mark='实时'
            canWrite={canWrite}
            help='拖动滑块验证码最多用这么久，须不短于最短时间。'
          />
        </FieldGrid>
      </SettingSection>
    </div>
  )
}

function MsSecondsField({
  name,
  label,
  help,
  canWrite,
  min,
  step,
  decimal,
}: {
  name:
    | 'sessionAuth.loginLeaveTimeoutMs'
    | 'sessionAuth.landingSettleBudgetMs'
    | 'sessionAuth.landingSettleWatchMs'
  label: string
  help: string
  canWrite: boolean
  min: number
  step: number
  decimal?: boolean
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <SettingLabel label={label} unit='秒' mark='实时' help={help} />
          <FormControl>
            <Input
              type='number'
              min={min}
              step={step}
              disabled={!canWrite}
              value={
                typeof field.value === 'number' &&
                (decimal ? field.value >= 0 : field.value > 0)
                  ? decimal
                    ? String(field.value / 1000)
                    : Math.round(field.value / 1000)
                  : ''
              }
              onChange={(event) => {
                const seconds = Number(event.target.value)
                field.onChange(
                  Number.isFinite(seconds)
                    ? decimal
                      ? Math.round(seconds * 1000)
                      : Math.round(seconds) * 1000
                    : field.value
                )
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
