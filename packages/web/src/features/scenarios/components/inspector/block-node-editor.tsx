import { useState } from 'react'
import {
  GitFork,
  Code2,
  Trash2,
  AlertTriangle,
  Info,
  CheckCircle2,
  Plus,
} from 'lucide-react'
import {
  EXPR_COMPARE_OPS,
  type CompileDiagnostic,
  type ExecutableStepType,
  type ScenarioAuthoringNode,
  type AuthoringBlockNode,
  type AuthoringBlockNodeIf,
  type AuthoringBlockNodeForEach,
  type AuthoringBlockNodeRepeat,
  type Expr,
} from '@cairn/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { BindingOption } from '@/features/authoring/document'

export interface BlockNodeEditorProps {
  node: AuthoringBlockNode
  priorBindings?: BindingOption[]
  diagnostics?: CompileDiagnostic[]
  disabled?: boolean
  onChange: (updated: ScenarioAuthoringNode) => void
  onAddStepToBranch?: (branch: 'then' | 'else' | 'body', type: ExecutableStepType) => void
  onDelete?: () => void
}

export function BlockNodeEditor({
  node,
  priorBindings = [],
  diagnostics = [],
  disabled,
  onChange,
  onAddStepToBranch,
  onDelete,
}: BlockNodeEditorProps) {
  const [showRawExpr, setShowRawExpr] = useState(false)

  if (node.control.type === 'for_each') {
    const forEachNode = node as AuthoringBlockNodeForEach
    return (
      <div data-testid='block-node-editor' className='space-y-5 p-1'>
        <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
          <div className='flex items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <GitFork className='size-4 text-primary shrink-0' />
              <h3 className='text-body font-semibold text-foreground'>逐项处理块 (For-Each)</h3>
            </div>
            {onDelete && (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10'
                disabled={disabled}
                onClick={onDelete}
              >
                <Trash2 className='size-3.5 mr-1' />
                删除块
              </Button>
            )}
          </div>

          <div className='space-y-1.5'>
            <Label className='text-label font-medium'>数据源 (from)</Label>
            <Input
              value={forEachNode.control.over.from}
              disabled={disabled}
              placeholder='输入前序步骤输出的数组字段'
              onChange={(e) =>
                onChange({
                  ...forEachNode,
                  control: {
                    ...forEachNode.control,
                    over: { ...forEachNode.control.over, from: e.target.value },
                  },
                })
              }
            />
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-1.5'>
              <Label className='text-label font-medium'>项变量 (as)</Label>
              <Input
                value={forEachNode.control.as}
                disabled={disabled}
                placeholder='item'
                onChange={(e) =>
                  onChange({
                    ...forEachNode,
                    control: { ...forEachNode.control, as: e.target.value },
                  })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-label font-medium'>最大项数 (maxItems)</Label>
              <Input
                type='number'
                value={forEachNode.control.maxItems}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...forEachNode,
                    control: {
                      ...forEachNode.control,
                      maxItems: Number(e.target.value) || 1,
                    },
                  })
                }
              />
            </div>
          </div>
        </div>

        <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
          <h4 className='text-body font-medium text-foreground'>循环体与子步骤</h4>
          <div className='p-3 rounded-lg border border-border-card bg-primary/5 space-y-2'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-label text-primary'>循环体</span>
              <div className='flex items-center gap-2'>
                <span className='text-caption text-muted-foreground'>
                  {forEachNode.body.length} 个子步骤
                </span>
                {onAddStepToBranch && (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-1.5 text-3xs'
                    disabled={disabled}
                    onClick={() => onAddStepToBranch('body', 'wait')}
                  >
                    <Plus className='size-3 mr-0.5' /> 添加
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {diagnostics.length > 0 && (
          <ul className='space-y-2'>
            {diagnostics.map((diag, i) => (
              <li key={i} className='text-status-error text-caption'>{diag.message}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  if (node.control.type === 'repeat') {
    const repeatNode = node as AuthoringBlockNodeRepeat
    return (
      <div data-testid='block-node-editor' className='space-y-5 p-1'>
        <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
          <div className='flex items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              <GitFork className='size-4 text-primary shrink-0' />
              <h3 className='text-body font-semibold text-foreground'>重复执行块 (Repeat)</h3>
            </div>
            {onDelete && (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10'
                disabled={disabled}
                onClick={onDelete}
              >
                <Trash2 className='size-3.5 mr-1' />
                删除块
              </Button>
            )}
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div className='space-y-1.5'>
              <Label className='text-label font-medium'>最大循环次数</Label>
              <Input
                type='number'
                value={repeatNode.control.maxIterations}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...repeatNode,
                    control: {
                      ...repeatNode.control,
                      maxIterations: Number(e.target.value) || 1,
                    },
                  })
                }
              />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-label font-medium'>达到上限策略 (onLimit)</Label>
              <Select
                value={repeatNode.control.onLimit}
                disabled={disabled}
                onValueChange={(val: 'stop' | 'fail') =>
                  onChange({
                    ...repeatNode,
                    control: { ...repeatNode.control, onLimit: val },
                  })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value='stop'>停止 (正常收尾)</SelectItem>
                  <SelectItem value='fail'>失败 (主动报错)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
          <h4 className='text-body font-medium text-foreground'>循环体与子步骤</h4>
          <div className='p-3 rounded-lg border border-border-card bg-primary/5 space-y-2'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-label text-primary'>循环体</span>
              <div className='flex items-center gap-2'>
                <span className='text-caption text-muted-foreground'>
                  {repeatNode.body.length} 个子步骤
                </span>
                {onAddStepToBranch && (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 px-1.5 text-3xs'
                    disabled={disabled}
                    onClick={() => onAddStepToBranch('body', 'wait')}
                  >
                    <Plus className='size-3 mr-0.5' /> 添加
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {diagnostics.length > 0 && (
          <ul className='space-y-2'>
            {diagnostics.map((diag, i) => (
              <li key={i} className='text-status-error text-caption'>{diag.message}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const ifNode = node as AuthoringBlockNodeIf
  const condition = ifNode.control.condition

  // Helper to extract left/op/right from simple compare or fallback
  let leftKey = ''
  let op = 'eq'
  let rightVal = 'true'

  if (condition.kind === 'compare') {
    leftKey = condition.left.kind === 'ref' ? condition.left.key : ''
    op = condition.op
    rightVal = condition.right.kind === 'literal' ? String(condition.right.value) : ''
  } else if (condition.kind === 'ref') {
    leftKey = condition.key
    op = 'eq'
    rightVal = 'true'
  }

  const updateCondition = (nextLeft: string, nextOp: string, nextRight: string) => {
    const compareOp = EXPR_COMPARE_OPS.find((candidate) => candidate === nextOp)
    if (!compareOp) return
    let parsedRight: string | number | boolean = nextRight
    if (nextRight === 'true') parsedRight = true
    else if (nextRight === 'false') parsedRight = false
    else if (!Number.isNaN(Number(nextRight)) && nextRight.trim() !== '') {
      parsedRight = Number(nextRight)
    }

    const nextExpr: Expr = {
      kind: 'compare',
      op: compareOp,
      left: { kind: 'ref', key: nextLeft },
      right: { kind: 'literal', value: parsedRight },
    }

    onChange({
      ...ifNode,
      control: {
        ...ifNode.control,
        condition: nextExpr,
      },
    })
  }

  const hasElse = Boolean(ifNode.else && ifNode.else.length >= 0)

  const toggleElseBranch = (enabled: boolean) => {
    onChange({
      ...ifNode,
      else: enabled ? (ifNode.else ?? []) : undefined,
    })
  }

  return (
    <div data-testid='block-node-editor' className='space-y-5 p-1'>
      {/* 块名称与顶部状态 */}
      <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
        <div className='flex items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <GitFork className='size-4 text-primary shrink-0' />
            <h3 className='text-body font-semibold text-foreground'>条件分支块 (If-Else)</h3>
          </div>
          {onDelete && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10'
              disabled={disabled}
              onClick={onDelete}
            >
              <Trash2 className='size-3.5 mr-1' />
              删除块
            </Button>
          )}
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor={`block-name-${node.blockId}`} className='text-label font-medium'>
            分支块名称
          </Label>
          <Input
            id={`block-name-${node.blockId}`}
            value={node.name ?? '条件分支'}
            disabled={disabled}
            placeholder='输入分支描述'
            className='border-control focus:border-primary shadow-control-focus'
            onChange={(e) => onChange({ ...node, name: e.target.value })}
          />
        </div>
      </div>

      {/* 条件构建器 */}
      <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
        <div className='flex items-center justify-between'>
          <div className='space-y-0.5'>
            <h4 className='text-body font-medium text-foreground'>条件判定规则</h4>
            <p className='text-caption text-muted-foreground'>
              执行时求值，为 true 时走 then 分支，为 false 时走 else 分支
            </p>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-7 px-2 text-caption text-muted-foreground'
            onClick={() => setShowRawExpr(!showRawExpr)}
          >
            <Code2 className='size-3.5 mr-1' />
            {showRawExpr ? '可视化模式' : 'AST 源码'}
          </Button>
        </div>

        {!showRawExpr ? (
          <div className='space-y-3 pt-1'>
            {/* 左操作数：引用变量 */}
            <div className='space-y-1.5'>
              <Label className='text-label'>判定对象 (上下文变量 / 检查输出)</Label>
              <div className='flex gap-2'>
                {priorBindings.length > 0 ? (
                  <Select
                    value={leftKey}
                    disabled={disabled}
                    onValueChange={(val) => updateCondition(val, op, rightVal)}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue placeholder='选择前序变量' />
                    </SelectTrigger>
                    <SelectContent>
                      {priorBindings.map((b) => (
                        <SelectItem key={b.key} value={b.key}>
                          {b.label} ({b.key})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    placeholder='例如: probe.matched 或 flag'
                    value={leftKey}
                    disabled={disabled}
                    onChange={(e) => updateCondition(e.target.value, op, rightVal)}
                  />
                )}
              </div>
            </div>

            {/* 比较操作符 */}
            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1.5'>
                <Label className='text-label'>比较关系</Label>
                <Select
                  value={op}
                  disabled={disabled}
                  onValueChange={(val) => updateCondition(leftKey, val, rightVal)}
                >
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='eq'>等于 (==)</SelectItem>
                    <SelectItem value='neq'>不等于 (!=)</SelectItem>
                    <SelectItem value='gt'>大于 (&gt;)</SelectItem>
                    <SelectItem value='gte'>大于等于 (&gt;=)</SelectItem>
                    <SelectItem value='lt'>小于 (&lt;)</SelectItem>
                    <SelectItem value='lte'>小于等于 (&lt;=)</SelectItem>
                    <SelectItem value='contains'>包含 (contains)</SelectItem>
                    <SelectItem value='matches'>正则匹配 (matches)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 右操作数：目标值 */}
              <div className='space-y-1.5'>
                <Label className='text-label'>对比目标值</Label>
                <Input
                  placeholder='例如: true, false, 100, 或文字'
                  value={rightVal}
                  disabled={disabled}
                  onChange={(e) => updateCondition(leftKey, op, e.target.value)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className='space-y-1.5'>
            <Label className='text-label font-mono'>Expression AST</Label>
            <pre className='p-3 bg-muted/40 rounded-lg text-2xs font-mono overflow-x-auto max-h-48 border border-border-default'>
              {JSON.stringify(condition, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* 分支结构概览 */}
      <div className='rounded-xl border border-border-card bg-card p-4 shadow-xs space-y-4'>
        <h4 className='text-body font-medium text-foreground'>分支与子步骤</h4>

        {/* Then 分支 */}
        <div className='p-3 rounded-lg border border-primary/20 bg-primary/5 space-y-2'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-1.5'>
              <CheckCircle2 className='size-3.5 text-primary' />
              <span className='font-medium text-label text-primary'>Then 分支 (满足条件)</span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-caption text-muted-foreground'>
                {ifNode.then.length} 个子步骤
              </span>
              {onAddStepToBranch && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-6 px-1.5 text-3xs'
                  disabled={disabled}
                  onClick={() => onAddStepToBranch('then', 'wait')}
                >
                  <Plus className='size-3 mr-0.5' /> 添加
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Else 分支开关与概览 */}
        <div className='p-3 rounded-lg border border-border-default bg-surface-subtle space-y-2'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-1.5'>
              <GitFork className='size-3.5 text-muted-foreground' />
              <span className='font-medium text-label text-foreground'>Else 分支 (不满足条件)</span>
            </div>
            <div className='flex items-center gap-2'>
              <span className='text-caption text-muted-foreground'>
                {hasElse ? `${ifNode.else?.length ?? 0} 个子步骤` : '未启用'}
              </span>
              {hasElse && onAddStepToBranch && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-6 px-1.5 text-3xs'
                  disabled={disabled}
                  onClick={() => onAddStepToBranch('else', 'wait')}
                >
                  <Plus className='size-3 mr-0.5' /> 添加
                </Button>
              )}
              <Switch
                checked={hasElse}
                disabled={disabled}
                onCheckedChange={toggleElseBranch}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 块关联编译诊断 */}
      {diagnostics.length > 0 && (
        <ul className='space-y-2'>
          {diagnostics.map((diag, i) => (
            <li
              key={i}
              className={cn(
                'flex items-start gap-2 rounded-lg border p-3 text-label',
                diag.severity === 'error'
                  ? 'border-status-error/30 bg-status-error/5 text-status-error-foreground'
                  : 'border-status-warning/30 bg-status-warning/5 text-status-warning-foreground',
              )}
            >
              {diag.severity === 'error' ? (
                <AlertTriangle className='size-4 shrink-0 mt-0.5' />
              ) : (
                <Info className='size-4 shrink-0 mt-0.5' />
              )}
              <div className='space-y-0.5'>
                <p className='font-medium'>{diag.message}</p>
                <p className='text-caption opacity-80 font-mono'>{diag.code}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
