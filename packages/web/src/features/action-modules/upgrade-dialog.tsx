import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ModuleInputBinding, UpgradeDiff } from '@cairn/shared'
import { upgradeWarningKey } from '@cairn/shared'
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
import { fetchActionModuleVersion } from '@/lib/action-modules-api'
import { fetchScenario, previewScenarioModuleUpgrade, upgradeScenarioModule } from '@/lib/scenarios-api'

const SEVERITY_LABEL = { blocking: '阻断', warning: '警告', info: '信息' } as const

export function ModuleUpgradeDialog({
  open,
  onOpenChange,
  scenarioId,
  invocationId,
  toVersionId,
  onUpgraded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  invocationId: string
  toVersionId: string
  onUpgraded: (scenarioId: string) => void
}) {
  const scenario = useQuery({
    queryKey: ['scenarios', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
    enabled: open && Boolean(scenarioId),
  })
  const preview = useQuery({
    queryKey: ['module-upgrade-preview', scenarioId, invocationId, toVersionId],
    queryFn: () => previewScenarioModuleUpgrade(scenarioId, { invocationId, toVersionId }),
    enabled: open && Boolean(scenarioId && invocationId && toVersionId),
  })
  const moduleId = useMemo(() => {
    const node = preview.data?.document.nodes.find(
      (item) => item.kind === 'module' && item.invocationId === invocationId,
    )
    return node && node.kind === 'module' ? node.moduleId : ''
  }, [invocationId, preview.data])
  const version = useQuery({
    queryKey: ['action-module-version-upgrade', moduleId, toVersionId],
    queryFn: () => fetchActionModuleVersion(moduleId, toVersionId),
    enabled: open && Boolean(moduleId && toVersionId),
  })
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (open) {
      setConfirmed([])
      setBindings({})
      setError('')
    }
  }, [open, invocationId, toVersionId])
  const groups = useMemo(() => {
    const diffs = preview.data?.diffs ?? []
    return {
      blocking: diffs.filter((item) => item.severity === 'blocking'),
      warning: diffs.filter((item) => item.severity === 'warning'),
      info: diffs.filter((item) => item.severity === 'info'),
    }
  }, [preview.data])
  const requiredInputs = groups.blocking.filter(
    (item) => item.code === 'MODULE_UPGRADE_INPUT_REQUIRED' || item.code === 'MODULE_UPGRADE_INPUT_TYPE',
  )
  const baseRevision = scenario.data?.draft?.revision
  const canSubmit =
    Boolean(preview.data) &&
    baseRevision !== undefined &&
    groups.blocking.every((item) => item.inputKey && bindings[item.inputKey]) &&
    groups.warning.every((item) => confirmed.includes(upgradeWarningKey(item))) &&
    !busy
  const submit = async () => {
    if (!preview.data || baseRevision === undefined || !canSubmit) return
    setBusy(true)
    setError('')
    try {
      const bindingsPatch: Record<string, ModuleInputBinding> = {}
      for (const [key, value] of Object.entries(bindings)) {
        const input = version.data?.content.contract.inputs.find((item) => item.key === key)
        bindingsPatch[key] = {
          kind: 'literal',
          value: input?.valueType === 'number' ? Number(value) : input?.valueType === 'boolean' ? value === 'true' : value,
        }
      }
      await upgradeScenarioModule(scenarioId, {
        invocationId,
        toVersionId,
        baseRevision,
        bindingsPatch,
        confirmedWarnings: confirmed,
        idempotencyKey: crypto.randomUUID(),
      })
      onOpenChange(false)
      onUpgraded(scenarioId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '升级失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>升级模块调用</DialogTitle>
          <DialogDescription>只写入场景草稿，不会发布或开跑。</DialogDescription>
        </DialogHeader>
        {preview.isLoading || scenario.isLoading ? <p className='text-body text-muted-foreground'>正在计算差异…</p> : null}
        {preview.isError ? <p role='alert' className='text-body text-destructive'>{preview.error.message}</p> : null}
        {scenario.isError ? <p role='alert' className='text-body text-destructive'>{scenario.error.message}</p> : null}
        {preview.data ? (
          <div className='space-y-4 text-body'>
            {(['blocking', 'warning', 'info'] as const).map((severity) => (
              <section key={severity} className='space-y-2'>
                <h3 className='text-section font-semibold'>{SEVERITY_LABEL[severity]}</h3>
                {groups[severity].length === 0 ? (
                  <p className='text-muted-foreground'>无</p>
                ) : (
                  groups[severity].map((diff) => (
                    <DiffRow
                      key={upgradeWarningKey(diff)}
                      diff={diff}
                      confirmable={severity === 'warning'}
                      confirmed={confirmed.includes(upgradeWarningKey(diff))}
                      onConfirm={(checked) =>
                        setConfirmed((current) =>
                          checked ? [...current, upgradeWarningKey(diff)] : current.filter((item) => item !== upgradeWarningKey(diff)),
                        )
                      }
                    />
                  ))
                )}
              </section>
            ))}
            {requiredInputs.length > 0 ? (
              <section className='space-y-2'>
                <h3 className='text-section font-semibold'>补绑定</h3>
                {requiredInputs.map((diff) =>
                  diff.inputKey ? (
                    <label key={diff.inputKey} className='block space-y-1'>
                      <span>{diff.inputKey}</span>
                      <Input
                        aria-label={`绑定 ${diff.inputKey}`}
                        value={bindings[diff.inputKey] ?? ''}
                        onChange={(event) => setBindings((current) => ({ ...current, [diff.inputKey!]: event.target.value }))}
                      />
                    </label>
                  ) : null,
                )}
              </section>
            ) : null}
          </div>
        ) : null}
        {error ? <p role='alert' className='text-body text-destructive'>{error}</p> : null}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>{busy ? '写入中…' : '写入草稿'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiffRow({
  diff,
  confirmable,
  confirmed,
  onConfirm,
}: {
  diff: UpgradeDiff
  confirmable: boolean
  confirmed: boolean
  onConfirm: (checked: boolean) => void
}) {
  return (
    <div className='rounded-md border p-3'>
      {confirmable ? (
        <label className='flex items-start gap-3'>
          <input type='checkbox' aria-label={`确认警告：${diff.message}`} checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />
          <span className='break-words'>{diff.message}</span>
        </label>
      ) : (
        <p className={diff.severity === 'blocking' ? 'text-destructive' : undefined}>{diff.message}</p>
      )}
    </div>
  )
}
