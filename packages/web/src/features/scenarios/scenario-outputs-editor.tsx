import { useMemo } from 'react'
import type { ScenarioDataRowFieldDecl, ScenarioMetricDecl, ScenarioOutputDecl } from '@cairn/shared'
import { Plus, Trash2, TrendingUp, Table, FileText, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type ScenarioOutputsEditorProps = {
  outputs?: ScenarioOutputDecl
  disabled?: boolean
  availableContextKeys?: string[]
  onChange: (outputs: ScenarioOutputDecl | undefined) => void
}

export function ScenarioOutputsEditor({
  outputs,
  disabled,
  availableContextKeys,
  onChange,
}: ScenarioOutputsEditorProps) {
  const current: ScenarioOutputDecl = outputs ?? {
    metrics: [],
    dataRowFields: [],
  }

  const candidateKeys = useMemo(() => {
    return Array.from(
      new Set([
        ...(availableContextKeys ?? []),
        ...(current.metrics ?? []).map((m) => m.key).filter(Boolean),
        ...(current.metrics ?? []).map((m) => m.fromContextKey).filter(Boolean),
      ]),
    )
  }, [availableContextKeys, current.metrics])

  const simulatedSummary = useMemo(() => {
    if (!current.summaryTemplate) return null
    return current.summaryTemplate.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
      const metric = (current.metrics ?? []).find((m) => m.key === key)
      if (metric) {
        return `1,420${metric.unit ? ` ${metric.unit}` : ''}`
      }
      return `[${key}]`
    })
  }, [current.summaryTemplate, current.metrics])

  const insertVariable = (key: string) => {
    const varTag = `\${${key}}`
    const existing = current.summaryTemplate ?? ''
    const nextVal = existing ? `${existing.trim()} ${varTag}` : varTag
    handleUpdate({ summaryTemplate: nextVal })
  }

  const handleUpdate = (patch: Partial<ScenarioOutputDecl>) => {
    const updated: ScenarioOutputDecl = {
      ...current,
      ...patch,
    }
    // 若所有配置均为空，则清理为 undefined
    if (
      !updated.summaryTemplate &&
      !updated.summaryFromContextKey &&
      (!updated.metrics || updated.metrics.length === 0) &&
      (!updated.dataRowFields || updated.dataRowFields.length === 0)
    ) {
      onChange(undefined)
    } else {
      onChange(updated)
    }
  }

  const addMetric = () => {
    const idx = (current.metrics?.length ?? 0) + 1
    const nextMetrics: ScenarioMetricDecl[] = [
      ...(current.metrics ?? []),
      {
        key: `metric_${idx}`,
        name: `指标 ${idx}`,
        fromContextKey: '',
      },
    ]
    handleUpdate({ metrics: nextMetrics })
  }

  const updateMetric = (index: number, patch: Partial<ScenarioMetricDecl>) => {
    const list = [...(current.metrics ?? [])]
    if (list[index]) {
      list[index] = { ...list[index], ...patch }
      handleUpdate({ metrics: list })
    }
  }

  const removeMetric = (index: number) => {
    const list = (current.metrics ?? []).filter((_, i) => i !== index)
    handleUpdate({ metrics: list })
  }

  const addDataRowField = () => {
    const idx = (current.dataRowFields?.length ?? 0) + 1
    const nextFields: ScenarioDataRowFieldDecl[] = [
      ...(current.dataRowFields ?? []),
      {
        columnKey: `field_${idx}`,
        columnHeader: `字段 ${idx}`,
        fromContextKey: '',
      },
    ]
    handleUpdate({ dataRowFields: nextFields })
  }

  const updateDataRowField = (index: number, patch: Partial<ScenarioDataRowFieldDecl>) => {
    const list = [...(current.dataRowFields ?? [])]
    if (list[index]) {
      list[index] = { ...list[index], ...patch }
      handleUpdate({ dataRowFields: list })
    }
  }

  const removeDataRowField = (index: number) => {
    const list = (current.dataRowFields ?? []).filter((_, i) => i !== index)
    handleUpdate({ dataRowFields: list })
  }

  return (
    <div className='space-y-6'>
      {/* 头部介绍 */}
      <div>
        <h3 className='text-small font-semibold text-foreground'>场景业务输出与指标声明</h3>
        <p className='text-xs text-muted-foreground mt-1'>
          声明运行完成后的标准化业务结论、核心巡检指标及单行宽表数据。若未配置，引擎将自动按执行状态进行兜底智能装配。
        </p>
      </div>

      {/* 1. 业务结论模板 */}
      <div className='rounded-lg border border-border-card bg-card p-4 space-y-3 shadow-sm'>
        <div className='flex items-center gap-2'>
          <FileText className='size-4 text-primary' />
          <h4 className='text-sm font-medium text-foreground'>业务结论规则</h4>
        </div>
        <div className='space-y-3'>
          <div>
            <Label htmlFor='summary-template' className='text-xs text-muted-foreground mb-1 block'>
              结论插值模板 (支持 ${'{'}variable{'}'} 替换，优先使用)
            </Label>
            <Input
              id='summary-template'
              value={current.summaryTemplate ?? ''}
              disabled={disabled}
              placeholder='例：巡检完成，在售商品 ${item_count} 件'
              onChange={(e) => handleUpdate({ summaryTemplate: e.target.value || undefined })}
              className='text-sm'
            />
          </div>

          {/* 候选变量快捷插入 */}
          {candidateKeys.length > 0 && !disabled && (
            <div className='space-y-1.5'>
              <div className='text-xs text-muted-foreground flex items-center gap-1'>
                <Sparkles className='size-3 text-primary' />
                <span>快捷插入变量：</span>
              </div>
              <div className='flex flex-wrap gap-1.5'>
                {candidateKeys.map((key) => (
                  <button
                    key={key}
                    type='button'
                    onClick={() => insertVariable(key)}
                    className='inline-flex items-center rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border-card/50 transition-colors'
                    title={`点击插入 \${${key}}`}
                  >
                    +${`{${key}}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 实时推演预览 */}
          {simulatedSummary && (
            <div
              className='rounded-md border border-border-card/60 bg-muted/20 p-2.5 text-xs'
              data-testid='summary-preview-panel'
            >
              <span className='font-medium text-muted-foreground mr-1.5'>实时模拟推演：</span>
              <span className='font-medium text-foreground italic'>{simulatedSummary}</span>
            </div>
          )}

          <div>
            <Label htmlFor='summary-context-key' className='text-xs text-muted-foreground mb-1 block'>
              或直接取上下文变量 (Context Key)
            </Label>
            <Input
              id='summary-context-key'
              value={current.summaryFromContextKey ?? ''}
              disabled={disabled}
              placeholder='例：final_summary'
              onChange={(e) => handleUpdate({ summaryFromContextKey: e.target.value || undefined })}
              className='text-sm font-mono'
            />
          </div>
        </div>
      </div>

      {/* 2. 核心指标列表 */}
      <div className='rounded-lg border border-border-card bg-card p-4 space-y-3 shadow-sm'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <TrendingUp className='size-4 text-primary' />
            <h4 className='text-sm font-medium text-foreground'>
              核心指标 ({(current.metrics ?? []).length}/20)
            </h4>
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={disabled || (current.metrics?.length ?? 0) >= 20}
            onClick={addMetric}
          >
            <Plus className='size-3.5 mr-1' />
            添加指标
          </Button>
        </div>

        {(!current.metrics || current.metrics.length === 0) ? (
          <div className='rounded-md border border-dashed border-border-divider p-4 text-center text-xs text-muted-foreground bg-muted/20'>
            尚未声明业务指标。未配置时将自动提取提取步骤 (extract) 的标量输出。
          </div>
        ) : (
          <div className='space-y-3'>
            {current.metrics.map((metric, idx) => (
              <div
                key={`metric-${idx}`}
                className='grid grid-cols-1 sm:grid-cols-12 gap-2 p-3 rounded-md border border-border-card/80 bg-muted/15 items-center'
              >
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>指标标识 (Key)</Label>
                  <Input
                    value={metric.key}
                    disabled={disabled}
                    placeholder='item_count'
                    onChange={(e) => updateMetric(idx, { key: e.target.value.toLowerCase().trim() })}
                    className='text-xs font-mono h-8'
                  />
                </div>
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>显示名称</Label>
                  <Input
                    value={metric.name}
                    disabled={disabled}
                    placeholder='在售商品数'
                    onChange={(e) => updateMetric(idx, { name: e.target.value })}
                    className='text-xs h-8'
                  />
                </div>
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>上下文变量</Label>
                  <Input
                    value={metric.fromContextKey}
                    disabled={disabled}
                    placeholder='report'
                    onChange={(e) => updateMetric(idx, { fromContextKey: e.target.value })}
                    className='text-xs font-mono h-8'
                  />
                </div>
                <div className='sm:col-span-2'>
                  <Label className='text-xs text-muted-foreground block mb-1'>属性 / 单位</Label>
                  <div className='flex gap-1'>
                    <Input
                      value={metric.fromField ?? ''}
                      disabled={disabled}
                      placeholder='字段'
                      onChange={(e) => updateMetric(idx, { fromField: e.target.value || undefined })}
                      className='text-xs font-mono h-8 w-1/2'
                      title='若上下文变量为对象，提取此内部属性'
                    />
                    <Input
                      value={metric.unit ?? ''}
                      disabled={disabled}
                      placeholder='单位'
                      onChange={(e) => updateMetric(idx, { unit: e.target.value || undefined })}
                      className='text-xs h-8 w-1/2'
                    />
                  </div>
                </div>
                <div className='sm:col-span-1 flex justify-end pt-5'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    disabled={disabled}
                    onClick={() => removeMetric(idx)}
                    className='h-8 w-8 p-0 text-muted-foreground hover:text-destructive'
                  >
                    <Trash2 className='size-3.5' />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. 单行宽表字段 */}
      <div className='rounded-lg border border-border-card bg-card p-4 space-y-3 shadow-sm'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Table className='size-4 text-primary' />
            <h4 className='text-sm font-medium text-foreground'>
              单行宽表字段 ({(current.dataRowFields ?? []).length}/20)
            </h4>
          </div>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={disabled || (current.dataRowFields?.length ?? 0) >= 20}
            onClick={addDataRowField}
          >
            <Plus className='size-3.5 mr-1' />
            添加字段
          </Button>
        </div>

        {(!current.dataRowFields || current.dataRowFields.length === 0) ? (
          <div className='rounded-md border border-dashed border-border-divider p-4 text-center text-xs text-muted-foreground bg-muted/20'>
            尚未声明宽表字段。声明后可在批量分析、测试套件汇总中横向聚合。
          </div>
        ) : (
          <div className='space-y-3'>
            {current.dataRowFields.map((field, idx) => (
              <div
                key={`field-${idx}`}
                className='grid grid-cols-1 sm:grid-cols-12 gap-2 p-3 rounded-md border border-border-card/80 bg-muted/15 items-center'
              >
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>列标识 (Key)</Label>
                  <Input
                    value={field.columnKey}
                    disabled={disabled}
                    placeholder='sku_id'
                    onChange={(e) => updateDataRowField(idx, { columnKey: e.target.value.trim() })}
                    className='text-xs font-mono h-8'
                  />
                </div>
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>表头标题</Label>
                  <Input
                    value={field.columnHeader}
                    disabled={disabled}
                    placeholder='商品编号'
                    onChange={(e) => updateDataRowField(idx, { columnHeader: e.target.value })}
                    className='text-xs h-8'
                  />
                </div>
                <div className='sm:col-span-3'>
                  <Label className='text-xs text-muted-foreground block mb-1'>上下文变量</Label>
                  <Input
                    value={field.fromContextKey}
                    disabled={disabled}
                    placeholder='product'
                    onChange={(e) => updateDataRowField(idx, { fromContextKey: e.target.value })}
                    className='text-xs font-mono h-8'
                  />
                </div>
                <div className='sm:col-span-2'>
                  <Label className='text-xs text-muted-foreground block mb-1'>嵌套字段 (可选)</Label>
                  <Input
                    value={field.fromField ?? ''}
                    disabled={disabled}
                    placeholder='sku'
                    onChange={(e) => updateDataRowField(idx, { fromField: e.target.value || undefined })}
                    className='text-xs font-mono h-8'
                  />
                </div>
                <div className='sm:col-span-1 flex justify-end pt-5'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    disabled={disabled}
                    onClick={() => removeDataRowField(idx)}
                    className='h-8 w-8 p-0 text-muted-foreground hover:text-destructive'
                  >
                    <Trash2 className='size-3.5' />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
