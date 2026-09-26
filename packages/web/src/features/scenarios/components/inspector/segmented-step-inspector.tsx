import {
  type CompileDiagnostic,
  type ExecutableStepType,
  type OutcomeContract,
  type OutputShape,
  type Step,
} from '@cairn/shared'
import { type BindingOption } from '@/features/authoring/document'
import { SectionActionDef } from './section-action-def'
import { SectionDataOutcomes } from './section-data-outcomes'
import { SectionExecutionPolicy } from './section-execution-policy'
import { Info, TriangleAlert } from 'lucide-react'

export interface SegmentedStepInspectorProps {
  step: Step
  index: number
  bindings: BindingOption[]
  shapes: Map<string, OutputShape>
  editableTypes: readonly ExecutableStepType[]
  diagnostics: CompileDiagnostic[]
  disabled?: boolean
  outcomes?: OutcomeContract[]
  consumers?: { id: string; name: string }[]
  onChange: (step: Step) => void
  onOutcomesChange?: (outcomes: OutcomeContract[]) => void
  onRequestTypeChange: (type: ExecutableStepType) => void
}

export function SegmentedStepInspector({
  step,
  index,
  bindings,
  shapes,
  editableTypes,
  diagnostics,
  disabled,
  outcomes,
  consumers,
  onChange,
  onOutcomesChange,
  onRequestTypeChange,
}: SegmentedStepInspectorProps) {
  const ownDiagnostics = (diagnostics ?? []).filter((item) => item.stepId === step.id)

  return (
    <div data-testid='segmented-step-inspector' className='space-y-5'>
      {/* 卡片：纯白表面，三层明度规范 */}
      <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-5'>
        {/* 分区 1：核心动作定义与输入参数 */}
        <SectionActionDef
          step={step}
          index={index}
          bindings={bindings}
          shapes={shapes}
          editableTypes={editableTypes}
          disabled={disabled}
          onChange={onChange}
          onRequestTypeChange={onRequestTypeChange}
        />

        {/* 分区 3：数据流与成功判定 */}
        <SectionDataOutcomes
          step={step}
          disabled={disabled}
          outcomes={outcomes}
          consumers={consumers}
          onChange={onChange}
          onOutcomesChange={onOutcomesChange}
        />

        {/* 分区 4：执行与容错策略（渐进折叠，带 Active Pill 摘要） */}
        <SectionExecutionPolicy
          step={step}
          index={index}
          disabled={disabled}
          onChange={onChange}
        />
      </div>

      {/* 步骤关联编译诊断列表 */}
      {ownDiagnostics.length > 0 && (
        <ul
          id={`studio-step-diagnostics-${step.id}`}
          tabIndex={-1}
          className='space-y-2'
          aria-label='该步骤的编译诊断'
        >
          {ownDiagnostics.map((item, dIndex) => (
            <li
              key={dIndex}
              className={`flex items-start gap-2 rounded-lg border p-3 text-label ${
                item.severity === 'error'
                  ? 'border-status-error/30 bg-status-error/5 text-status-error-foreground'
                  : 'border-status-warning/30 bg-status-warning/5 text-status-warning-foreground'
              }`}
            >
              {item.severity === 'error' ? (
                <TriangleAlert className='size-4 shrink-0 mt-0.5' />
              ) : (
                <Info className='size-4 shrink-0 mt-0.5' />
              )}
              <span className='leading-relaxed'>{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
