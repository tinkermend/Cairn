import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { moduleKeySchema, type ModuleExtractParameter } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { extractScenarioModule, previewScenarioModuleExtract } from '@/lib/scenarios-api'
import { MODULE_EFFECT_CEILING_LABELS } from '@/features/action-modules/labels'

function suggestKey(name: string) {
  const parts = name
    .toLowerCase()
    .replace(/[^a-z0-9.\s_-]+/g, ' ')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 3)
  const key = parts.join('.')
  return moduleKeySchema.safeParse(key).success ? key : 'extracted.module'
}

export function ModuleExtractWizard({
  open,
  onOpenChange,
  scenarioId,
  stepIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  stepIds: string[]
}) {
  const navigate = useNavigate()
  const preview = useQuery({
    queryKey: ['module-extract-preview', scenarioId, stepIds],
    queryFn: () => previewScenarioModuleExtract(scenarioId, { stepIds }),
    enabled: open && stepIds.length > 0,
  })
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [parameterizedIds, setParameterizedIds] = useState<string[]>([])
  const [confirmedPost, setConfirmedPost] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stepKey = stepIds.join(',')
  useEffect(() => {
    if (!open) return
    setName('')
    setKey('')
    setDescription('')
    setParameterizedIds([])
    setConfirmedPost([])
    setError('')
  }, [open, scenarioId, stepKey])
  const proposal = preview.data
  const keyOk = moduleKeySchema.safeParse(key).success
  const canSubmit = Boolean(proposal?.ok && name.trim() && keyOk && !busy)
  const parameterized = useMemo<ModuleExtractParameter[]>(() => {
    if (!proposal) return []
    return proposal.parameterizable
      .filter((item) => parameterizedIds.includes(item.stepId))
      .map((item) => ({ stepId: item.stepId, key: item.suggestedKey, label: item.suggestedLabel }))
  }, [parameterizedIds, proposal])
  const submit = async () => {
    if (!canSubmit || !proposal) return
    setBusy(true)
    setError('')
    try {
      const created = await extractScenarioModule(scenarioId, {
        stepIds,
        name: name.trim(),
        key,
        parameterized,
        confirmedPostconditionStepIds: confirmedPost,
        description: description.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      })
      onOpenChange(false)
      void navigate({ to: '/action-modules/$moduleId', params: { moduleId: created.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : '提炼失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>提炼为动作模块</DialogTitle>
          <DialogDescription>只创建模块草稿，不会改当前场景。发布后再用替换预览写回调用。</DialogDescription>
        </DialogHeader>
        {preview.isLoading ? <p className='text-body text-muted-foreground'>正在推断契约…</p> : null}
        {preview.isError ? <p role='alert' className='text-body text-destructive'>{preview.error.message}</p> : null}
        {proposal && !proposal.ok ? (
          <p role='alert' className='text-body text-destructive'>{proposal.error?.message ?? '选择无效'}</p>
        ) : null}
        {proposal?.ok ? (
          <div className='space-y-4 text-body'>
            <p>
              推断 {proposal.inputs.length} 个输入、{proposal.outputs.length} 个输出、副作用上限
              {MODULE_EFFECT_CEILING_LABELS[proposal.effectCeiling]}。
            </p>
            {proposal.inputs.length > 0 ? (
              <ul className='list-disc space-y-1 ps-5'>
                {proposal.inputs.map((item) => (
                  <li key={item.key}>{item.label}（{item.key} · {item.source}）</li>
                ))}
              </ul>
            ) : null}
            {proposal.outputs.length > 0 ? (
              <ul className='list-disc space-y-1 ps-5'>
                {proposal.outputs.map((item) => (
                  <li key={item.key}>输出 {item.label}（{item.key}）</li>
                ))}
              </ul>
            ) : null}
            {proposal.parameterizable.length > 0 ? (
              <section className='space-y-2'>
                <h3 className='text-section font-semibold'>可参数化的字面量</h3>
                {proposal.parameterizable.map((item) => (
                  <label key={item.stepId} className='flex items-start gap-3 rounded-md border p-3'>
                    <Checkbox
                      aria-label={`参数化 ${item.stepName}`}
                      checked={parameterizedIds.includes(item.stepId)}
                      onCheckedChange={(value) =>
                        setParameterizedIds((current) =>
                          value === true ? [...current, item.stepId] : current.filter((id) => id !== item.stepId),
                        )
                      }
                    />
                    <span>{item.stepName}：{String(item.value)} → {item.suggestedKey}</span>
                  </label>
                ))}
              </section>
            ) : null}
            {proposal.postconditionCandidates.length > 0 ? (
              <section className='space-y-2'>
                <h3 className='text-section font-semibold'>后置条件候选</h3>
                {proposal.postconditionCandidates.map((item) => (
                  <label key={item.stepId} className='flex items-start gap-3 rounded-md border p-3'>
                    <Checkbox
                      aria-label={`确认后置条件 ${item.name}`}
                      checked={confirmedPost.includes(item.stepId)}
                      onCheckedChange={(value) =>
                        setConfirmedPost((current) =>
                          value === true ? [...current, item.stepId] : current.filter((id) => id !== item.stepId),
                        )
                      }
                    />
                    <span>{item.name}：{item.meaning}</span>
                  </label>
                ))}
              </section>
            ) : (
              <p className='text-muted-foreground'>选区没有断言。发布前需要补后置条件。</p>
            )}
            <label className='block space-y-1'>
              <span>模块名称</span>
              <Input
                aria-label='提炼模块名称'
                value={name}
                onChange={(event) => {
                  const next = event.target.value
                  setName(next)
                  if (!key || key === suggestKey(name)) setKey(suggestKey(next))
                }}
              />
            </label>
            <label className='block space-y-1'>
              <span>模块 key</span>
              <Input aria-label='提炼模块 key' value={key} onChange={(event) => setKey(event.target.value)} />
              {!keyOk && key ? <p className='text-label text-destructive'>须为小写点分标识符，例如 order.query</p> : null}
            </label>
            <label className='block space-y-1'>
              <span>说明（可选）</span>
              <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
          </div>
        ) : null}
        {error ? <p role='alert' className='text-body text-destructive'>{error}</p> : null}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>{busy ? '创建中…' : '创建模块草稿'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
