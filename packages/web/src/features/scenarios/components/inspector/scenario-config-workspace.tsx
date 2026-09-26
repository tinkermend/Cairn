import { useRef, useState } from 'react'
import type {
  CompileDiagnostic,
  OutcomeContract,
  PlatformConfigDocument,
  RuntimeInvariantContract,
  ScenarioAuthoringDocumentV2,
  ScenarioInputDecl,
  ScenarioOutputDecl,
  TargetResolutionPolicy,
} from '@cairn/shared'
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, FileText, Layers, Settings, Sliders, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { InputsEditor } from '@/features/authoring/step-editor'
import { OutcomeListEditor } from '@/features/authoring/outcome-editor'
import { RuntimeInvariantEditor } from '@/features/authoring/invariant-editor'
import { ScenarioOutputsEditor } from '../../scenario-outputs-editor'
import { ScenarioLocatorSettings } from '../../scenario-locator-settings'
import { ScenarioReportSettings } from '@/features/reports/profiles'
import {
  collectVariableSources,
  documentContextKeysAny,
  outputConsumersAny,
} from '../../studio-document'

export interface ScenarioConfigWorkspaceProps {
  scenarioId: string
  targetId: string
  document: ScenarioAuthoringDocumentV2
  disabled?: boolean
  compileDiagnostics?: CompileDiagnostic[]
  platform?: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  focusedStepIndex?: number
  focusedStepName?: string
  onReturnToSteps: () => void
  onUpdateInputs: (inputs: ScenarioInputDecl[]) => void
  onUpdateOutputs: (outputs: ScenarioOutputDecl | undefined) => void
  onUpdateScenarioOutcomes: (outcomes: OutcomeContract[]) => void
  onUpdateRuntimeInvariants: (invariants: RuntimeInvariantContract[]) => void
  onUpdateDocument: (document: ScenarioAuthoringDocumentV2) => void
}

export type ScenarioPartitionKey = 'inputs' | 'outcomes' | 'outputs' | 'settings'

export function ScenarioConfigWorkspace({
  scenarioId,
  targetId,
  document,
  disabled,
  compileDiagnostics = [],
  platform,
  target,
  focusedStepIndex,
  focusedStepName,
  onReturnToSteps,
  onUpdateInputs,
  onUpdateOutputs,
  onUpdateScenarioOutcomes,
  onUpdateRuntimeInvariants,
  onUpdateDocument,
}: ScenarioConfigWorkspaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<ScenarioPartitionKey>('inputs')

  // 折叠手风琴状态：输入与结果默认展开，标准与高级可折叠
  const [collapsedPartitions, setCollapsedPartitions] = useState<Record<ScenarioPartitionKey, boolean>>({
    inputs: false,
    outcomes: false,
    outputs: false,
    settings: false,
  })

  const togglePartition = (key: ScenarioPartitionKey) => {
    setCollapsedPartitions((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const scrollToPartition = (key: ScenarioPartitionKey) => {
    setActiveTab(key)
    if (collapsedPartitions[key]) {
      setCollapsedPartitions((prev) => ({ ...prev, [key]: false }))
    }
    const el = scrollRef.current?.querySelector(`[data-partition="${key}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const inputsCount = document.inputs.length
  const outcomesCount = (document.scenarioOutcomes?.length ?? 0) + (document.runtimeInvariants?.length ?? 0)
  const outputsCount = (document.outputs?.metrics?.length ?? 0) + (document.outputs?.dataRowFields?.length ?? 0)
  const variableSources = collectVariableSources(document)

  return (
    <div
      data-testid='scenario-config-workspace'
      className='flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-card'
    >
      {/* 顶部固定标题栏与显式返回按钮 */}
      <div className='border-b border-border-divider bg-surface-header p-3 shrink-0 space-y-2.5'>
        <div className='flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2 min-w-0'>
            <div className='flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary'>
              <Layers className='size-4' />
            </div>
            <div className='min-w-0'>
              <div className='flex items-center gap-2'>
                <h3 className='text-body font-semibold text-foreground truncate'>整个场景</h3>
                <span className='rounded bg-primary/10 text-primary px-1.5 py-0.2 text-caption font-medium shrink-0'>
                  场景级契约
                </span>
              </div>
              <p className='text-caption text-muted-foreground truncate'>
                定义对外输入、业务完成标准、最终交付结果与全局运行策略
              </p>
            </div>
          </div>

          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onReturnToSteps}
            className='shrink-0 h-7 px-2.5 text-label gap-1 font-medium hover:bg-muted'
            title='返回步骤检查器'
          >
            <ArrowLeft className='size-3.5' />
            <span>返回步骤编辑</span>
            {focusedStepIndex !== undefined ? (
              <span className='text-caption text-muted-foreground'>
                ({focusedStepIndex + 1})
              </span>
            ) : null}
          </Button>
        </div>

        {/* 粘性分区导航 (Sticky Anchor Tabs) */}
        <div
          className='flex items-center gap-0.5 p-1 bg-surface-subtle rounded-lg border border-border-default/80 text-label'
          role='tablist'
          aria-label='场景配置分区导航'
        >
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'inputs'}
            className={cn(
              'min-w-0 flex-auto whitespace-nowrap py-1 px-1.5 rounded-md font-medium text-caption transition-colors text-center flex items-center justify-center gap-1',
              activeTab === 'inputs'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => scrollToPartition('inputs')}
          >
            <span>运行输入</span>
            {inputsCount > 0 && (
              <span className='inline-flex items-center justify-center px-1.5 text-3xs font-semibold rounded-full bg-primary/15 text-primary'>
                {inputsCount}
              </span>
            )}
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'outcomes'}
            className={cn(
              'min-w-0 flex-auto whitespace-nowrap py-1 px-1.5 rounded-md font-medium text-caption transition-colors text-center flex items-center justify-center gap-1',
              activeTab === 'outcomes'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => scrollToPartition('outcomes')}
          >
            <span>完成标准</span>
            {outcomesCount > 0 && (
              <span className='inline-flex items-center justify-center px-1.5 text-3xs font-semibold rounded-full bg-status-warning/15 text-status-warning-foreground'>
                {outcomesCount}
              </span>
            )}
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'outputs'}
            className={cn(
              'min-w-0 flex-auto whitespace-nowrap py-1 px-1.5 rounded-md font-medium text-caption transition-colors text-center flex items-center justify-center gap-1',
              activeTab === 'outputs'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => scrollToPartition('outputs')}
          >
            <span>最终结果</span>
            {outputsCount > 0 && (
              <span className='inline-flex items-center justify-center px-1.5 text-3xs font-semibold rounded-full bg-primary/15 text-primary'>
                {outputsCount}
              </span>
            )}
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'settings'}
            className={cn(
              'min-w-0 flex-auto whitespace-nowrap py-1 px-1.5 rounded-md font-medium text-caption transition-colors text-center flex items-center justify-center gap-1',
              activeTab === 'settings'
                ? 'bg-card text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => scrollToPartition('settings')}
          >
            <span>高级设置</span>
          </button>
        </div>
      </div>

      {/* 滚动工作区：四大分区 */}
      <div
        ref={scrollRef}
        className='flex-1 min-h-0 space-y-6 overflow-y-auto p-4 pb-28'
        data-testid='scenario-workspace-scroll-area'
      >
        {/* 分区 1：运行输入 */}
        <section
          data-partition='inputs'
          className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'
        >
          <div className='flex items-center justify-between border-b border-border-divider/70 pb-2.5'>
            <div className='flex items-center gap-2'>
              <div className='size-2 rounded-full bg-primary shrink-0' />
              <div>
                <h4 className='text-body font-semibold text-foreground'>运行输入 (Inputs)</h4>
                <p className='text-caption text-muted-foreground'>
                  运行前需要提供的数据参数、必填声明与生成规则
                </p>
              </div>
            </div>
            <button
              type='button'
              onClick={() => togglePartition('inputs')}
              className='text-muted-foreground hover:text-foreground p-1'
              aria-label={collapsedPartitions.inputs ? '展开运行输入' : '折叠运行输入'}
            >
              {collapsedPartitions.inputs ? <ChevronRight className='size-4' /> : <ChevronDown className='size-4' />}
            </button>
          </div>

          {!collapsedPartitions.inputs && (
            <div className='space-y-4'>
              <InputsEditor
                inputs={document.inputs}
                disabled={disabled}
                onChange={onUpdateInputs}
              />

              {/* 输入参数使用情况诊断提示 */}
              {document.inputs.length > 0 && (
                <div className='space-y-2 pt-2 border-t border-border-divider/50'>
                  <span className='text-caption font-medium text-muted-foreground'>参数引用情况：</span>
                  <div className='space-y-1.5'>
                    {document.inputs.map((input) => {
                      const consumers = outputConsumersAny(document, input.key)
                      return (
                        <div
                          key={`input-usage-${input.key}`}
                          className='flex items-center justify-between text-caption px-2.5 py-1.5 rounded bg-surface-subtle border border-border-divider/60'
                        >
                          <span className='font-mono font-medium text-foreground'>{input.key}</span>
                          {consumers.length > 0 ? (
                            <span className='text-muted-foreground'>
                              已在后续 {consumers.length} 步中引用：{consumers.map((c) => c.name).join('、')}
                            </span>
                          ) : (
                            <span className='text-status-warning-foreground'>
                              尚未被任何步骤引用
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 分区 2：完成标准与全局约束 */}
        <section
          data-partition='outcomes'
          className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'
        >
          <div className='flex items-center justify-between border-b border-border-divider/70 pb-2.5'>
            <div className='flex items-center gap-2'>
              <div className='size-2 rounded-full bg-status-warning shrink-0' />
              <div>
                <h4 className='text-body font-semibold text-foreground'>完成标准 (Outcomes)</h4>
                <p className='text-caption text-muted-foreground'>
                  评估整套业务的最终结果（如订单是否真实创建）与执行期全局约束
                </p>
              </div>
            </div>
            <button
              type='button'
              onClick={() => togglePartition('outcomes')}
              className='text-muted-foreground hover:text-foreground p-1'
              aria-label={collapsedPartitions.outcomes ? '展开完成标准' : '折叠完成标准'}
            >
              {collapsedPartitions.outcomes ? <ChevronRight className='size-4' /> : <ChevronDown className='size-4' />}
            </button>
          </div>

          {!collapsedPartitions.outcomes && (
            <div className='space-y-4'>
              <OutcomeListEditor
                outcomes={document.scenarioOutcomes ?? []}
                scope='scenario'
                disabled={disabled}
                onChange={onUpdateScenarioOutcomes}
              />

              <div className='pt-2 border-t border-border-divider/60'>
                <RuntimeInvariantEditor
                  invariants={document.runtimeInvariants ?? []}
                  disabled={disabled}
                  allowEachStepProbe={
                    platform?.document.runtimeInvariants.allowEachStepProbe
                  }
                  onChange={onUpdateRuntimeInvariants}
                />
              </div>
            </div>
          )}
        </section>

        {/* 分区 3：最终结果 */}
        <section
          data-partition='outputs'
          className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'
        >
          <div className='flex items-center justify-between border-b border-border-divider/70 pb-2.5'>
            <div className='flex items-center gap-2'>
              <div className='size-2 rounded-full bg-status-success shrink-0' />
              <div>
                <h4 className='text-body font-semibold text-foreground'>最终结果 (Outputs)</h4>
                <p className='text-caption text-muted-foreground'>
                  运行完成后的业务结论、核心指标与单行宽表交付数据
                </p>
              </div>
            </div>
            <button
              type='button'
              onClick={() => togglePartition('outputs')}
              className='text-muted-foreground hover:text-foreground p-1'
              aria-label={collapsedPartitions.outputs ? '展开最终结果' : '折叠最终结果'}
            >
              {collapsedPartitions.outputs ? <ChevronRight className='size-4' /> : <ChevronDown className='size-4' />}
            </button>
          </div>

          {!collapsedPartitions.outputs && (
            <ScenarioOutputsEditor
              outputs={document.outputs}
              disabled={disabled}
              availableContextKeys={Array.from(documentContextKeysAny(document))}
              variableSources={variableSources}
              onChange={onUpdateOutputs}
            />
          )}
        </section>

        {/* 分区 4：高级设置（定位默认策略与报告配置） */}
        <section
          data-partition='settings'
          className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'
        >
          <div className='flex items-center justify-between border-b border-border-divider/70 pb-2.5'>
            <div className='flex items-center gap-2'>
              <div className='size-2 rounded-full bg-muted-foreground shrink-0' />
              <div>
                <h4 className='text-body font-semibold text-foreground'>高级设置 (Settings)</h4>
                <p className='text-caption text-muted-foreground'>
                  元素定位默认策略与执行报告自动生成配置
                </p>
              </div>
            </div>
            <button
              type='button'
              onClick={() => togglePartition('settings')}
              className='text-muted-foreground hover:text-foreground p-1'
              aria-label={collapsedPartitions.settings ? '展开高级设置' : '折叠高级设置'}
            >
              {collapsedPartitions.settings ? <ChevronRight className='size-4' /> : <ChevronDown className='size-4' />}
            </button>
          </div>

          {!collapsedPartitions.settings && (
            <div className='space-y-6'>
              {/* 定位策略 */}
              <div className='space-y-3'>
                <div className='flex items-center gap-1.5 text-label font-medium text-foreground'>
                  <Sliders className='size-3.5 text-primary' />
                  <span>场景默认定位策略</span>
                </div>
                <ScenarioLocatorSettings
                  document={document}
                  platform={platform}
                  target={target}
                  disabled={disabled}
                  onChange={onUpdateDocument}
                />
              </div>

              {/* 报告设置（独立即时保存） */}
              <div className='space-y-3 pt-4 border-t border-border-divider/60'>
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-1.5 text-label font-medium text-foreground'>
                    <FileText className='size-3.5 text-primary' />
                    <span>执行报告配置</span>
                  </div>
                  <div className='flex items-center gap-1 text-caption text-status-success-foreground bg-status-success/10 px-2 py-0.5 rounded'>
                    <CheckCircle2 className='size-3' />
                    <span>独立 API 即时保存</span>
                  </div>
                </div>
                <p className='text-caption text-muted-foreground'>
                  报告配置独立保存生效，修改后无需通过顶栏「保存草稿」存盘，不污染草稿未保存状态。
                </p>
                <ScenarioReportSettings
                  scenarioId={scenarioId}
                  targetId={targetId}
                />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
