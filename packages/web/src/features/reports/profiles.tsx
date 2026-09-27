import { useEffect, useRef, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { DEFAULT_REPORT_CONFIG, reportConfigTitleSources, reportTitleSources, renderReportTitleV2, type ReportConfig, type ReportTitleSource } from '@cairn/shared'
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
import { ReportTitleInput } from './report-title-input'
import { ApiRequestError } from '@/lib/api-client'

export function ReportProfileSelect({
  targetId,
  value,
  onChange,
  label = '报告默认配置',
  disabled = false,
  source,
}: {
  targetId: string
  value?: string | null
  onChange: (id: string | undefined) => void
  label?: string
  disabled?: boolean
  source?: ReportTitleSource
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
              <SelectItem key={item.id} value={item.id} disabled={Boolean(source && !reportConfigTitleSources(item.config).includes(source) && value !== item.id)}>
                {item.name} · v{item.revision} · {reportConfigTitleSources(item.config).map((kind) => kind === 'RUN' ? '单次运行' : '场景集').join('、') || '需修复'}
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
    [busy, setBusy] = useState(false),
    [conflicts, setConflicts] = useState<Array<{ kind: string; source: string; id?: string; suiteId?: string; name?: string; versionNo?: number | null; memberId?: string; stageId?: string; hidden?: boolean; variables: string[] }>>([])
  const [shownConflicts, setShownConflicts] = useState(20)
  const preserveClone = useRef(false)
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
    if (preserveClone.current) { preserveClone.current = false; return }
    setName(current?.name ?? '')
    setConfig(current?.config ?? DEFAULT_REPORT_CONFIG)
    setConflicts([])
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
        {selected && current ? <Button type='button' variant='outline' className='justify-self-start' onClick={() => { preserveClone.current = true; setSelected(undefined); setName(`${name} 副本`); setConflicts([]) }}>以当前内容创建新配置档</Button> : null}
        <Label htmlFor={`profile-name-${editScope}`}>配置档名称</Label>
        <Input
          id={`profile-name-${editScope}`}
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.target.value)}
        />
        <Label htmlFor={`profile-title-${editScope}`}>默认报告标题</Label>
        <ReportTitleInput id={`profile-title-${editScope}`} label='默认报告标题' value={config.title} onChange={(title) => setConfig({ ...config, title })} />
        <p className='text-label text-muted-foreground'>示例标题：{reportTitleSources(config.title).length ? renderReportTitleV2(config.title, { systemName: '业务系统', scenarioName: '登录检查', suiteName: '每日巡检', executedDate: '2026-09-26', executedRange: '2026-09-26', runNumber: 'a1b2c3d4' }, reportTitleSources(config.title)[0]!) : '请修正标题变量'}。修改只影响之后创建的运行。</p>
        {conflicts.length ? <div role='alert' className='rounded-md border border-destructive/40 bg-destructive/5 p-3 text-label'>
          <p className='font-medium text-destructive'>上次保存已阻止：{conflicts.length} 处既有绑定与提交时的标题不兼容。请先解除绑定，旧发布版本需保留原配置档并克隆新配置档；修改标题后可再次保存验证。</p>
          <ul className='mt-2 max-h-64 list-disc space-y-1 overflow-y-auto pl-5'>
            {conflicts.slice(0, shownConflicts).map((item, index) => <li key={index}>{item.hidden ? `${item.kind === 'scenario' ? '场景' : '场景集'}绑定（无读取权限）` : <>{item.name ?? item.kind}{item.versionNo ? ` · 发布版本 v${item.versionNo}` : item.kind !== 'scenario' ? ' · 草稿' : ''}{item.stageId ? ` · 阶段 ${item.stageId}` : ''}{item.memberId ? ` · 成员 ${item.memberId}` : ''} {item.id ? <a className='text-primary underline' href={`/scenarios/${item.id}`}>查看场景</a> : null}{item.suiteId ? <a className='text-primary underline' href={`/suites/${item.suiteId}`}>查看场景集</a> : null}</>}：{item.variables.join('、')}</li>)}
          </ul>
          {shownConflicts < conflicts.length ? <Button variant='link' type='button' onClick={() => setShownConflicts((count) => count + 20)}>显示更多绑定（{conflicts.length - shownConflicts}）</Button> : null}
        </div> : null}
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
              setConflicts([])
              toast.success('报告配置档已保存')
            } catch (error) {
              if (error instanceof ApiRequestError && error.payload.code === 'REPORT_PROFILE_BINDINGS_INCOMPATIBLE') {
                const detail = error.payload.details as { bindings?: typeof conflicts } | undefined
                setConflicts(detail?.bindings ?? [])
                setShownConflicts(20)
              }
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
    canExport = useCan('report:export'),
    cache = useQueryClient()
  const defaults = useQuery({
    queryKey: ['scenario-report-defaults', scenarioId],
    queryFn: () => fetchScenarioReportDefaults(scenarioId),
    enabled: canRead,
  })
  if (!canRead) return null

  const autoGenerate = Boolean(defaults.data?.outputPolicy?.autoGenerateReport)
  const canToggleAuto = canWrite && canExport

  return (
    <section className='space-y-4 rounded-lg border border-border-card bg-card p-5'>
      <h2 className='text-title'>报告默认配置</h2>
      <p className='text-label text-muted-foreground'>
        新运行会冻结当时的配置，历史运行的报告不随配置档修改而变化。
      </p>

      <div className='space-y-2 rounded-md border border-border-default/60 p-3 bg-muted/20'>
        <label className='flex items-start gap-2 text-body cursor-pointer'>
          <input
            type='checkbox'
            disabled={!canToggleAuto || !defaults.data}
            checked={autoGenerate}
            className='mt-1'
            onChange={async (event) => {
              if (!defaults.data) return
              const checked = event.target.checked
              try {
                const result = await saveScenarioReportDefaults(scenarioId, {
                  profileId: defaults.data.profileId,
                  expectedRevision: defaults.data.revision,
                  outputPolicy: {
                    autoGenerateReport: checked,
                    memberReportPolicy: defaults.data.outputPolicy?.memberReportPolicy ?? 'inherit',
                    aiSummaryPolicy: defaults.data.outputPolicy?.aiSummaryPolicy ?? 'inherit',
                  },
                })
                cache.setQueryData(['scenario-report-defaults', scenarioId], result)
                toast.success(checked ? '已开启运行自动生成报告' : '已关闭自动生成报告')
              } catch (error) {
                toast.error(error instanceof Error ? error.message : '更新自动生成策略失败')
              }
            }}
          />
          <div>
            <div className='font-medium text-foreground'>自动生成报告</div>
            <div className='text-label text-muted-foreground'>
              正式运行完成并结算证据后，自动触发生成程序版报告与 Word / PDF 文件。
            </div>
            {!canExport && canWrite ? (
              <div className='mt-1 text-label text-warning'>
                开启自动生成报告需要导出权限 (report:export)
              </div>
            ) : null}
          </div>
        </label>
      </div>

      <div className='space-y-1.5'>
        <label className='text-label font-medium text-foreground'>内容配置档</label>
        <ReportProfileSelect
          targetId={targetId}
          source='RUN'
          value={defaults.data?.profileId}
          disabled={!canWrite || !defaults.data}
          onChange={async (profileId) => {
            if (!defaults.data) return
            try {
              const result = await saveScenarioReportDefaults(scenarioId, {
                profileId: profileId ?? null,
                expectedRevision: defaults.data.revision,
                outputPolicy: defaults.data.outputPolicy,
              })
              cache.setQueryData(['scenario-report-defaults', scenarioId], result)
              toast.success('默认配置已绑定')
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '保存失败')
            }
          }}
        />
      </div>

      <ReportProfileEditor targetId={targetId} editScope='scenario' />
    </section>
  )
}
