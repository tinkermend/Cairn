import { useState } from 'react'
import type { JsonValue } from '@cairn/shared'
import {
  BookmarkPlus,
  CheckCircle2,
  Clock,
  Pencil,
  Play,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export interface ModuleTestFixture {
  id: string
  name: string
  description?: string
  inputs: Record<string, JsonValue>
  expectedOutputs?: Record<string, JsonValue>
  targetAccountId?: string
  implementationKey?: string
  lastRun?: {
    runId: string
    outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
    durationMs?: number
    executedAt: string
  }
}

export interface ModuleFixturesPanelProps {
  moduleId: string
  fixtures: ModuleTestFixture[]
  onUpdateFixtures: (fixtures: ModuleTestFixture[]) => void
  contractInputs: Array<{
    key: string
    label?: string
    valueType: string
    required?: boolean
    description?: string
  }>
  canWrite: boolean
  onRunFixture: (fixture: ModuleTestFixture) => void
}

export function ModuleFixturesPanel({
  moduleId: _moduleId,
  fixtures,
  onUpdateFixtures,
  contractInputs,
  canWrite,
  onRunFixture,
}: ModuleFixturesPanelProps) {
  const [editingFixture, setEditingFixture] = useState<ModuleTestFixture | null>(
    null
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formInputs, setFormInputs] = useState<Record<string, string>>({})

  const openCreateDialog = () => {
    setEditingFixture(null)
    setFormName('')
    setFormDesc('')
    const initial: Record<string, string> = {}
    for (const input of contractInputs) {
      initial[input.key] = ''
    }
    setFormInputs(initial)
    setDialogOpen(true)
  }

  const openEditDialog = (fixture: ModuleTestFixture) => {
    setEditingFixture(fixture)
    setFormName(fixture.name)
    setFormDesc(fixture.description || '')
    const initial: Record<string, string> = {}
    for (const input of contractInputs) {
      const val = fixture.inputs[input.key]
      if (val === undefined || val === null) {
        initial[input.key] = ''
      } else if (typeof val === 'object') {
        initial[input.key] = JSON.stringify(val)
      } else {
        initial[input.key] = String(val)
      }
    }
    setFormInputs(initial)
    setDialogOpen(true)
  }

  const handleSaveFixture = () => {
    if (!formName.trim()) {
      toast.error('请输入用例名称')
      return
    }

    const parsedInputs: Record<string, JsonValue> = {}
    for (const input of contractInputs) {
      const raw = formInputs[input.key]
      if (raw !== undefined && raw !== '') {
        if (input.valueType === 'number') {
          const num = Number(raw)
          parsedInputs[input.key] = Number.isNaN(num) ? raw : num
        } else if (input.valueType === 'boolean') {
          parsedInputs[input.key] = raw === 'true' || raw === '1'
        } else if (input.valueType === 'json') {
          try {
            parsedInputs[input.key] = JSON.parse(raw) as JsonValue
          } catch {
            parsedInputs[input.key] = raw
          }
        } else {
          parsedInputs[input.key] = raw
        }
      }
    }

    if (editingFixture) {
      const updated = fixtures.map((f) =>
        f.id === editingFixture.id
          ? {
              ...f,
              name: formName.trim(),
              description: formDesc.trim() || undefined,
              inputs: parsedInputs,
            }
          : f
      )
      onUpdateFixtures(updated)
      toast.success('已更新测试用例')
    } else {
      const newFixture: ModuleTestFixture = {
        id: crypto.randomUUID(),
        name: formName.trim(),
        description: formDesc.trim() || undefined,
        inputs: parsedInputs,
      }
      onUpdateFixtures([...fixtures, newFixture])
      toast.success('已添加测试用例')
    }
    setDialogOpen(false)
  }

  const handleDeleteFixture = (id: string) => {
    onUpdateFixtures(fixtures.filter((f) => f.id !== id))
    toast.success('已删除测试用例')
  }

  return (
    <div className='space-y-4'>
      {/* 顶栏说明与操作 */}
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h3 className='text-section font-semibold'>模块测试用例套件</h3>
          <p className='text-small text-muted-foreground'>
            预设入参用例随模块版本一同导出与复用，支持一键发起试跑与回归比对。
          </p>
        </div>
        {canWrite && (
          <Button
            type='button'
            size='sm'
            className='h-8 gap-1.5 text-label'
            onClick={openCreateDialog}
          >
            <Plus className='size-3.5' />
            添加用例
          </Button>
        )}
      </div>

      {/* 用例列表 */}
      {fixtures.length === 0 ? (
        <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center shadow-card'>
          <BookmarkPlus className='mb-3 size-10 text-muted-foreground/50' />
          <h4 className='text-body font-medium text-foreground'>
            暂无测试用例
          </h4>
          <p className='mt-1 max-w-sm text-small text-muted-foreground'>
            您可以在顶部点击「试跑」，并在运行完成后直接「另存为用例」；也可以点击上方「添加用例」手工录入。
          </p>
          {canWrite && (
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='mt-4 text-label'
              onClick={openCreateDialog}
            >
              新建首个用例
            </Button>
          )}
        </div>
      ) : (
        <div className='grid gap-3'>
          {fixtures.map((fixture) => {
            const inputKeys = Object.keys(fixture.inputs)
            return (
              <div
                key={fixture.id}
                className='flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-card transition-colors hover:border-primary/40'
              >
                <div className='flex items-start justify-between gap-3'>
                  <div className='space-y-1'>
                    <div className='flex items-center gap-2'>
                      <span className='text-body font-semibold text-foreground'>
                        {fixture.name}
                      </span>
                      {fixture.lastRun && (
                        <Badge
                          variant='outline'
                          className={
                            fixture.lastRun.outcome === 'SUCCEEDED'
                              ? 'border-status-success-accent bg-status-success-background text-status-success-foreground text-label font-medium'
                              : 'border-destructive/30 bg-destructive/10 text-destructive text-label font-medium'
                          }
                        >
                          {fixture.lastRun.outcome === 'SUCCEEDED' ? (
                            <span className='flex items-center gap-1'>
                              <CheckCircle2 className='size-3' />
                              通过
                            </span>
                          ) : (
                            <span className='flex items-center gap-1'>
                              <XCircle className='size-3' />
                              失败
                            </span>
                          )}
                          {fixture.lastRun.durationMs !== undefined && (
                            <span className='ms-1 text-label'>
                              {Math.round(fixture.lastRun.durationMs / 100) / 10}s
                            </span>
                          )}
                        </Badge>
                      )}
                    </div>
                    {fixture.description && (
                      <p className='text-small text-muted-foreground'>
                        {fixture.description}
                      </p>
                    )}
                  </div>

                  {/* 用例操作按钮 */}
                  <div className='flex items-center gap-1.5 shrink-0'>
                    <Button
                      type='button'
                      size='sm'
                      className='h-8 gap-1 text-label'
                      onClick={() => onRunFixture(fixture)}
                    >
                      <Play className='size-3 fill-current' />
                      运行用例
                    </Button>
                    {canWrite && (
                      <>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          className='size-8 p-0'
                          title='编辑用例'
                          onClick={() => openEditDialog(fixture)}
                        >
                          <Pencil className='size-3.5' />
                        </Button>
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='size-8 p-0 text-muted-foreground hover:text-destructive'
                          title='删除用例'
                          onClick={() => handleDeleteFixture(fixture.id)}
                        >
                          <Trash2 className='size-3.5' />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* 参数摘要 */}
                <div className='rounded-lg bg-muted/40 p-2.5'>
                  <div className='mb-1 text-label font-medium text-muted-foreground'>
                    预设入参 ({inputKeys.length})：
                  </div>
                  {inputKeys.length > 0 ? (
                    <div className='flex flex-wrap gap-1.5'>
                      {inputKeys.map((key) => {
                        const val = fixture.inputs[key]
                        const valStr =
                          typeof val === 'object' && val !== null
                            ? JSON.stringify(val)
                            : String(val)
                        return (
                          <span
                            key={key}
                            className='inline-flex items-center gap-1 rounded border border-border/80 bg-background px-2 py-0.5 font-mono text-label text-foreground'
                          >
                            <span className='text-muted-foreground'>{key}:</span>
                            <span className='truncate max-w-[200px]'>
                              {valStr}
                            </span>
                          </span>
                        )
                      })}
                    </div>
                  ) : (
                    <span className='text-label text-muted-foreground'>
                      无入参（空调用）
                    </span>
                  )}
                </div>

                {fixture.lastRun?.executedAt && (
                  <div className='flex items-center gap-1 text-label text-muted-foreground'>
                    <Clock className='size-3' />
                    <span>
                      上次运行于{' '}
                      {new Date(fixture.lastRun.executedAt).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 创建 / 编辑用例对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>
              {editingFixture ? '编辑测试用例' : '新建测试用例'}
            </DialogTitle>
            <DialogDescription className='text-label text-muted-foreground'>
              配置此用例的固定入参数据。用例将被保存在模块测试套件中。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4 py-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='fixture-form-name' className='text-label'>
                用例名称 <span className='text-destructive'>*</span>
              </Label>
              <Input
                id='fixture-form-name'
                placeholder='如: 正向查询用例 / 边界值校验'
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className='h-8 text-label'
              />
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='fixture-form-desc' className='text-label'>
                用例描述
              </Label>
              <Input
                id='fixture-form-desc'
                placeholder='描述该用例的测试意图或覆盖边界'
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                className='h-8 text-label'
              />
            </div>

            <div className='space-y-3 rounded-lg border border-border bg-muted/20 p-3'>
              <div className='text-label font-medium text-foreground'>
                输入参数配置 ({contractInputs.length})
              </div>
              {contractInputs.length === 0 ? (
                <p className='text-label text-muted-foreground'>
                  该动作模块没有声明任何输入参数契约。
                </p>
              ) : (
                contractInputs.map((input) => (
                  <div key={input.key} className='space-y-1'>
                    <Label
                      htmlFor={`fixture-input-${input.key}`}
                      className='flex items-center gap-1.5 font-mono text-label'
                    >
                      <span>{input.key}</span>
                      <span className='text-muted-foreground font-sans'>
                        ({input.valueType})
                      </span>
                      {input.required && (
                        <span className='text-destructive font-sans'>*</span>
                      )}
                    </Label>
                    {input.valueType === 'json' ? (
                      <Textarea
                        id={`fixture-input-${input.key}`}
                        rows={3}
                        placeholder='{"key": "value"}'
                        className='font-mono text-label'
                        value={formInputs[input.key] || ''}
                        onChange={(e) =>
                          setFormInputs((prev) => ({
                            ...prev,
                            [input.key]: e.target.value,
                          }))
                        }
                      />
                    ) : (
                      <Input
                        id={`fixture-input-${input.key}`}
                        placeholder={
                          input.description || `请输入 ${input.key}`
                        }
                        className='h-8 font-mono text-label'
                        value={formInputs[input.key] || ''}
                        onChange={(e) =>
                          setFormInputs((prev) => ({
                            ...prev,
                            [input.key]: e.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='text-label'
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              type='button'
              size='sm'
              className='text-label'
              onClick={handleSaveFixture}
            >
              保存用例
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
