import { useMemo, useState } from 'react'
import type { MapIngestSurfaceResponse, MapMenuEntryDto } from '@cairn/shared'
import { Compass, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/status-badge'
import './surface-view.css'

type SurfacePage = MapIngestSurfaceResponse['pages'][number]
type Props = { surface: MapIngestSurfaceResponse; entries: MapMenuEntryDto[] }

const categoryLabels: Record<keyof SurfacePage['categories'], string> = {
  navigation: '导航', input: '输入', action_button: '操作', table_column: '表格列', display: '展示',
}
const categoryKeys = Object.keys(categoryLabels) as Array<keyof SurfacePage['categories']>

function pageMatches(page: SurfacePage, query: string): boolean {
  const term = query.trim().toLocaleLowerCase()
  return !term || [page.title, page.urlPattern, ...page.menuPath].some(value => value.toLocaleLowerCase().includes(term))
}

function pageStatus(page: SurfacePage) {
  if (page.lifecycle === 'stale') return <StatusBadge tone='warning'>STALE</StatusBadge>
  if (page.completeness === 'partial') return <StatusBadge tone='warning'>部分完成</StatusBadge>
  return <StatusBadge tone='success'>已观测</StatusBadge>
}

function accountNote(surface: MapIngestSurfaceResponse) {
  return surface.targetAccountId
    ? <span title={surface.targetAccountId}>按最近采集账号展示 · {surface.targetAccountId.slice(0, 8)}</span>
    : <span>尚无采集账号记录</span>
}

export function IngestSurfaceAtlas({ surface, entries, searchQuery = '', onSearchChange }: Props & {
  searchQuery?: string; onSearchChange: (value: string) => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const visible = surface.pages.filter(page => pageMatches(page, searchQuery))
  const groups = useMemo(() => {
    const configured = [...entries].sort((a, b) => a.orderIndex - b.orderIndex)
    const names = new Map(configured.map(entry => [entry.entryId, entry.name]))
    const ids = [...new Set([...configured.map(entry => entry.entryId), ...surface.pages.map(page => page.entryId)])]
    return ids.map(entryId => ({
      entryId, name: names.get(entryId) ?? surface.pages.find(page => page.entryId === entryId)?.menuPath[0] ?? '历史菜单',
      pages: visible.filter(page => page.entryId === entryId),
      total: surface.pages.filter(page => page.entryId === entryId).length,
    })).filter(group => !searchQuery.trim() || group.pages.length > 0)
  }, [entries, surface.pages, visible, searchQuery])
  const selected = surface.pages.find(page => page.pageKey === selectedKey)

  return <section className='space-y-3' aria-label='采集海图'>
    <div className='flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-card bg-card px-4 py-3'>
      <div><h2 className='flex items-center gap-2 text-section font-semibold'><Compass className='size-4' />菜单海图</h2>
        <p className='text-label text-muted-foreground'>{groups.length} 个菜单岛屿 · {surface.pages.length} 个页面节点 · {accountNote(surface)}</p></div>
      <div className='relative w-full sm:w-72'><Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
        <Input type='search' aria-label='搜索采集页面' value={searchQuery} onChange={event => onSearchChange(event.target.value)}
          placeholder='搜索页面、路径或菜单' className='pl-8' /></div>
    </div>
    {surface.truncated ? <p className='text-small text-warning'>采集历史超出展示上限，当前海图只显示前 1000 个页面。</p> : null}
    {!groups.length ? <div className='rounded-xl border border-dashed border-border-card bg-card p-10 text-center text-muted-foreground'>
      {searchQuery.trim() ? '没有符合搜索的页面。' : '尚无一级菜单。请在采集配置中侦测或手工添加。'}
    </div> : <div className='grid gap-4 lg:grid-cols-2 xl:grid-cols-3'>
      {groups.map(group => <article key={group.entryId} className='ingest-island rounded-2xl border border-border-card p-5'>
        <div className='mb-4 flex items-start justify-between gap-2'><div><p className='text-label text-muted-foreground'>一级菜单</p>
          <h3 className='text-section font-semibold text-text-primary'>{group.name}</h3></div>
          <span className='rounded-full bg-surface-subtle px-2 py-1 text-label text-text-secondary'>{group.total} 页</span></div>
        {group.pages.length ? <div className='space-y-2'>{group.pages.map(page => <button type='button' key={page.pageKey}
          className={`ingest-page-node w-full rounded-lg border p-3 text-left transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
            selectedKey === page.pageKey ? 'border-primary bg-surface-subtle' : 'border-border-divider bg-card'} ${page.changeKinds.length ? 'ingest-page-node--changed' : ''}`}
          onClick={() => setSelectedKey(current => current === page.pageKey ? null : page.pageKey)}>
          <span className='flex items-center justify-between gap-2'><span className='min-w-0 truncate font-medium text-text-primary'>{page.title || page.menuPath[page.menuPath.length - 1]}</span>{pageStatus(page)}</span>
          <span className='mt-1 block truncate text-label text-muted-foreground'>{page.menuPath.join(' / ')}</span>
          <span className='mt-1 block text-label text-text-secondary'>{page.elementCount} 个元素 · {page.viewCount} 个视图</span>
        </button>)}</div> : <p className='rounded-lg border border-dashed border-border-divider p-5 text-center text-small text-muted-foreground'>等待首次采集</p>}
      </article>)}
    </div>}
    {selected ? <aside className='rounded-xl border border-border-card bg-card p-5' aria-label='页面详情'>
      <div className='flex flex-wrap items-center gap-2'><h3 className='text-section font-semibold'>{selected.title}</h3>{pageStatus(selected)}</div>
      <p className='mt-2 break-all text-small text-muted-foreground'>{selected.urlPattern}</p>
      <p className='mt-2 text-small text-text-secondary'>菜单路径：{selected.menuPath.join(' / ')} · 最近观测：{new Date(selected.observedAt).toLocaleString('zh-CN', { hour12: false })}</p>
      <div className='mt-3 flex flex-wrap gap-2'>{categoryKeys.filter(key => selected.categories[key] > 0).map(key =>
        <span key={key} className='rounded-md bg-surface-subtle px-2 py-1 text-label'>{categoryLabels[key]} {selected.categories[key]}</span>)}</div>
      {selected.staleElements ? <p className='mt-2 text-small text-warning'>{selected.staleElements} 个元素待重新确认</p> : null}
    </aside> : null}
  </section>
}

export function IngestSurfaceList({ surface, entries }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | keyof SurfacePage['categories']>('all')
  const [completeness, setCompleteness] = useState<'all' | 'complete' | 'partial'>('all')
  const [lifecycle, setLifecycle] = useState<'all' | 'observed' | 'stale'>('all')
  const names = new Map(entries.map(entry => [entry.entryId, entry.name]))
  const pages = surface.pages.filter(page => pageMatches(page, query)
    && (category === 'all' || page.categories[category] > 0)
    && (completeness === 'all' || page.completeness === completeness)
    && (lifecycle === 'all' || page.lifecycle === lifecycle))
  return <section className='space-y-3' aria-label='采集页面清单'>
    <div className='flex flex-wrap items-end gap-3 rounded-xl border border-border-card bg-card p-4'>
      <div className='min-w-48 flex-1'><label htmlFor='surface-search' className='text-label text-muted-foreground'>页面搜索</label>
        <Input id='surface-search' type='search' value={query} onChange={event => setQuery(event.target.value)} placeholder='标题、菜单路径或 URL' /></div>
      <div><label htmlFor='surface-category' className='text-label text-muted-foreground'>元素类别</label>
        <select id='surface-category' value={category} onChange={event => setCategory(event.target.value as typeof category)} className='block h-9 rounded-md border border-border-card bg-card px-2 text-small'>
          <option value='all'>全部类别</option>{categoryKeys.map(key => <option key={key} value={key}>{categoryLabels[key]}</option>)}</select></div>
      <div><label htmlFor='surface-completeness' className='text-label text-muted-foreground'>完整性</label>
        <select id='surface-completeness' value={completeness} onChange={event => setCompleteness(event.target.value as typeof completeness)} className='block h-9 rounded-md border border-border-card bg-card px-2 text-small'>
          <option value='all'>全部</option><option value='complete'>完整</option><option value='partial'>部分</option></select></div>
      <div><label htmlFor='surface-lifecycle' className='text-label text-muted-foreground'>生命周期</label>
        <select id='surface-lifecycle' value={lifecycle} onChange={event => setLifecycle(event.target.value as typeof lifecycle)} className='block h-9 rounded-md border border-border-card bg-card px-2 text-small'>
          <option value='all'>全部</option><option value='observed'>已观测</option><option value='stale'>STALE</option></select></div>
    </div>
    <p className='text-label text-muted-foreground'>显示 {pages.length}/{surface.pages.length} 个页面 · {accountNote(surface)}</p>
    <div className='overflow-x-auto rounded-xl border border-border-card bg-card'><table className='w-full min-w-[780px] text-left text-small'>
      <thead className='border-b border-border-divider bg-surface-subtle text-text-secondary'><tr>
        <th className='p-3 font-medium'>页面 / 菜单路径</th><th className='p-3 font-medium'>URL</th><th className='p-3 font-medium'>元素</th>
        <th className='p-3 font-medium'>最近观测</th><th className='p-3 font-medium'>状态</th>
      </tr></thead><tbody>{pages.map(page => <tr key={page.pageKey} className={`border-b border-border-divider last:border-0 ${page.changeKinds.length ? 'ingest-page-node--changed' : ''}`}>
        <td className='p-3'><strong className='font-medium text-text-primary'>{page.title}</strong><span className='block text-label text-muted-foreground'>{names.get(page.entryId) ?? page.menuPath[0]} / {page.menuPath.slice(1).join(' / ')}</span></td>
        <td className='max-w-72 truncate p-3 text-label text-muted-foreground' title={page.urlPattern}>{page.urlPattern}</td>
        <td className='p-3'>{page.elementCount}<span className='block text-label text-muted-foreground'>{page.viewCount} 视图{page.staleElements ? ` · ${page.staleElements} 待确认` : ''}</span></td>
        <td className='p-3 whitespace-nowrap text-label'>{new Date(page.observedAt).toLocaleString('zh-CN', { hour12: false })}</td>
        <td className='p-3'>{pageStatus(page)}</td>
      </tr>)}</tbody></table>
      {!pages.length ? <p className='p-8 text-center text-small text-muted-foreground'>没有符合筛选条件的页面。</p> : null}
    </div>
  </section>
}
