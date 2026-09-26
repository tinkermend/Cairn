import { useMemo } from 'react'
import {
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { computeScenarioDiff, type ScenarioDiffResult } from '../scenario-diff'
import { stepTypeLabel } from '@/features/authoring/step-registry'
import {
  X,
  PlusCircle,
  MinusCircle,
  HelpCircle,
  Box,
  CheckCircle2,
  FileCode,
  Layers,
  Loader2,
  Eye,
  GitFork,
} from 'lucide-react'

export interface PublishDiffDrawerProps {
  open: boolean
  scenarioName: string
  currentVersionNo?: number
  baselineDoc?: ScenarioDocument | ScenarioAuthoringDocumentV2
  draftDoc: ScenarioDocument | ScenarioAuthoringDocumentV2
  publishing: boolean
  onClose: () => void
  onConfirmPublish: () => void
}

export function PublishDiffDrawer({
  open,
  scenarioName,
  currentVersionNo,
  baselineDoc,
  draftDoc,
  publishing,
  onClose,
  onConfirmPublish,
}: PublishDiffDrawerProps) {
  const diff: ScenarioDiffResult = useMemo(
    () => computeScenarioDiff(baselineDoc, draftDoc),
    [baselineDoc, draftDoc],
  )

  if (!open) return null

  const isInitial = diff.isInitialPublish || !currentVersionNo

  return (
    <div
      data-testid='publish-diff-drawer-root'
      className='fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs transition-opacity animate-in fade-in duration-200'
      onClick={onClose}
    >
      <div
        data-testid='publish-diff-drawer-panel'
        className='flex flex-col h-full w-[540px] max-w-full bg-background border-l border-border shadow-elevation-lg animate-in slide-in-from-right duration-200'
        onClick={(e) => e.stopPropagation()}
      >
        {/* 抽屉头部 */}
        <div className='px-6 py-4 border-b border-border flex items-center justify-between shrink-0 bg-muted/10'>
          <div>
            <div className='flex items-center gap-2'>
              <h3 className='text-heading font-semibold text-foreground'>发布版本确认</h3>
              <span className='rounded px-2 py-0.5 text-label font-mono font-medium bg-primary/10 text-primary border border-primary/20'>
                {isInitial ? '初始版本 · v1' : `v${currentVersionNo} → v${(currentVersionNo ?? 1) + 1}`}
              </span>
            </div>
            <p className='text-small text-muted-foreground mt-1 truncate max-w-md'>
              场景：{scenarioName}
            </p>
          </div>
          <button
            type='button'
            aria-label='关闭差异审查'
            className='p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors'
            onClick={onClose}
          >
            <X className='size-5' />
          </button>
        </div>

        {/* 差异统计微标栏 */}
        <div className='px-6 py-2.5 bg-muted/20 border-b border-border flex items-center gap-2 text-label'>
          {isInitial ? (
            <span className='inline-flex items-center gap-1.5 text-primary font-medium'>
              <CheckCircle2 className='size-3.5' /> 全新发布，共计 {diff.summary.addedCount} 个执行项
            </span>
          ) : (
            <>
              <span className='px-2 py-0.5 rounded border border-status-success-accent bg-status-success-background text-status-success-foreground font-medium'>
                + {diff.summary.addedCount} 新增
              </span>
              <span className='px-2 py-0.5 rounded border border-status-warning-accent bg-status-warning-background text-status-warning-foreground font-medium'>
                ~ {diff.summary.modifiedCount} 修改
              </span>
              <span className='px-2 py-0.5 rounded border border-destructive/30 bg-destructive/10 text-destructive font-medium'>
                - {diff.summary.removedCount} 删除
              </span>
            </>
          )}
        </div>

        {/* 差异清单主体 */}
        <div className='flex-1 overflow-y-auto px-6 py-4 space-y-4'>
          {!diff.hasChanges && !isInitial ? (
            <div className='p-8 text-center text-muted-foreground space-y-2 border border-dashed border-border rounded-panel'>
              <Eye className='size-8 mx-auto opacity-40' />
              <p className='text-body font-medium text-foreground'>未检测到任何改动</p>
              <p className='text-small'>当前草稿与已发布的线上生效版本内容完全一致。</p>
            </div>
          ) : null}

          {/* 节点变动列表 */}
          {diff.nodeChanges.length > 0 ? (
            <div className='space-y-2.5'>
              <div className='text-label font-medium text-muted-foreground flex items-center gap-1.5'>
                <Layers className='size-3.5' />
                <span>步骤与模块变动 ({diff.nodeChanges.length})</span>
              </div>

              {diff.nodeChanges.map((change) => {
                if (change.kind === 'step_added') {
                  return (
                    <div
                      key={change.step.id}
                      className='p-3 rounded-panel border border-status-success-accent bg-status-success-background flex items-start gap-3'
                    >
                      <PlusCircle className='size-4 text-status-success-foreground mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <div className='flex items-center justify-between'>
                          <span className='font-medium text-foreground truncate'>
                            步骤：{change.step.name}
                          </span>
                          <span className='text-label text-status-success-foreground font-mono'>
                            {stepTypeLabel(change.step.type)}
                          </span>
                        </div>
                        <p className='text-label text-muted-foreground mt-0.5'>
                          序号 {change.index + 1} · 新增步骤
                        </p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'step_removed') {
                  return (
                    <div
                      key={change.step.id}
                      className='p-3 rounded-panel border border-destructive/30 bg-destructive/10 flex items-start gap-3'
                    >
                      <MinusCircle className='size-4 text-destructive mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <div className='flex items-center justify-between'>
                          <span className='font-medium text-foreground truncate line-through opacity-80'>
                            步骤：{change.step.name}
                          </span>
                          <span className='text-label text-destructive font-mono'>
                            已移除
                          </span>
                        </div>
                        <p className='text-label text-muted-foreground mt-0.5'>
                          原序号 {change.originalIndex + 1}
                        </p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'step_modified') {
                  return (
                    <div
                      key={change.stepId}
                      className='p-3 rounded-panel border border-status-warning-accent bg-status-warning-background space-y-2'
                    >
                      <div className='flex items-center justify-between text-small'>
                        <span className='font-medium text-foreground truncate'>
                          步骤：{change.name}
                        </span>
                        <span className='text-label text-status-warning-foreground font-medium'>
                          修改了 {change.changes.length} 项属性
                        </span>
                      </div>
                      <div className='space-y-1.5 pt-1 border-t border-border-divider/50'>
                        {change.changes.map((prop) => (
                          <div key={prop.field} className='text-label grid grid-cols-3 gap-2'>
                            <span className='text-muted-foreground'>{prop.label}</span>
                            <span className='text-destructive line-through truncate'>
                              {typeof prop.before === 'object'
                                ? JSON.stringify(prop.before)
                                : String(prop.before ?? '(无)')}
                            </span>
                            <span className='text-status-success-foreground font-medium truncate'>
                              {typeof prop.after === 'object'
                                ? JSON.stringify(prop.after)
                                : String(prop.after ?? '(无)')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'module_added') {
                  return (
                    <div
                      key={change.node.invocationId}
                      className='p-3 rounded-panel border border-status-success-accent bg-status-success-background flex items-start gap-3'
                    >
                      <Box className='size-4 text-status-success-foreground mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <span className='font-medium text-foreground truncate'>
                          模块：{change.node.name || change.node.moduleId}
                        </span>
                        <p className='text-label text-muted-foreground mt-0.5'>
                          序号 {change.index + 1} · 新增动作模块调用
                        </p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'module_removed') {
                  return (
                    <div
                      key={change.node.invocationId}
                      className='p-3 rounded-panel border border-destructive/30 bg-destructive/10 flex items-start gap-3'
                    >
                      <MinusCircle className='size-4 text-destructive mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <span className='font-medium text-foreground line-through opacity-80'>
                          模块：{change.node.name || change.node.moduleId}
                        </span>
                        <p className='text-label text-muted-foreground mt-0.5'>已移除模块调用</p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'module_modified') {
                  return (
                    <div
                      key={change.invocationId}
                      className='p-3 rounded-panel border border-status-warning-accent bg-status-warning-background space-y-2'
                    >
                      <div className='flex items-center justify-between text-small'>
                        <span className='font-medium text-foreground truncate'>
                          模块：{change.name}
                        </span>
                        <span className='text-label text-status-warning-foreground font-medium'>
                          修改了 {change.changes.length} 项属性
                        </span>
                      </div>
                      <div className='space-y-1.5 pt-1 border-t border-border-divider/50'>
                        {change.changes.map((prop) => (
                          <div key={prop.field} className='text-label grid grid-cols-3 gap-2'>
                            <span className='text-muted-foreground'>{prop.label}</span>
                            <span className='text-destructive line-through truncate'>
                              {typeof prop.before === 'object'
                                ? JSON.stringify(prop.before)
                                : String(prop.before ?? '(无)')}
                            </span>
                            <span className='text-status-success-foreground font-medium truncate'>
                              {typeof prop.after === 'object'
                                ? JSON.stringify(prop.after)
                                : String(prop.after ?? '(无)')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'block_added') {
                  return (
                    <div
                      key={change.node.blockId}
                      className='p-3 rounded-panel border border-status-success-accent bg-status-success-background flex items-start gap-3'
                    >
                      <GitFork className='size-4 text-status-success-foreground mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <span className='font-medium text-foreground truncate'>
                          分支：{change.node.name || '条件分支'}
                        </span>
                        <p className='text-label text-muted-foreground mt-0.5'>
                          序号 {change.index + 1} · 新增条件分支
                        </p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'block_removed') {
                  return (
                    <div
                      key={change.node.blockId}
                      className='p-3 rounded-panel border border-destructive/30 bg-destructive/10 flex items-start gap-3'
                    >
                      <MinusCircle className='size-4 text-destructive mt-0.5 shrink-0' />
                      <div className='min-w-0 flex-1 text-small'>
                        <span className='font-medium text-foreground line-through opacity-80'>
                          分支：{change.node.name || '条件分支'}
                        </span>
                        <p className='text-label text-muted-foreground mt-0.5'>已移除条件分支</p>
                      </div>
                    </div>
                  )
                }

                if (change.kind === 'block_modified') {
                  return (
                    <div
                      key={change.blockId}
                      className='p-3 rounded-panel border border-status-warning-accent bg-status-warning-background space-y-2'
                    >
                      <div className='flex items-center justify-between text-small'>
                        <span className='font-medium text-foreground truncate'>
                          分支：{change.name}
                        </span>
                        <span className='text-label text-status-warning-foreground font-medium'>
                          修改了 {change.changes.length} 项属性
                        </span>
                      </div>
                      <div className='space-y-1.5 pt-1 border-t border-border-divider/50'>
                        {change.changes.map((prop) => (
                          <div key={prop.field} className='text-label grid grid-cols-3 gap-2'>
                            <span className='text-muted-foreground'>{prop.label}</span>
                            <span className='text-destructive line-through truncate'>
                              {typeof prop.before === 'object'
                                ? JSON.stringify(prop.before)
                                : String(prop.before ?? '(无)')}
                            </span>
                            <span className='text-status-success-foreground font-medium truncate'>
                              {typeof prop.after === 'object'
                                ? JSON.stringify(prop.after)
                                : String(prop.after ?? '(无)')}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }

                return null
              })}
            </div>
          ) : null}

          {/* 全局输入变动列表 */}
          {diff.inputChanges.length > 0 ? (
            <div className='space-y-2.5 pt-2'>
              <div className='text-label font-medium text-muted-foreground flex items-center gap-1.5'>
                <FileCode className='size-3.5' />
                <span>场景全局输入变动 ({diff.inputChanges.length})</span>
              </div>
              {diff.inputChanges.map((input) => (
                <div
                  key={input.key}
                  className={`p-2.5 rounded-panel border text-small flex items-center justify-between ${
                    input.kind === 'added'
                      ? 'border-status-success-accent bg-status-success-background text-foreground'
                      : input.kind === 'removed'
                        ? 'border-destructive/30 bg-destructive/10 text-foreground'
                        : 'border-status-warning-accent bg-status-warning-background text-foreground'
                  }`}
                >
                  <span className='font-mono font-medium'>{input.key}</span>
                  <span className='text-label text-muted-foreground'>{input.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* 底部确认操作栏 */}
        <div className='px-6 py-4 border-t border-border flex items-center justify-between shrink-0 bg-muted/10'>
          <div className='text-label text-muted-foreground flex items-center gap-1'>
            <HelpCircle className='size-3.5' />
            <span>发布后将立即对新的运行任务生效</span>
          </div>

          <div className='flex items-center gap-2.5'>
            <Button variant='outline' disabled={publishing} onClick={onClose}>
              取消
            </Button>
            <Button
              variant='default'
              disabled={publishing}
              onClick={onConfirmPublish}
            >
              {publishing ? (
                <>
                  <Loader2 className='size-4 animate-spin mr-1.5' />
                  正在发布...
                </>
              ) : (
                '确认并正式发布'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
