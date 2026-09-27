import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { arrivalTargetForName, type MapMenuEntryDto, type TargetStateRuleDto } from '@cairn/shared'
import { CalendarClock, ChevronDown, ChevronUp, Compass, GripVertical, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  archiveMapMenuEntry, createMapIngestion, createMapMenuEntry, fetchMapIngestions,
  fetchMapJobPolicy, fetchMapMenuEntries, fetchTargetStateRule, reorderMapMenuEntries, updateMapMenuEntry,
  updateMapJobPolicy, updateTargetStateRuleQueryParams,
} from '@/lib/map-api'
import { fetchSchedules } from '@/lib/schedules-api'
import { fetchSessionOverview } from '@/lib/sessions-api'
import { subscribeRunEvents } from '@/lib/runs-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { StatusBadge } from '@/components/status-badge'
import { AccessPolicyCard } from '@/features/targets/access-policy-card'
import { ScheduleEditorDialog } from '@/features/schedules/editor'

const activeStatuses = new Set(['queued', 'running'])

function errorText(error: unknown): string {
  return error instanceof ApiRequestError || error instanceof Error ? error.message : '操作失败'
}

function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录'
}

function StateRuleQueryParamsControl({ targetId, config, canMaintain }: {
  targetId: string; config: TargetStateRuleDto; canMaintain: boolean
}) {
  const client = useQueryClient()
  const [value, setValue] = useState(config.rule.ignoreQueryParams.join(', '))
  const names = value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
  const hasDuplicates = new Set(names).size !== names.length
  const tooManyNames = names.length > 64
  const tooLongName = names.some(name => name.length > 64)
  const unchanged = JSON.stringify(names) === JSON.stringify(config.rule.ignoreQueryParams)
  const save = useMutation({
    mutationFn: () => updateTargetStateRuleQueryParams(targetId, {
      expectedRevision: config.revision,
      ignoreQueryParams: names,
      reason: '调整地图采集页面身份的查询参数规则',
    }),
    onSuccess: () => {
      toast.success('页面身份规则已保存，新作业将使用此配置')
      void client.invalidateQueries({ queryKey: ['map', targetId, 'state-rule'] })
    },
    onError: error => toast.error(errorText(error)),
  })
  return <section className='space-y-3 border-t border-border-divider pt-5'>
    <h3 className='text-section font-semibold'>页面身份</h3>
    <p className='text-small text-muted-foreground'>仅填写确认不会改变页面内容的查询参数名。新采集作业会忽略这些参数来识别重复页面；其他参数仍用于区分页面。</p>
    <div className='space-y-1.5'>
      <Label htmlFor='map-ignore-query-params'>忽略的查询参数</Label>
      <Input id='map-ignore-query-params' value={value} onChange={event => setValue(event.target.value)}
        placeholder='例如 nonce, timestamp' disabled={!canMaintain || save.isPending} aria-invalid={hasDuplicates} />
      <p className='text-label text-muted-foreground'>多个名称用逗号分隔；留空则不忽略任何参数。</p>
      {hasDuplicates ? <p className='text-label text-destructive'>参数名称不能重复。</p> : null}
      {tooManyNames || tooLongName ? <p className='text-label text-destructive'>最多填写 64 个参数，每个名称不超过 64 个字符。</p> : null}
    </div>
    {canMaintain ? <Button variant='outline' size='sm' disabled={save.isPending || unchanged || hasDuplicates || tooManyNames || tooLongName}
      onClick={() => save.mutate()}>{save.isPending ? '保存中…' : '保存页面身份规则'}</Button> : null}
  </section>
}

function MenuForm({ targetId, entry, onDone }: { targetId: string; entry?: MapMenuEntryDto; onDone: () => void }) {
  const client = useQueryClient()
  const [name, setName] = useState(entry?.name ?? '')
  const [url, setUrl] = useState(entry?.url ?? '')
  const [anchor, setAnchor] = useState(entry?.menuAnchor?.label ?? '')
  const [arrivalName, setArrivalName] = useState(entry?.arrivalName ?? '')
  const save = useMutation({
    mutationFn: () => {
      const resolvedName = name.trim()
      const resolvedArrival = arrivalName.trim() || resolvedName
      const values = {
        name: resolvedName,
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(anchor.trim() ? { menuAnchor: { label: anchor.trim(),
          ...(entry?.menuAnchor?.locator ? { locator: entry.menuAnchor.locator } : {}) } } : {}),
        enabled: entry?.enabled ?? true,
        arrivalName: resolvedArrival,
        arrivalTarget: entry?.arrivalName === resolvedArrival
          ? entry.arrivalTarget : arrivalTargetForName(resolvedArrival),
        idempotencyKey: `menu:${crypto.randomUUID()}`,
      }
      return entry
        ? updateMapMenuEntry(targetId, entry.entryId, { ...values, expectedVersion: entry.version })
        : createMapMenuEntry(targetId, values)
    },
    onSuccess: () => {
      toast.success(entry ? '已更新菜单' : '已添加菜单')
      void client.invalidateQueries({ queryKey: ['map', targetId, 'entries'] })
      onDone()
    },
    onError: error => toast.error(errorText(error)),
  })
  return (
    <div className='space-y-3 rounded-lg border border-border-card bg-card p-4'>
      <div className='space-y-1.5'><Label htmlFor='ingest-menu-name'>菜单名称</Label><Input id='ingest-menu-name' value={name} onChange={event => setName(event.target.value)} placeholder='API 令牌' /></div>
      <div className='space-y-1.5'><Label htmlFor='ingest-menu-url'>入口 URL（可选）</Label><Input id='ingest-menu-url' value={url} onChange={event => setUrl(event.target.value)} placeholder='https://example.com/tokens' /></div>
      <div className='space-y-1.5'><Label htmlFor='ingest-menu-anchor'>菜单文字</Label><Input id='ingest-menu-anchor' value={anchor} onChange={event => setAnchor(event.target.value)} placeholder='与一级菜单可见文字一致' /></div>
      <div className='space-y-1.5'><Label htmlFor='ingest-arrival-name'>到达标志</Label><Input id='ingest-arrival-name' value={arrivalName} onChange={event => setArrivalName(event.target.value)} placeholder='页面标题或主标题；留空使用菜单名称' /></div>
      <div className='flex justify-end gap-2'>
        <Button variant='outline' onClick={onDone}>取消</Button>
        <Button disabled={save.isPending || !name.trim() || (!url.trim() && !anchor.trim())} onClick={() => save.mutate()}>{save.isPending ? '保存中…' : '保存菜单'}</Button>
      </div>
    </div>
  )
}

export function MapIngestControls({ targetId, targetName }: { targetId: string; targetName: string }) {
  const client = useQueryClient()
  const canMaintain = useCan('map:maintain')
  const canSchedule = useCan('schedule:write')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<MapMenuEntryDto | 'new' | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [selectedMenus, setSelectedMenus] = useState<string[]>([])
  const [draggingEntryId, setDraggingEntryId] = useState<string | null>(null)
  const [showDetect, setShowDetect] = useState(false)
  const entries = useQuery({ queryKey: ['map', targetId, 'entries'], queryFn: () => fetchMapMenuEntries(targetId) })
  const policy = useQuery({ queryKey: ['map', targetId, 'job-policy'], queryFn: () => fetchMapJobPolicy(targetId) })
  const stateRule = useQuery({ queryKey: ['map', targetId, 'state-rule'], queryFn: () => fetchTargetStateRule(targetId) })
  const jobs = useQuery({ queryKey: ['map', targetId, 'ingestions'], queryFn: () => fetchMapIngestions(targetId, { limit: 20 }), refetchInterval: query => query.state.data?.items.some(job => activeStatuses.has(job.jobStatus)) ? 10000 : false })
  const schedules = useQuery({ queryKey: ['schedules', 'map_ingest', targetId], queryFn: () => fetchSchedules({ targetId, consumerKey: 'map_ingest', limit: 10 }) })
  const sessions = useQuery({ queryKey: ['sessions', 'map', targetId], queryFn: () => fetchSessionOverview({ targetId, limit: 100 }) })
  const active = jobs.data?.items.find(job => activeStatuses.has(job.jobStatus))
  const latest = jobs.data?.items.find(job => !activeStatuses.has(job.jobStatus))
  const activeRunId = active?.slices[active.slices.length - 1]?.runId
  useEffect(() => {
    if (!activeRunId) return
    const controller = new AbortController()
    let pending: ReturnType<typeof setTimeout> | undefined
    const refreshFromRun = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = undefined
        void client.invalidateQueries({ queryKey: ['map', targetId] })
      }, 400)
    }
    void subscribeRunEvents(activeRunId, { cursor: 0, signal: controller.signal,
      handlers: { onEvent: refreshFromRun, onControl: control => {
        if (control.kind === 'complete' || control.kind === 'reset') refreshFromRun()
      } },
    }).catch(() => { /* Query polling remains the reconnect fallback. */ })
    return () => { controller.abort(); if (pending) clearTimeout(pending) }
  }, [activeRunId, client, targetId])
  const detectedJob = jobs.data?.items.find(job => job.scope === 'detect_top_menus' && job.ingestSummary?.detectedMenus?.length)
  const detected = detectedJob?.ingestSummary?.detectedMenus ?? []
  const schedule = schedules.data?.items.find(item => item.consumerKey === 'map_ingest' && item.targetId === targetId)
  const sessionReady = sessions.data?.summary.available ?? 0
  const enabledCount = entries.data?.filter(entry => entry.enabled).length ?? 0
  const canStart = canMaintain && Boolean(policy.data?.policy.manualJobsEnabled)
    && sessionReady > 0 && !active && !policy.isPending && !sessions.isPending

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['map', targetId] })
    void client.invalidateQueries({ queryKey: ['schedules', 'map_ingest', targetId] })
  }
  const start = useMutation({
    mutationFn: ({ scope, entryIds }: { scope: 'full' | 'detect_top_menus' | 'entries'; entryIds?: string[] }) => createMapIngestion(targetId, {
      manualId: `manual:${crypto.randomUUID()}`,
      expectedPolicyRevision: policy.data?.revision ?? 0,
      scope,
      ...(entryIds ? { entryIds } : {}),
    }),
    onSuccess: () => { toast.success('采集作业已排队'); refresh() },
    onError: error => toast.error(errorText(error)),
  })
  const reorder = useMutation({
    mutationFn: (list: MapMenuEntryDto[]) => reorderMapMenuEntries(targetId, {
      entries: list.map(entry => ({ entryId: entry.entryId, expectedVersion: entry.version, enabled: entry.enabled })),
      idempotencyKey: `menu-order:${crypto.randomUUID()}`,
    }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['map', targetId, 'entries'] }) },
    onError: error => toast.error(errorText(error)),
  })
  const archive = useMutation({
    mutationFn: (entry: MapMenuEntryDto) => archiveMapMenuEntry(targetId, entry.entryId, {
      expectedVersion: entry.version, idempotencyKey: `menu-archive:${crypto.randomUUID()}`,
    }),
    onSuccess: () => { toast.success('菜单已归档'); refresh() },
    onError: error => toast.error(errorText(error)),
  })
  const togglePolicy = useMutation({
    mutationFn: () => updateMapJobPolicy(targetId, {
      expectedRevision: policy.data?.revision ?? 0,
      manualJobsEnabled: !policy.data?.policy.manualJobsEnabled,
      idempotencyKey: `ingest-policy:${crypto.randomUUID()}`,
      reason: '调整目标知识采集开关',
    }),
    onSuccess: refresh,
    onError: error => toast.error(errorText(error)),
  })
  const importMenus = useMutation({
    mutationFn: async () => {
      const candidates = detected.map((item, index) => ({ item, index }))
        .filter(({ index }) => selectedMenus.includes(String(index)))
      const existingUrls = new Set((entries.data ?? []).map(entry => entry.url).filter((url): url is string => Boolean(url)))
      const existingAnchorOnly = new Set((entries.data ?? []).filter(entry => !entry.url)
        .map(entry => entry.menuAnchor?.label.trim().toLocaleLowerCase()).filter((label): label is string => Boolean(label)))
      let imported = 0
      for (const { item: candidate, index } of candidates) {
        const anchorKey = candidate.label.trim().toLocaleLowerCase()
        if (candidate.url ? existingUrls.has(candidate.url) : existingAnchorOnly.has(anchorKey)) continue
        await createMapMenuEntry(targetId, {
          name: candidate.label, ...(candidate.url ? { url: candidate.url } : {}),
          menuAnchor: candidate.menuAnchor, enabled: true,
          arrivalName: candidate.label, arrivalTarget: arrivalTargetForName(candidate.label),
          idempotencyKey: `detect:${detectedJob?.jobId ?? 'unknown'}:${index}`,
        })
        imported++
        if (candidate.url) existingUrls.add(candidate.url)
        else existingAnchorOnly.add(anchorKey)
      }
      return imported
    },
    onSuccess: count => { toast.success(count ? `已导入 ${count} 个一级菜单` : '所选菜单已在清单中'); setSelectedMenus([]); refresh() },
    onError: error => { refresh(); toast.error(errorText(error)) },
  })
  const entriesSorted = useMemo(() => [...(entries.data ?? [])].sort((a, b) => a.orderIndex - b.orderIndex), [entries.data])
  const move = (index: number, direction: -1 | 1) => {
    const next = [...entriesSorted]
    const neighbor = index + direction
    if (neighbor < 0 || neighbor >= next.length) return
    ;[next[index], next[neighbor]] = [next[neighbor]!, next[index]!]
    reorder.mutate(next)
  }
  const moveTo = (sourceId: string, targetId: string) => {
    if (sourceId === targetId || reorder.isPending) return
    const next = [...entriesSorted]
    const sourceIndex = next.findIndex(item => item.entryId === sourceId)
    const targetIndex = next.findIndex(item => item.entryId === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved!)
    reorder.mutate(next)
  }

  return (
    <>
      <div className='flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-card bg-card px-4 py-3'>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-small'>
          <span className='font-medium text-text-primary'>{targetName}</span>
          <span className='text-muted-foreground'>会话可用 {sessionReady}</span>
          <span className='text-muted-foreground'>上次采集 {formatTime(latest?.updatedAt ?? latest?.createdAt)}{latest?.ingestSummary ? ` · ${latest.ingestSummary.outcome === 'complete' ? '完成' : '部分完成'}` : ''}</span>
          <span className='text-muted-foreground'>定时 {schedule ? (schedule.enabled ? '已启用' : '已暂停') : '未设置'}</span>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button variant='outline' onClick={() => setOpen(true)}><Settings2 className='mr-1.5 size-4' />采集配置</Button>
          {canMaintain ? <Button variant='outline' disabled={!canStart || start.isPending} onClick={() => { setOpen(true); setShowDetect(true); setSelectedMenus([]); start.mutate({ scope: 'detect_top_menus' }) }}>侦测菜单</Button> : null}
          {canMaintain ? <Button disabled={!canStart || !enabledCount || start.isPending} onClick={() => start.mutate({ scope: 'full' })}>
            <Compass className='mr-1.5 size-4' />{active ? `采集中 ${active.ingestProgress?.completedEntries ?? 0}/${active.ingestProgress?.totalEntries ?? 0}` : '立即采集'}
          </Button> : null}
        </div>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className='w-full overflow-y-auto sm:max-w-2xl'>
          <SheetHeader><SheetTitle>采集配置</SheetTitle><SheetDescription>按一级菜单定义只读采集范围，查看作业与定时设置。</SheetDescription></SheetHeader>
          <div className='mt-5 space-y-6 px-6 pb-8'>
            {sessionReady === 0 && canMaintain ? <Alert><AlertDescription>当前没有可用的已登录会话。请先<Link className='ml-1 underline' to='/sessions' search={{ view: 'systems', targetId }}>准备目标会话</Link>，再运行侦测或采集。</AlertDescription></Alert> : null}
            {active ? <Alert><AlertDescription>正在采集第 {active.ingestProgress?.completedEntries ?? 0}/{active.ingestProgress?.totalEntries ?? 0} 个菜单：{active.ingestProgress?.currentEntryName ?? '准备中'}。已采页面 {active.ingestProgress?.pagesCollected ?? 0}。{activeRunId ? <a className='text-primary underline' href={`/runs/${activeRunId}`}>查看分片 Run</a> : null}</AlertDescription></Alert> : null}
            {latest?.ingestSummary?.outcome === 'partial' ? <Alert><AlertDescription>上次采集部分完成。{Object.entries(latest.ingestSummary.resultCounts).filter(([code]) => code !== 'collected').map(([code, count]) => `${code} ${count}`).join(' · ')}{latest.ingestSummary.blockedPostPaths.length ? `；被拦截 POST：${latest.ingestSummary.blockedPostPaths.map(item => item.path).join('、')}` : ''}</AlertDescription></Alert> : null}
            {latest?.ingestSummary?.blockedImpactCounts?.verified_non_content_rule ? <p className='text-label text-muted-foreground'>上次采集有 {latest.ingestSummary.blockedImpactCounts.verified_non_content_rule} 次已核实的非页面数据请求被拦截，未计入页面缺失；仍可能影响页面的拦截 {latest.ingestSummary.blockedImpactCounts.unclassified} 次。</p> : null}
            {latest?.ingestSummary?.inferredReadPostCount ? <p className='break-all text-label text-muted-foreground'>上次采集有 {latest.ingestSummary.inferredReadPostCount} 次 POST 查询按平衡模式推断放行；这是风险判断，并非线上只读证明。{latest.ingestSummary.inferredReadPostPaths?.slice(0, 3).map(item => `${item.path} (${item.count})`).join('、')}</p> : null}
            {latest?.jobStatus === 'failed' ? <Alert><AlertDescription>上次采集失败：{latest.stopReason ?? '请检查会话与目标授权'}</AlertDescription></Alert> : null}
            <section className='space-y-3'>
              <div className='flex items-center justify-between gap-2'><h3 className='text-section font-semibold'>一级菜单 <span className='text-muted-foreground'>({enabledCount}/{entriesSorted.length})</span></h3>{canMaintain ? <Button variant='outline' size='sm' onClick={() => setEditing('new')}>手动添加</Button> : null}</div>
              {!entriesSorted.length ? <p className='rounded-lg border border-dashed border-border-card p-5 text-small text-muted-foreground'>尚无一级菜单。先侦测并导入，或手动添加入口。</p> : (
                <ul className='space-y-2'>{entriesSorted.map((entry, index) => <li key={entry.entryId}
                  draggable={canMaintain && !reorder.isPending}
                  onDragStart={event => { setDraggingEntryId(entry.entryId); event.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={event => { if (draggingEntryId) event.preventDefault() }}
                  onDrop={event => { event.preventDefault(); if (draggingEntryId) moveTo(draggingEntryId, entry.entryId); setDraggingEntryId(null) }}
                  onDragEnd={() => setDraggingEntryId(null)}
                  className={`rounded-lg border p-3 ${draggingEntryId === entry.entryId ? 'border-primary bg-surface-subtle' : 'border-border-card'}`}>
                  <div className='flex items-start justify-between gap-2'><div className='min-w-0'><div className='flex items-center gap-2'><span className='font-medium'>{entry.name}</span><StatusBadge tone={entry.enabled ? 'success' : 'neutral'}>{entry.enabled ? '启用' : '停用'}</StatusBadge></div><p className='mt-1 break-all text-label text-muted-foreground'>{entry.url ?? entry.menuAnchor?.label}</p><p className='mt-1 text-label text-muted-foreground'>上次采集：{entry.lastIngest ? `${entry.lastIngest.outcome} · ${entry.lastIngest.pageCount} 页` : '尚无'}</p></div>
                    {canMaintain ? <div className='flex shrink-0 items-center gap-1'><GripVertical className='size-4 text-muted-foreground' aria-hidden='true' /><Button variant='ghost' size='icon' aria-label={`上移 ${entry.name}`} disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)}><ChevronUp className='size-4' /></Button><Button variant='ghost' size='icon' aria-label={`下移 ${entry.name}`} disabled={index === entriesSorted.length - 1 || reorder.isPending} onClick={() => move(index, 1)}><ChevronDown className='size-4' /></Button></div> : null}</div>
                  {canMaintain ? <div className='mt-2 flex flex-wrap gap-2'><Button variant='outline' size='sm' disabled={reorder.isPending} onClick={() => reorder.mutate(entriesSorted.map(item => item.entryId === entry.entryId ? { ...item, enabled: !item.enabled } : item))}>{entry.enabled ? '停用' : '启用'}</Button><Button variant='outline' size='sm' onClick={() => setEditing(entry)}>编辑</Button><Button variant='outline' size='sm' disabled={!canStart || !entry.enabled || start.isPending} onClick={() => start.mutate({ scope: 'entries', entryIds: [entry.entryId] })}>仅采集此菜单</Button><Button variant='outline' size='sm' disabled={archive.isPending} onClick={() => archive.mutate(entry)}>归档</Button></div> : null}
                </li>)}</ul>
              )}
              {editing ? <MenuForm key={editing === 'new' ? 'new' : editing.entryId} targetId={targetId} entry={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} /> : null}
            </section>
            {showDetect && detected.length ? <section className='space-y-3'><h3 className='text-section font-semibold'>侦测到的一级菜单</h3><ul className='space-y-1'>{detected.map((item, index) => <li key={`${item.url ?? item.label}:${index}`}><label className='flex cursor-pointer items-center gap-2 rounded-md border border-border-divider p-2 text-small'><input type='checkbox' checked={selectedMenus.includes(String(index))} onChange={event => setSelectedMenus(current => event.target.checked ? [...current, String(index)] : current.filter(value => value !== String(index)))} />{item.label}<span className='truncate text-muted-foreground'>{item.url}</span></label></li>)}</ul>{canMaintain ? <Button disabled={!selectedMenus.length || importMenus.isPending} onClick={() => importMenus.mutate()}>导入所选菜单</Button> : null}</section> : null}
            {stateRule.data ? <StateRuleQueryParamsControl key={`${targetId}:${stateRule.data.revision}`} targetId={targetId} config={stateRule.data} canMaintain={canMaintain} /> : null}
            {stateRule.isError ? <Alert><AlertDescription>页面身份规则加载失败：{errorText(stateRule.error)} <Button variant='link' size='sm' onClick={() => void stateRule.refetch()}>重试</Button></AlertDescription></Alert> : null}
            <section className='space-y-3 border-t border-border-divider pt-5'><div className='flex items-center justify-between'><h3 className='flex items-center gap-2 text-section font-semibold'><CalendarClock className='size-4' />定时采集</h3>{canSchedule ? <Button variant='outline' size='sm' onClick={() => setScheduleOpen(true)}>{schedule ? '编辑调度' : '创建调度'}</Button> : null}</div><p className='text-small text-muted-foreground'>{schedule ? `${schedule.name} · ${schedule.enabled ? '已启用' : '已暂停'}` : '该目标尚未配置定时采集。'}</p></section>
            <section className='space-y-3 border-t border-border-divider pt-5'><h3 className='text-section font-semibold'>采集开关</h3><p className='text-small text-muted-foreground'>{policy.data?.policy.manualJobsEnabled ? '已启用；手动与定时作业可创建。' : '已关闭；无法创建采集作业。'}</p>{canMaintain ? <Button variant='outline' size='sm' disabled={togglePolicy.isPending || policy.isPending} onClick={() => togglePolicy.mutate()}>{policy.data?.policy.manualJobsEnabled ? '关闭采集' : '启用采集'}</Button> : null}</section>
            <section className='border-t border-border-divider pt-5'><AccessPolicyCard targetId={targetId} /></section>
            {latest?.ingestSummary ? <section className='space-y-2 border-t border-border-divider pt-5'><h3 className='text-section font-semibold'>上次作业</h3><p className='text-small text-muted-foreground'>采集 {latest.ingestSummary.pages} 页、{latest.ingestSummary.elements} 个元素；{latest.ingestSummary.slices} 个分片。变化 {latest.ingestSummary.changes.length} 项。</p></section> : null}
          </div>
        </SheetContent>
      </Sheet>
      {scheduleOpen ? <ScheduleEditorDialog key={schedule?.scheduleId ?? 'new-map-ingest'} open={scheduleOpen} onOpenChange={value => { setScheduleOpen(value); if (!value) refresh() }} existing={schedule} context={{ type: 'map_ingest', targetId, targetName, name: `${targetName} · 地图采集` }} /> : null}
    </>
  )
}
