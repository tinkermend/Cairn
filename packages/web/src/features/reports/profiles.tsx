import { useEffect, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { DEFAULT_REPORT_CONFIG, type ReportConfig } from '@cairn/shared'
import { toast } from 'sonner'
import {
  fetchReportProfiles,
  fetchReportProfile,
  fetchReportProfileVersions,
  fetchScenarioReportDefaults,
  saveReportProfile,
  saveScenarioReportDefaults,
} from '@/lib/reports-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ReportConfigFields } from './config-fields'

export function ReportProfileSelect({
  targetId,
  value,
  onChange,
  label = '报告默认配置',
  disabled = false,
}: {
  targetId: string
  value?: string | null
  onChange: (id: string | undefined) => void
  label?: string
  disabled?: boolean
}) {
  const canRead = useCan('report:read')
  const profiles = useInfiniteQuery({
    queryKey: ['report-profiles', targetId],
    queryFn: ({ pageParam }) => fetchReportProfiles(targetId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: canRead,
  })
  return (
    <div className='grid gap-2'>
      <Label>{label}</Label>
      <Select
        value={value || 'default'}
        disabled={disabled || !canRead}
        onValueChange={(id) => onChange(id === 'default' ? undefined : id)}
      >
        <SelectTrigger
          aria-label={label}
          className='w-full min-w-0 [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate'
        >
          <SelectValue placeholder='使用场景或系统默认' />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='default'>使用场景或系统默认</SelectItem>
          {profiles.data?.pages
            .flatMap((page) => page.items)
            .map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} · v{item.revision}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {profiles.hasNextPage && (
        <Button variant='link' onClick={() => void profiles.fetchNextPage()}>
          加载更多配置档
        </Button>
      )}
    </div>
  )
}

export function ReportProfileEditor({
  targetId,
  editScope,
}: {
  targetId: string
  editScope: 'scenario' | 'suite'
}) {
  const canWrite = useCan(
      editScope === 'suite' ? 'suite:write' : 'workflow:write'
    ),
    cache = useQueryClient(),
    canRead = useCan('report:read')
  const [selected, setSelected] = useState<string>(),
    [name, setName] = useState(''),
    [config, setConfig] = useState<ReportConfig>(DEFAULT_REPORT_CONFIG),
    [busy, setBusy] = useState(false)
  const profile = useQuery({
    queryKey: ['report-profile', selected],
    queryFn: () => fetchReportProfile(selected!),
    enabled: Boolean(selected && canWrite && canRead),
  })
  const current = profile.data
  const versions = useInfiniteQuery({
    queryKey: ['report-profile-versions', selected],
    queryFn: ({ pageParam }) =>
      fetchReportProfileVersions(selected!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(selected && canWrite && canRead),
  })
  useEffect(() => {
    setName(current?.name ?? '')
    setConfig(current?.config ?? DEFAULT_REPORT_CONFIG)
  }, [current])
  if (!canWrite || !canRead) return null
  return (
    <details className='rounded-md border p-3'>
      <summary className='cursor-pointer text-body'>管理报告配置档</summary>
      <div className='mt-4 grid gap-4'>
        <ReportProfileSelect
          targetId={targetId}
          value={selected}
          onChange={setSelected}
          label='选择已有配置档（留空新建）'
        />
        <Label htmlFor={`profile-name-${editScope}`}>配置档名称</Label>
        <Input
          id={`profile-name-${editScope}`}
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
        />
        <Label htmlFor={`profile-title-${editScope}`}>默认报告标题</Label>
        <Input
          id={`profile-title-${editScope}`}
          value={config.title}
          maxLength={200}
          onChange={(event) =>
            setConfig({ ...config, title: event.target.value })
          }
        />
        <p className='text-label text-muted-foreground'>
          支持 {'{systemName}'}、{'{scenarioName}'}、{'{suiteName}'}、
          {'{executedDate}'}、{'{executedRange}'}、{'{runNumber}'}
          。修改只影响之后创建的运行。
        </p>
        <ReportConfigFields
          config={config}
          onChange={setConfig}
          targetId={targetId}
          editScope={editScope}
          profile
        />
        <Button
          disabled={
            busy ||
            !name.trim() ||
            Boolean(selected && !current) ||
            Boolean(current && current.editScope !== editScope)
          }
          className='justify-self-start'
          onClick={async () => {
            setBusy(true)
            try {
              const saved = await saveReportProfile(selected ?? null, {
                targetId,
                name: name.trim(),
                config,
                editScope,
                expectedRevision: current?.revision,
              })
              await cache.invalidateQueries({
                queryKey: ['report-profiles', targetId],
              })
              cache.setQueryData(['report-profile', saved.id], saved)
              await cache.invalidateQueries({
                queryKey: ['report-profile-versions', saved.id],
              })
              setSelected(saved.id)
              toast.success('报告配置档已保存')
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '保存失败')
            } finally {
              setBusy(false)
            }
          }}
        >
          {selected ? '保存新版本' : '创建配置档'}
        </Button>
        {current?.editScope !== editScope && current && (
          <p className='text-label text-muted-foreground'>
            此配置档由{current.editScope === 'suite' ? '场景集' : '场景'}
            管理入口维护，可绑定使用。
          </p>
        )}
        {versions.data && (
          <details>
            <summary className='cursor-pointer text-label'>历史版本</summary>
            <ul className='mt-2 space-y-2'>
              {versions.data.pages
                .flatMap((page) => page.items)
                .map((version) => (
                  <li key={version.revision} className='text-label'>
                    v{version.revision} · {version.config.title}
                    <Button
                      variant='link'
                      size='sm'
                      onClick={() => setConfig(version.config)}
                    >
                      用此版本配置编辑
                    </Button>
                  </li>
                ))}
            </ul>
            {versions.hasNextPage && (
              <Button
                variant='link'
                onClick={() => void versions.fetchNextPage()}
              >
                更多历史版本
              </Button>
            )}
          </details>
        )}
      </div>
    </details>
  )
}

export function ScenarioReportSettings({
  scenarioId,
  targetId,
}: {
  scenarioId: string
  targetId: string
}) {
  const canWrite = useCan('workflow:write'),
    canRead = useCan('report:read'),
    cache = useQueryClient()
  const defaults = useQuery({
    queryKey: ['scenario-report-defaults', scenarioId],
    queryFn: () => fetchScenarioReportDefaults(scenarioId),
    enabled: canRead,
  })
  if (!canRead) return null
  return (
    <section className='space-y-4 rounded-lg border border-border-card bg-card p-5'>
      <h2 className='text-title'>报告默认配置</h2>
      <p className='text-label text-muted-foreground'>
        新运行会冻结当时的配置，历史运行的报告不随配置档修改而变化。
      </p>
      <ReportProfileSelect
        targetId={targetId}
        value={defaults.data?.profileId}
        disabled={!canWrite || !defaults.data}
        onChange={async (profileId) => {
          if (!defaults.data) return
          try {
            const result = await saveScenarioReportDefaults(scenarioId, {
              profileId: profileId ?? null,
              expectedRevision: defaults.data.revision,
            })
            cache.setQueryData(['scenario-report-defaults', scenarioId], result)
            toast.success('默认配置已绑定')
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '保存失败')
          }
        }}
      />
      <ReportProfileEditor targetId={targetId} editScope='scenario' />
    </section>
  )
}
