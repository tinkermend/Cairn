import { useState } from 'react'
import type {
  RecordingGeneralizationDto,
  ScenarioAuthoringDocumentV2,
} from '@cairn/shared'
import {
  Sparkles,
  Zap,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Clock,
  SlidersHorizontal,
  Eraser,
  KeyRound,
  Database,
  Send,
  Loader2,
  FileDiff,
  Target,
  FileText,
  AlertCircle,
  X,
  HelpCircle,
  ShieldAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  submitRecordingGeneralizationRound,
  acceptRecordingGeneralizationRound,
  rejectRecordingGeneralizationRound,
  revertRecordingGeneralizationRound,
} from '@/lib/recordings-api'
import { ApiRequestError } from '@/lib/api-client'

type Props = {
  recordingId: string
  generalization?: RecordingGeneralizationDto
  candidateDocument?: ScenarioAuthoringDocumentV2
  onGeneralizationUpdated: (gen: RecordingGeneralizationDto, doc?: ScenarioAuthoringDocumentV2) => void
  canWrite?: boolean
  selectedStepId?: string
  selectedStepName?: string
  onClearSelection?: () => void
}

export function GeneralizationPanel({
  recordingId,
  generalization,
  candidateDocument: _candidateDocument,
  onGeneralizationUpdated,
  canWrite = true,
  selectedStepId,
  selectedStepName,
  onClearSelection,
}: Props) {
  const [intentInput, setIntentInput] = useState('')
  const [submittingAction, setSubmittingAction] = useState<string | null>(null)
  const [operatingRoundId, setOperatingRoundId] = useState<string | null>(null)
  const [lastClarification, setLastClarification] = useState<{ code?: string; message: string } | null>(null)

  if (!generalization) {
    return (
      <div className='flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-card bg-card p-6 text-center text-muted-foreground shadow-card'>
        <Sparkles className='size-8 text-primary/40' />
        <p className='text-body'>正在加载泛化工作层...</p>
      </div>
    )
  }

  const isLocked = generalization.status === 'handed_off'
  const rounds = generalization.rounds ?? []

  const handleQuickAction = async (action: 'relax_timeout' | 'extract' | 'parameterize' | 'expect_outcome' | 'clean_login' | 'clean_misfires') => {
    if (isLocked) {
      toast.error('工作层已完成回填并锁定，不可再提交新轮次')
      return
    }
    setLastClarification(null)
    setSubmittingAction(action)
    try {
      const res = await submitRecordingGeneralizationRound(recordingId, {
        revision: generalization.revision,
        quickAction: action,
        targetStepId: selectedStepId,
      })
      toast.success(`快捷泛化「${action}」已生成待审轮次`)
      onGeneralizationUpdated(res.generalization, res.candidateDocument)
    } catch (error) {
      const msg =
        error instanceof ApiRequestError
          ? error.payload?.message || error.message
          : error instanceof Error
          ? error.message
          : '提交快捷泛化失败'
      toast.error(msg)
      setLastClarification({
        code: error instanceof ApiRequestError ? error.payload?.code : undefined,
        message: msg,
      })
    } finally {
      setSubmittingAction(null)
    }
  }

  const handleSubmitIntent = async (customIntent?: string) => {
    const textToSubmit = (customIntent ?? intentInput).trim()
    if (!textToSubmit || isLocked) return
    setLastClarification(null)
    setSubmittingAction('intent')
    try {
      const res = await submitRecordingGeneralizationRound(recordingId, {
        revision: generalization.revision,
        intent: textToSubmit,
        targetStepId: selectedStepId,
      })
      toast.success('自然语言泛化轮次已生成')
      setIntentInput('')
      onGeneralizationUpdated(res.generalization, res.candidateDocument)
    } catch (error) {
      const msg =
        error instanceof ApiRequestError
          ? error.payload?.message || error.message
          : error instanceof Error
          ? error.message
          : '自然语言泛化失败'
      toast.error(msg)
      setLastClarification({
        code: error instanceof ApiRequestError ? error.payload?.code : undefined,
        message: msg,
      })
    } finally {
      setSubmittingAction(null)
    }
  }

  const handleAcceptRound = async (roundId: string) => {
    setOperatingRoundId(roundId)
    try {
      const res = await acceptRecordingGeneralizationRound(recordingId, roundId)
      toast.success('已采纳该泛化轮次，已更新候选草稿')
      onGeneralizationUpdated(res.generalization, res.candidateDocument)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '采纳轮次失败')
    } finally {
      setOperatingRoundId(null)
    }
  }

  const handleRejectRound = async (roundId: string) => {
    setOperatingRoundId(roundId)
    try {
      const res = await rejectRecordingGeneralizationRound(recordingId, roundId)
      toast.info('已拒绝该泛化轮次')
      onGeneralizationUpdated(res.generalization, res.candidateDocument)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '拒绝轮次失败')
    } finally {
      setOperatingRoundId(null)
    }
  }

  const handleRevertRound = async (roundId: string) => {
    setOperatingRoundId(roundId)
    try {
      const res = await revertRecordingGeneralizationRound(recordingId, roundId)
      toast.info('已撤销该轮次及其后续改动')
      onGeneralizationUpdated(res.generalization, res.candidateDocument)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '撤销轮次失败')
    } finally {
      setOperatingRoundId(null)
    }
  }

  return (
    <div className='flex flex-col gap-5'>
      {/* 顶部意图目标上下文条 */}
      <div className='flex items-center justify-between rounded-lg border border-border-card bg-muted/30 px-3.5 py-2.5 shadow-sm'>
        <div className='flex items-center gap-2.5 text-body'>
          {selectedStepId ? (
            <>
              <Target className='size-4 text-primary shrink-0' />
              <div className='flex items-center gap-1.5'>
                <span className='text-muted-foreground'>当前锚定步骤：</span>
                <Badge variant='secondary' className='font-mono font-medium text-foreground'>
                  {selectedStepName ? `${selectedStepName} (${selectedStepId})` : selectedStepId}
                </Badge>
              </div>
            </>
          ) : (
            <>
              <FileText className='size-4 text-muted-foreground shrink-0' />
              <span className='text-muted-foreground'>
                当前处于 <strong className='text-foreground font-medium'>整篇草稿模式</strong>（若需针对特定步骤调参/取数，可在流水线上选中该步骤）
              </span>
            </>
          )}
        </div>
        {selectedStepId && onClearSelection ? (
          <Button
            variant='ghost'
            size='sm'
            onClick={onClearSelection}
            className='h-7 gap-1 text-label text-muted-foreground hover:text-foreground'
          >
            <X className='size-3.5' />
            清除锚定（转为整份草稿）
          </Button>
        ) : null}
      </div>

      {/* 规则类快捷泛化 */}
      <Card className='border-border-card bg-card shadow-card'>
        <CardHeader className='pb-3'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <Zap className='size-4 text-primary' />
              <CardTitle className='text-body font-semibold text-foreground'>规则类快捷泛化</CardTitle>
            </div>
            {isLocked ? (
              <Badge variant='outline' className='border-status-warning-accent/40 text-label text-status-warning-foreground'>
                已回填锁定
              </Badge>
            ) : null}
          </div>
          <CardDescription>
            一键应用确定性模式规则，快速优化草稿健壮度。
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-wrap gap-2 pt-0'>
          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('relax_timeout')}
            className='gap-1.5'
          >
            {submittingAction === 'relax_timeout' ? <Loader2 className='size-3.5 animate-spin' /> : <Clock className='size-3.5 text-primary' />}
            放宽等待调参
          </Button>

          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('parameterize')}
            className='gap-1.5'
          >
            {submittingAction === 'parameterize' ? <Loader2 className='size-3.5 animate-spin' /> : <SlidersHorizontal className='size-3.5 text-primary' />}
            脱敏值参数化
          </Button>

          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('expect_outcome')}
            className='gap-1.5'
          >
            {submittingAction === 'expect_outcome' ? <Loader2 className='size-3.5 animate-spin' /> : <CheckCircle2 className='size-3.5 text-primary' />}
            期待成功条件
          </Button>

          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('clean_login')}
            className='gap-1.5'
          >
            {submittingAction === 'clean_login' ? <Loader2 className='size-3.5 animate-spin' /> : <KeyRound className='size-3.5 text-primary' />}
            清洗登录凭据
          </Button>

          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('clean_misfires')}
            className='gap-1.5'
          >
            {submittingAction === 'clean_misfires' ? <Loader2 className='size-3.5 animate-spin' /> : <Eraser className='size-3.5 text-primary' />}
            误触清洗
          </Button>

          <Button
            variant='outline'
            size='sm'
            disabled={!canWrite || isLocked || submittingAction !== null}
            onClick={() => void handleQuickAction('extract')}
            className='gap-1.5'
          >
            {submittingAction === 'extract' ? <Loader2 className='size-3.5 animate-spin' /> : <Database className='size-3.5 text-primary' />}
            关联数据集样本
          </Button>
        </CardContent>
      </Card>

      {/* 自然语言意图泛化 */}
      <Card className='border-border-card bg-card shadow-card'>
        <CardHeader className='pb-3'>
          <div className='flex items-center gap-2'>
            <Sparkles className='size-4 text-primary' />
            <CardTitle className='text-body font-semibold text-foreground'>自然语言意图泛化</CardTitle>
          </div>
          <CardDescription>
            以自然语言提出修改意图（如「将第 2 步的查询参数化，并在末尾断言查询成功」）。
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3 pt-0'>
          {/* 澄清与拦截引导卡片 */}
          {lastClarification ? (
            <div className='flex items-start justify-between gap-3 rounded-md border border-status-warning-accent/40 bg-status-warning-background p-3 text-body text-foreground shadow-sm'>
              <div className='flex items-start gap-2.5'>
                <ShieldAlert className='size-4 text-status-warning-foreground mt-0.5 shrink-0' />
                <div className='flex flex-col gap-0.5'>
                  <span className='font-semibold text-status-warning-foreground'>
                    泛化意图拦截与澄清引导
                  </span>
                  <span className='text-muted-foreground text-label leading-relaxed'>
                    {lastClarification.message}
                  </span>
                </div>
              </div>
              <Button
                variant='ghost'
                size='icon'
                onClick={() => setLastClarification(null)}
                className='size-6 text-muted-foreground hover:text-foreground shrink-0'
              >
                <X className='size-3.5' />
              </Button>
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSubmitIntent()
            }}
            className='flex gap-2'
          >
            <Input
              value={intentInput}
              onChange={(e) => setIntentInput(e.target.value)}
              placeholder={
                selectedStepId
                  ? '输入针对当前步骤或整份草稿的泛化意图（如：多等一会儿、改成参数）...'
                  : '输入泛化意图指令（如：把客户名称改成参数、确认看到保存成功）...'
              }
              disabled={!canWrite || isLocked || submittingAction !== null}
              className='flex-1'
            />
            <Button
              type='submit'
              disabled={!canWrite || isLocked || !intentInput.trim() || submittingAction !== null}
              className='gap-1.5 shrink-0'
            >
              {submittingAction === 'intent' ? <Loader2 className='size-4 animate-spin' /> : <Send className='size-4' />}
              提交
            </Button>
          </form>

          {/* 推荐正例与常见负例 Pills */}
          <div className='flex flex-col gap-2 pt-1 border-t border-border-card/40'>
            <div className='flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
              <span className='flex items-center gap-1 font-medium text-foreground mr-1'>
                <HelpCircle className='size-3 text-primary' />
                推荐正例:
              </span>
              {[
                '这一步多等一会儿',
                '把这里的输入值改成参数',
                '确认看到预期保存成功',
                '把这里的工单数量取出来',
              ].map((pill) => (
                <button
                  key={pill}
                  type='button'
                  disabled={!canWrite || isLocked || submittingAction !== null}
                  onClick={() => {
                    setIntentInput(pill)
                  }}
                  className='rounded-md border border-border-card bg-muted/40 px-2 py-0.5 text-label hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50'
                >
                  {pill}
                </button>
              ))}
            </div>

            <div className='flex flex-wrap items-center gap-1.5 text-label text-muted-foreground'>
              <span className='flex items-center gap-1 font-medium text-status-warning-foreground mr-1'>
                <AlertCircle className='size-3' />
                边界防呆体验 (负例):
              </span>
              {[
                '帮我优化一下',
                '对每个客户都点击一次',
                '把密码写死为 Abc123456',
                '把这一步移到最前面',
                '如果失败就跳过',
              ].map((pill) => (
                <button
                  key={pill}
                  type='button'
                  disabled={!canWrite || isLocked || submittingAction !== null}
                  onClick={() => {
                    setIntentInput(pill)
                  }}
                  className='rounded-md border border-status-warning-accent/20 bg-status-warning-background px-2 py-0.5 text-label text-status-warning-foreground hover:border-status-warning-accent/40 hover:bg-status-warning-background/70 transition-colors disabled:opacity-50'
                >
                  {pill}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 轮次历史与差异卡片 */}
      <div className='flex flex-col gap-3'>
        <div className='flex items-center justify-between'>
          <h3 className='text-body font-semibold text-foreground'>
            泛化轮次历史 ({rounds.length})
          </h3>
          <span className='text-label text-muted-foreground'>按先后顺序累积生效</span>
        </div>

        {rounds.length === 0 ? (
          <div className='flex h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-card bg-card p-6 text-center text-muted-foreground shadow-card'>
            <FileDiff className='size-6 text-muted-foreground/60' />
            <p className='text-label'>尚未生成任何泛化轮次，点击上方操作快速发起。</p>
          </div>
        ) : (
          <div className='flex flex-col gap-3'>
            {rounds.map((round, rIndex) => {
              const isOperating = operatingRoundId === round.roundId
              const status = round.status
              const opsCount = round.operations?.length ?? 0
              const patchCount = round.decisionPatches?.length ?? 0

              return (
                <div
                  key={round.roundId}
                  className={`flex flex-col gap-3 rounded-lg border p-4 shadow-card transition-colors ${
                    status === 'proposed'
                      ? 'border-status-warning-accent/50 bg-status-warning-background'
                      : status === 'accepted'
                      ? 'border-status-success-accent/40 bg-card'
                      : 'border-border-card bg-muted/20 opacity-75'
                  }`}
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <div className='flex items-center gap-2'>
                      <span className='flex size-5 items-center justify-center rounded bg-muted font-mono text-label font-semibold text-muted-foreground'>
                        R{rIndex + 1}
                      </span>
                      <span className='font-medium text-foreground'>
                        {round.intent || `快捷规则：${round.operations[0]?.kind ?? round.roundId.slice(0, 8)}`}
                      </span>
                    </div>

                    <div className='flex items-center gap-2'>
                      {status === 'proposed' ? (
                        <Badge variant='outline' className='border-status-warning-accent text-status-warning-foreground'>
                          待审查
                        </Badge>
                      ) : status === 'accepted' ? (
                        <Badge variant='outline' className='border-status-success-accent text-status-success-foreground'>
                          已采纳
                        </Badge>
                      ) : status === 'rejected' ? (
                        <Badge variant='secondary' className='text-muted-foreground'>
                          已拒绝
                        </Badge>
                      ) : (
                        <Badge variant='secondary' className='text-muted-foreground'>
                          已撤销
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* 差异概述 */}
                  <div className='flex flex-wrap gap-2 text-label text-muted-foreground'>
                    {opsCount > 0 ? (
                      <span className='rounded bg-muted/60 px-2 py-0.5'>
                        {opsCount} 项操作 ({round.operations.map((o) => o.kind).join(', ')})
                      </span>
                    ) : null}
                    {patchCount > 0 ? (
                      <span className='rounded bg-muted/60 px-2 py-0.5'>
                        {patchCount} 项决策修正
                      </span>
                    ) : null}
                  </div>

                  {/* 差异卡片详情展示 */}
                  {round.operations.length > 0 ? (
                    <div className='space-y-1.5 rounded-md border border-border-card/40 bg-background/50 p-2.5 text-label font-mono'>
                      {round.operations.map((op, oIdx) => (
                        <div key={oIdx} className='flex items-center gap-2 text-muted-foreground'>
                          <span className='font-semibold text-primary'>[{op.kind}]</span>
                          {op.kind === 'set_step_policy' ? (
                            <span>步骤 {op.stepId.slice(0, 8)} 策略调整 (超时 {String(op.timeoutMs ?? '')}ms)</span>
                          ) : op.kind === 'add_outcome' ? (
                            <span>步骤 {op.stepId.slice(0, 8)} 添加成功条件「{op.meaning}」</span>
                          ) : op.kind === 'insert_step' ? (
                            <span>在位置 {op.anchorStepId?.slice(0, 8) ?? 'start'} 插入步骤「{op.step.name}」</span>
                          ) : op.kind === 'remove_step' ? (
                            <span>移除步骤 {op.stepId.slice(0, 8)}</span>
                          ) : (
                            <span>更新步骤 {op.stepId.slice(0, 8)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* 轮次审查与撤销操作 */}
                  {canWrite && !isLocked ? (
                    <div className='flex items-center justify-end gap-2 border-t border-border-card/40 pt-2'>
                      {status === 'proposed' ? (
                        <>
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={isOperating}
                            onClick={() => void handleRejectRound(round.roundId)}
                            className='gap-1 text-label'
                          >
                            <XCircle className='size-3.5 text-destructive' />
                            拒绝
                          </Button>
                          <Button
                            size='sm'
                            disabled={isOperating}
                            onClick={() => void handleAcceptRound(round.roundId)}
                            className='gap-1 text-label'
                          >
                            {isOperating ? <Loader2 className='size-3.5 animate-spin' /> : <CheckCircle2 className='size-3.5' />}
                            采纳变动
                          </Button>
                        </>
                      ) : status === 'accepted' ? (
                        <Button
                          variant='ghost'
                          size='sm'
                          disabled={isOperating}
                          onClick={() => void handleRevertRound(round.roundId)}
                          className='gap-1 text-label text-muted-foreground hover:text-foreground'
                        >
                          {isOperating ? <Loader2 className='size-3.5 animate-spin' /> : <RotateCcw className='size-3.5' />}
                          撤销此轮变动
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
