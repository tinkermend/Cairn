import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  EFFECT_TYPES,
  FIXTURE_STEP_TYPES,
  type CreateScenarioBody,
  type EffectType,
  type FixtureStepType,
  type Step,
} from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { createScenario } from '@/lib/scenarios-api'
import { fetchTargets } from '@/lib/targets-api'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EFFECT_TYPE_LABELS, STEP_TYPE_LABELS } from './labels'

type DraftStep = {
  key: string
  name: string
  type: FixtureStepType
  effectType: EffectType
  value: string
  from: string
  durationMs: string
  failMessage: string
  outputKey: string
}

function emptyStep(): DraftStep {
  return {
    key: crypto.randomUUID(),
    name: '',
    type: 'echo',
    effectType: 'READ_ONLY',
    value: '',
    from: '',
    durationMs: '100',
    failMessage: '主动失败',
    outputKey: '',
  }
}

function newStepId(): string {
  return crypto.randomUUID()
}

function toStep(draft: DraftStep): Step {
  const id = newStepId()
  const name = draft.name.trim() || STEP_TYPE_LABELS[draft.type]
  const outputKey = draft.outputKey.trim() || undefined
  if (draft.type === 'echo') {
    const from = draft.from.trim()
    return {
      id,
      name,
      type: 'echo',
      effectType: draft.effectType,
      outputKey,
      input: from ? { from } : { value: draft.value },
    }
  }
  if (draft.type === 'delay') {
    return {
      id,
      name,
      type: 'delay',
      effectType: draft.effectType,
      outputKey,
      input: { durationMs: Number(draft.durationMs) || 100 },
    }
  }
  return {
    id,
    name,
    type: 'fail',
    effectType: draft.effectType,
    outputKey,
    input: { message: draft.failMessage.trim() || '主动失败' },
  }
}

type ScenarioCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}

export function ScenarioCreateDialog({ open, onOpenChange, onCreated }: ScenarioCreateDialogProps) {
  const targets = useQuery({ queryKey: ['targets'], queryFn: fetchTargets, enabled: open })
  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState('')
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()])
  const [saving, setSaving] = useState(false)
  const items = targets.data?.items ?? []

  const canSubmit = useMemo(
    () => name.trim().length > 0 && targetId.length > 0 && steps.length > 0,
    [name, targetId, steps.length],
  )

  function reset() {
    setName('')
    setTargetId('')
    setSteps([emptyStep()])
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>新建场景</DialogTitle>
          <DialogDescription>
            最小可运行定义：绑定一个目标系统，再写下有序的 echo / delay / fail
            步骤。这不是编排画布。
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='scenario-name'>名称</Label>
            <Input
              id='scenario-name'
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label>目标系统</Label>
            <Select value={targetId || undefined} onValueChange={setTargetId}>
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='选择要仿真的目标系统' />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <Label>步骤</Label>
              <Button type='button' variant='outline' size='sm' onClick={() => setSteps((prev) => [...prev, emptyStep()])}>
                添加步骤
              </Button>
            </div>
            {steps.map((step, index) => (
              <div key={step.key} className='space-y-2 rounded-md border border-border-card p-3'>
                <div className='flex items-center justify-between'>
                  <p className='text-label text-muted-foreground'>步骤 {index + 1}</p>
                  {steps.length > 1 ? (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => setSteps((prev) => prev.filter((item) => item.key !== step.key))}
                    >
                      移除
                    </Button>
                  ) : null}
                </div>
                <Input
                  placeholder='步骤名称'
                  value={step.name}
                  onChange={(event) =>
                    setSteps((prev) =>
                      prev.map((item) => (item.key === step.key ? { ...item, name: event.target.value } : item)),
                    )
                  }
                />
                <div className='grid gap-2 sm:grid-cols-2'>
                  <Select
                    value={step.type}
                    onValueChange={(value) =>
                      setSteps((prev) =>
                        prev.map((item) =>
                          item.key === step.key ? { ...item, type: value as FixtureStepType } : item,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIXTURE_STEP_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {STEP_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={step.effectType}
                    onValueChange={(value) =>
                      setSteps((prev) =>
                        prev.map((item) =>
                          item.key === step.key ? { ...item, effectType: value as EffectType } : item,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EFFECT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {EFFECT_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {step.type === 'echo' ? (
                  <div className='grid gap-2 sm:grid-cols-2'>
                    <Input
                      placeholder='value'
                      value={step.value}
                      onChange={(event) =>
                        setSteps((prev) =>
                          prev.map((item) => (item.key === step.key ? { ...item, value: event.target.value, from: '' } : item)),
                        )
                      }
                    />
                    <Input
                      placeholder='或 from（context 键）'
                      value={step.from}
                      onChange={(event) =>
                        setSteps((prev) =>
                          prev.map((item) => (item.key === step.key ? { ...item, from: event.target.value, value: '' } : item)),
                        )
                      }
                    />
                  </div>
                ) : null}
                {step.type === 'delay' ? (
                  <Input
                    placeholder='等待毫秒'
                    value={step.durationMs}
                    onChange={(event) =>
                      setSteps((prev) =>
                        prev.map((item) => (item.key === step.key ? { ...item, durationMs: event.target.value } : item)),
                      )
                    }
                  />
                ) : null}
                {step.type === 'fail' ? (
                  <Input
                    placeholder='失败说明'
                    value={step.failMessage}
                    onChange={(event) =>
                      setSteps((prev) =>
                        prev.map((item) => (item.key === step.key ? { ...item, failMessage: event.target.value } : item)),
                      )
                    }
                  />
                ) : null}
                <Input
                  placeholder='可选 outputKey'
                  value={step.outputKey}
                  onChange={(event) =>
                    setSteps((prev) =>
                      prev.map((item) => (item.key === step.key ? { ...item, outputKey: event.target.value } : item)),
                    )
                  }
                />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!canSubmit || saving}
            onClick={() => {
              const body: CreateScenarioBody = {
                targetId,
                name: name.trim(),
                steps: steps.map(toStep),
              }
              setSaving(true)
              void createScenario(body)
                .then((created) => {
                  toast.success('场景已创建')
                  reset()
                  onOpenChange(false)
                  onCreated(created.id)
                })
                .catch((error) => {
                  toast.error(error instanceof ApiRequestError ? error.message : '创建失败')
                })
                .finally(() => setSaving(false))
            }}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
