import { useState } from 'react'
import type { SuiteDocument } from '@cairn/shared'
import { ChevronDown, ChevronRight, FileText, Sliders, Variable } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { KeyValueEditor } from '../key-value-editor'
import { ReportProfileEditor, ReportProfileSelect } from '@/features/reports/profiles'
import { useCan } from '@/hooks/use-permissions'

export function SuiteInspector({
  name,
  description,
  document,
  isStageMode = false,
  canWrite,
  targetAccounts,
  targetId,
  onUpdateName,
  onUpdateDescription,
  onUpdateDocument,
}: {
  name: string
  description: string
  document: SuiteDocument
  isStageMode?: boolean
  canWrite: boolean
  targetAccounts: Array<{ id: string; displayName: string; username: string }>
  targetId: string
  onUpdateName: (name: string) => void
  onUpdateDescription: (desc: string) => void
  onUpdateDocument: (updater: (doc: SuiteDocument) => SuiteDocument) => void
}) {
  const [sharedParamsOpen, setSharedParamsOpen] = useState(true)
  const [reportsOpen, setReportsOpen] = useState(true)
  const canExport = useCan('report:export')

  const sharedInputCount = Object.keys(document.sharedInput ?? {}).length

  return (
    <div className='flex flex-col gap-4'>
      {/* 1. Basic Info Card */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
        <div className='flex items-center gap-2'>
          <h3 className='text-title font-semibold'>基本信息</h3>
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='suite-detail-name'>名称</Label>
          <Input
            id='suite-detail-name'
            value={name ?? ''}
            disabled={!canWrite}
            placeholder='输入场景集名称'
            className='h-8 text-body'
            onChange={(e) => onUpdateName(e.target.value)}
          />
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='suite-detail-desc'>说明</Label>
          <Textarea
            id='suite-detail-desc'
            value={description ?? ''}
            rows={2}
            disabled={!canWrite}
            placeholder='说明此场景集的用途与执行目标（可选）'
            className='text-body'
            onChange={(e) => onUpdateDescription(e.target.value)}
          />
        </div>
      </Card>

      {/* 2. Execution and Concurrency Policy Card */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3.5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Sliders className='size-4 text-muted-foreground' />
            <h3 className='text-title font-semibold'>
              {isStageMode ? '流水线执行与配额策略' : '执行与并发策略'}
            </h3>
          </div>
          <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
            {isStageMode
              ? `配额上限 (${document.maxConcurrency ?? 3})`
              : document.executionMode === 'sequential'
                ? '严格串行'
                : `受控并发 (${document.maxConcurrency ?? 3})`}
          </Badge>
        </div>

        {isStageMode ? (
          <div className='rounded-lg border border-border-divider/70 bg-muted/40 p-2.5 text-label space-y-1.5'>
            <div className='flex items-center justify-between'>
              <span className='font-medium text-foreground text-xs'>阶段流水线编排已生效</span>
              <span className='text-3xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded'>各阶段独立配置</span>
            </div>
            <p className='text-muted-foreground text-3xs leading-relaxed'>
              各阶段按顺序依赖执行。阶段内部的并发数与失败策略由左侧阶段卡片独立控制；右侧此面板配置整条流水线的全局 Worker 资源池上限与全局兜底策略。
            </p>
          </div>
        ) : null}

        <div className='grid gap-3'>
          {isStageMode ? (
            <div className='grid gap-1.5'>
              <Label htmlFor='suite-execution-mode'>流水线流转模式</Label>
              <div className='flex items-center justify-between h-8 px-3 rounded-md border border-border-divider bg-muted/30 text-label text-muted-foreground'>
                <span>阶段间依赖串行 · 阶段内策略独立</span>
                <Badge variant='secondary' className='text-3xs font-normal'>Stage 驱动</Badge>
              </div>
            </div>
          ) : (
            <div className='grid gap-1.5'>
              <Label htmlFor='suite-execution-mode'>执行模式</Label>
              <Select
                value={document.executionMode ?? 'parallel'}
                disabled={!canWrite}
                onValueChange={(value) =>
                  onUpdateDocument((doc) => ({
                    ...doc,
                    executionMode: value as SuiteDocument['executionMode'],
                  }))
                }
              >
                <SelectTrigger id='suite-execution-mode' aria-label='执行模式' className='h-8 text-label'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='parallel'>受控并发 (Worker 池)</SelectItem>
                  <SelectItem value='sequential'>严格串行 (单活)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-max-concurrency'>
              {isStageMode ? '全局 Worker 配额上限 (1–10)' : '最大并发数 (1–10)'}
            </Label>
            <Input
              id='suite-max-concurrency'
              aria-label='最大并发数 (1–10)'
              type='number'
              min={1}
              max={10}
              value={document.maxConcurrency ?? 3}
              disabled={!canWrite || (!isStageMode && document.executionMode === 'sequential')}
              className='h-8 text-label'
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                if (!Number.isNaN(val)) {
                  onUpdateDocument((doc) => ({
                    ...doc,
                    maxConcurrency: Math.max(1, Math.min(10, val)),
                  }))
                }
              }}
            />
            {isStageMode ? (
              <span className='text-3xs text-muted-foreground'>
                控制场景集任意时刻分配的 Worker 最大数量。各阶段设置的并发数均以此上限为封顶阈值。
              </span>
            ) : null}
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-failure-policy'>
              {isStageMode ? '流水线全局熔断策略' : '失败策略'}
            </Label>
            <Select
              value={document.failurePolicy}
              disabled={!canWrite}
              onValueChange={(value) =>
                onUpdateDocument((doc) => ({
                  ...doc,
                  failurePolicy: value as SuiteDocument['failurePolicy'],
                }))
              }
            >
              <SelectTrigger id='suite-failure-policy' aria-label='失败策略' className='h-8 text-label'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='continue'>
                  {isStageMode ? '阶段自主决策 (允许阶段内配置遇错即停或继续)' : '失败后继续'}
                </SelectItem>
                <SelectItem value='stop'>
                  {isStageMode ? '全局快速熔断 (任一阶段失败立即停止整条流水线)' : '失败后停止后续'}
                </SelectItem>
              </SelectContent>
            </Select>
            {isStageMode ? (
              <span className='text-3xs text-muted-foreground'>
                若设为全局快速熔断，任一阶段异常将立即阻断后续执行；若设为阶段自主决策，则按左侧各阶段自身的失败策略推进。
              </span>
            ) : null}
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='suite-default-target-account'>默认目标账号</Label>
            <Select
              value={document.defaultTargetAccountId ?? '__none__'}
              disabled={!canWrite}
              onValueChange={(value) =>
                onUpdateDocument((doc) => ({
                  ...doc,
                  defaultTargetAccountId: value === '__none__' ? undefined : value,
                }))
              }
            >
              <SelectTrigger id='suite-default-target-account' aria-label='默认目标账号' className='h-8 text-label'>
                <SelectValue placeholder='系统默认账号' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>系统默认账号</SelectItem>
                {targetAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.displayName} ({account.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className='text-label text-muted-foreground'>
          {isStageMode
            ? '受管账号独占策略下，若多个阶段或成员指定同一目标账号，调度器将自适应排队互斥，避免登录与会话冲突。'
            : '并发模式下最多同时放行指定数量的成员。受管账号独占策略下，若多个成员指定同一账号，调度器将自适应排队互斥，避免登录冲突。'}
        </p>
      </Card>

      {/* 3. Shared Inputs Card (Collapsible) */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div
          className='flex items-center justify-between cursor-pointer select-none'
          onClick={() => setSharedParamsOpen(!sharedParamsOpen)}
        >
          <div className='flex items-center gap-2'>
            <Variable className='size-4 text-muted-foreground' />
            <h2 className='text-title font-semibold'>全局公共参数 (Shared Input)</h2>
          </div>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              {sharedInputCount > 0 ? `已配置 ${sharedInputCount} 项` : '无公共参数'}
            </Badge>
            <Button variant='ghost' size='icon' className='size-6 text-muted-foreground'>
              {sharedParamsOpen ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
            </Button>
          </div>
        </div>

        {sharedParamsOpen ? (
          <div className='space-y-3 pt-1'>
            <p className='text-label text-muted-foreground'>
              发布并执行整集时，所有成员均可引用的公共输入键值。若成员未做单独覆盖，将以全局参数为准。
            </p>
            <KeyValueEditor
              value={document.sharedInput ?? {}}
              onChange={(sharedInput) =>
                onUpdateDocument((doc) => ({ ...doc, sharedInput }))
              }
              disabled={!canWrite}
              placeholderKey='公共参数名 (如 region / tenantId)'
              placeholderValue='公共参数值 (如 cn-north-1 / 1001)'
            />
          </div>
        ) : null}
      </Card>

      {/* 4. Consolidated Report Card (Collapsible) */}
      <Card className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div
          className='flex items-center justify-between cursor-pointer select-none'
          onClick={() => setReportsOpen(!reportsOpen)}
        >
          <div className='flex items-center gap-2'>
            <FileText className='size-4 text-muted-foreground' />
            <h2 className='text-title font-semibold'>集合报告</h2>
          </div>
          <div className='flex items-center gap-2'>
            <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
              {document.reportProfileId ? '已绑定模板' : '系统默认'}
            </Badge>
            <Button variant='ghost' size='icon' className='size-6 text-muted-foreground'>
              {reportsOpen ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
            </Button>
          </div>
        </div>

        {reportsOpen ? (
          <div className='space-y-3 pt-1'>
            <ReportProfileSelect
              targetId={targetId}
              source='SUITE_RUN'
              value={document.reportProfileId}
              disabled={!canWrite}
              onChange={(reportProfileId) =>
                onUpdateDocument((doc) => ({ ...doc, reportProfileId }))
              }
            />

            <div className='space-y-3 rounded-md border border-border-default/60 p-3 bg-muted/20'>
              <label className='flex items-start gap-2 text-body cursor-pointer'>
                <input
                  type='checkbox'
                  disabled={!canWrite || !canExport}
                  checked={document.outputPolicy?.autoGenerateReport ?? document.autoGenerateFinalReport}
                  className='mt-1'
                  onChange={(event) =>
                    onUpdateDocument((doc) => ({
                      ...doc,
                      autoGenerateFinalReport: event.target.checked,
                      outputPolicy: {
                        ...doc.outputPolicy,
                        autoGenerateReport: event.target.checked,
                        memberReportPolicy: doc.outputPolicy?.memberReportPolicy ?? 'inherit',
                        aiSummaryPolicy: doc.outputPolicy?.aiSummaryPolicy ?? 'inherit',
                      },
                    }))
                  }
                />
                <div>
                  <div className='font-medium text-foreground'>自动生成集合总报告</div>
                  <div className='text-xs text-muted-foreground'>
                    场景集全部成员运行完成并结算证据后，自动触发生成集合总报告与 Word / PDF。
                  </div>
                  {!canExport && canWrite ? (
                    <div className='text-xs text-amber-600 mt-1'>
                      开启自动生成报告需要导出权限 (report:export)
                    </div>
                  ) : null}
                </div>
              </label>

              {(document.outputPolicy?.autoGenerateReport ?? document.autoGenerateFinalReport) ? (
                <label className='flex items-start gap-2 text-body cursor-pointer pt-2 border-t border-border-default/40'>
                  <input
                    type='checkbox'
                    disabled={!canWrite}
                    checked={document.outputPolicy?.memberReportPolicy === 'suppress'}
                    className='mt-1'
                    onChange={(event) =>
                      onUpdateDocument((doc) => ({
                        ...doc,
                        outputPolicy: {
                          ...doc.outputPolicy,
                          autoGenerateReport: true,
                          memberReportPolicy: event.target.checked ? 'suppress' : 'inherit',
                          aiSummaryPolicy: doc.outputPolicy?.aiSummaryPolicy ?? 'inherit',
                        },
                      }))
                    }
                  />
                  <div>
                    <div className='font-medium text-foreground'>抑制成员单场景报告</div>
                    <div className='text-xs text-muted-foreground'>
                      仅生成集合总报告，强制抑制子场景单报告导出，防止大集合并发耗尽 Worker 资源。
                    </div>
                  </div>
                </label>
              ) : null}
            </div>

            <p className='text-label text-muted-foreground'>
              配置随新运行冻结。生成失败单独记录，可从运行详情重试报告。
            </p>
            <ReportProfileEditor targetId={targetId} editScope='suite' />
          </div>
        ) : null}
      </Card>
    </div>
  )
}
