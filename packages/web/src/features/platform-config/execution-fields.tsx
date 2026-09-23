import { FormField } from '@/components/ui/form'
import {
  FieldGrid,
  NumberSetting,
  SettingSection,
  SwitchGrid,
  SwitchRow,
} from './setting-layout'

export function ExecutionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='space-y-6'>
      <SettingSection
        title='调度'
        hint='关闭时已保存的计划仍可查看，不会自动触发。'
      >
        <SwitchGrid>
          <FormField
            name='mapScheduledRefreshEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放知识地图定时采集'
                help='按计划访问已登记的系统，采集最新页面情况。错过的时间不会补跑。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='scenarioScheduledRunEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放场景定时执行'
                help='与知识地图采集互不影响。关闭后，已保存的计划仍可查看和检查，但不会自动执行。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='suiteScheduledRunEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放场景集定时执行'
                help='到点只创建一次集合运行。其中的场景仍遵守该集合的失败处理和截止时间。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </SwitchGrid>
      </SettingSection>

      <SettingSection
        title='能力开关'
        hint='打开后仍受场景或目标上的单独选择约束。'
      >
        <SwitchGrid>
          <FormField
            name='knowledgeAnalysisEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放知识分析'
                help='只生成待确认的知识，不会直接发布术语，也不会修改已经发布的地图。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='moduleFallback.enabled'
            render={({ field }) => (
              <SwitchRow
                label='开放动作模块冻结回退'
                help='只作为只读动作的备用方案。'
                warning='未经单独评估，不要在正式业务中打开。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='runtimeInvariants.allowEachStepProbe'
            render={({ field }) => (
              <SwitchRow
                label='允许每步探测错误弹窗'
                help='已经开始的运行仍按开始时的配置执行。'
                warning='还须在场景里选择「每一步后探测」才会生效。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='mapExplorationEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放有界地图探索'
                help='每个目标系统仍要单独允许探索，探索结果不会自动标为可信。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <FormField
            name='fixtureStepsEnabled'
            render={({ field }) => (
              <SwitchRow
                label='开放调试夹具步骤'
                help='这些步骤不访问目标系统，只用来检查编排能否跑通。成败仍会计入运行总览。'
                warning='成败会计入运行总览，只在排查编排时打开。'
                checked={field.value}
                disabled={!canWrite}
                onCheckedChange={field.onChange}
              />
            )}
          />
        </SwitchGrid>
      </SettingSection>

      <SettingSection title='步骤默认'>
        <FieldGrid>
          <NumberSetting
            name='execution.defaultTimeoutMs'
            label='默认步骤超时'
            unit='ms'
            canWrite={canWrite}
            help='没有单独写超时的步骤使用这里的值，单次运行或单个步骤仍可另行指定。平台不会自动重试。AI 请求的超时必须短于该步骤的超时。'
          />
        </FieldGrid>
      </SettingSection>

      <SettingSection
        title='模块映射'
        hint='只影响编写场景时的查找，不改变正在执行的步骤。'
      >
        <FieldGrid>
          <NumberSetting
            name='moduleResolver.maxCandidates'
            label='模块映射候选上限'
            canWrite={canWrite}
            help='编写场景时，按步骤描述匹配动作，最多返回这么多条。保存后立即生效。'
          />
          <NumberSetting
            name='moduleResolver.aiCandidateLimit'
            label='模块映射 AI 候选上限'
            mark='未开放'
            canWrite={canWrite}
            disabled
            help='预留项，当前不会调用模型。'
          />
          <NumberSetting
            name='moduleResolver.logRetentionDays'
            label='模块映射记录保留天数'
            unit='天'
            canWrite={canWrite}
            help='过期记录按创建时间清理，已经写进草稿的调用不受影响。'
          />
        </FieldGrid>
      </SettingSection>

      <SettingSection title='模块质量' hint='只作提示，不改变执行。'>
        <FieldGrid>
          <NumberSetting
            name='moduleQuality.windowDays'
            label='模块质量窗口'
            unit='天'
            canWrite={canWrite}
            help='只能填 7 或 30。保存后立即生效，不改变步骤怎么执行。'
          />
          <NumberSetting
            name='moduleQuality.minSamples'
            label='模块质量最少样本'
            canWrite={canWrite}
            help='样本少于此数时，只提示样本不足，不显示百分比。'
          />
          <NumberSetting
            name='moduleQuality.degradedVerifiedRateBelow'
            label='模块降级通过率阈值'
            step='0.01'
            canWrite={canWrite}
            help='正式运行的通过率低于此值时标为降级，只作提示，不拦截执行。'
          />
          <NumberSetting
            name='moduleQuality.recentFailureStreak'
            label='模块连续失败次数'
            canWrite={canWrite}
            help='最近连续失败达到这个次数时，也会标为降级。'
          />
        </FieldGrid>
      </SettingSection>
    </div>
  )
}
