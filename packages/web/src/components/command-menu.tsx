import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, type LinkProps } from '@tanstack/react-router'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { useSearch } from '@/context/search-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useAuthStore } from '@/stores/auth-store'
import { can, filterNavItems } from '@/lib/rbac'
import { fetchRuns } from '@/lib/runs-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTargets } from '@/lib/targets-api'
import { RUN_STATUS_LABELS } from '@/features/runs/labels'
import { personalSettingsGroup, sidebarData } from './layout/data/sidebar-data'
import { ScrollArea } from './ui/scroll-area'

export const COMMAND_MENU_PLACEHOLDER = '搜索场景、运行、目标或页面'

/** 少于两个字的输入不查对象：一个字的模糊匹配既慢又没有信息。 */
const MIN_OBJECT_QUERY = 2
const OBJECT_LIMIT = 5

type PageUrl = LinkProps['to'] | (string & {})
type PageItem = { key: string; label: React.ReactNode; text: string; url: PageUrl }

function pageItems(user: ReturnType<typeof useAuthStore.getState>['auth']['user']): PageItem[] {
  const items: PageItem[] = []
  for (const group of [...sidebarData.navGroups, personalSettingsGroup]) {
    for (const navItem of filterNavItems(group.items, user)) {
      if (navItem.url) {
        items.push({
          key: `page:${navItem.url}`,
          label: navItem.title,
          text: navItem.title,
          url: navItem.url,
        })
        continue
      }
      for (const subItem of navItem.items ?? []) {
        items.push({
          key: `page:${navItem.title}:${subItem.url}`,
          label: (
            <>
              {navItem.title} <ChevronRight /> {subItem.title}
            </>
          ),
          text: `${navItem.title} ${subItem.title}`,
          url: subItem.url,
        })
      }
    }
  }
  return items
}

export function CommandMenu() {
  const navigate = useNavigate()
  const { open, setOpen } = useSearch()
  const user = useAuthStore((s) => s.auth.user)
  const [query, setQuery] = React.useState('')
  const [debounced, setDebounced] = React.useState('')

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const closeMenu = React.useCallback(() => {
    setOpen(false)
    setQuery('')
    setDebounced('')
  }, [setOpen])

  const objectQuery = debounced.length >= MIN_OBJECT_QUERY ? debounced : ''
  const canReadScenarios = can(user, 'workflow:read')
  const canReadRuns = can(user, 'run:read')
  const canReadTargets = can(user, 'target:read')

  const scenarios = useQuery({
    queryKey: ['command-menu', 'scenarios', objectQuery],
    queryFn: () => fetchScenarios({ search: objectQuery, limit: OBJECT_LIMIT }),
    enabled: open && Boolean(objectQuery) && canReadScenarios,
  })
  const runs = useQuery({
    queryKey: ['command-menu', 'runs', objectQuery],
    queryFn: () => fetchRuns({ search: objectQuery, limit: OBJECT_LIMIT }),
    enabled: open && Boolean(objectQuery) && canReadRuns,
  })
  const targets = useQuery({
    queryKey: ['command-menu', 'targets', objectQuery],
    queryFn: () => fetchTargets({ search: objectQuery, limit: OBJECT_LIMIT }),
    enabled: open && Boolean(objectQuery) && canReadTargets,
  })

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      closeMenu()
      command()
    },
    [closeMenu]
  )

  const needle = query.trim().toLowerCase()
  const pages = pageItems(user).filter(
    (item) => !needle || item.text.toLowerCase().includes(needle)
  )
  const scenarioRows = scenarios.data?.items ?? []
  const runRows = runs.data?.items ?? []
  const targetRows = targets.data?.items ?? []
  const objectGroupsEmpty =
    scenarioRows.length === 0 && runRows.length === 0 && targetRows.length === 0
  const failed =
    (canReadScenarios && scenarios.isError) ||
    (canReadRuns && runs.isError) ||
    (canReadTargets && targets.isError)

  return (
    <CommandDialog
      modal
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : closeMenu())}
      shouldFilter={false}
    >
      <CommandInput
        placeholder={COMMAND_MENU_PLACEHOLDER}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          {pages.length === 0 && objectGroupsEmpty && !failed ? (
            <CommandEmpty>没有叫这个名字的页面、场景、运行或目标。</CommandEmpty>
          ) : null}
          {pages.length > 0 ? (
            <CommandGroup heading='页面'>
              {pages.map((item) => (
                <CommandItem
                  key={item.key}
                  value={item.key}
                  onSelect={() => runCommand(() => navigate({ to: item.url }))}
                >
                  <div className='flex size-4 items-center justify-center'>
                    <ArrowRight className='size-2 text-muted-foreground/80' />
                  </div>
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {objectQuery && canReadScenarios && (scenarioRows.length > 0 || scenarios.isError) ? (
            <CommandGroup heading='场景'>
              {scenarios.isError ? (
                <CommandItem value='scenario-error' disabled>
                  暂时无法搜索
                </CommandItem>
              ) : null}
              {scenarioRows.map((item) => (
                <CommandItem
                  key={`scenario:${item.id}`}
                  value={`scenario:${item.id}`}
                  onSelect={() =>
                    runCommand(() =>
                      navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: item.id } })
                    )
                  }
                >
                  <span className='truncate'>{item.name}</span>
                  {item.draftDirty ? (
                    <span className='ms-auto text-label text-muted-foreground'>有未发布草稿</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {objectQuery && canReadRuns && (runRows.length > 0 || runs.isError) ? (
            <CommandGroup heading='运行'>
              {runs.isError ? (
                <CommandItem value='run-error' disabled>
                  暂时无法搜索
                </CommandItem>
              ) : null}
              {runRows.map((item) => (
                <CommandItem
                  key={`run:${item.id}`}
                  value={`run:${item.id}`}
                  onSelect={() =>
                    runCommand(() => navigate({ to: '/runs/$runId', params: { runId: item.id } }))
                  }
                >
                  <span className='truncate'>{item.scenarioName}</span>
                  {/* 同场景同目标的多条运行只靠状态分不开，必须带时间。 */}
                  <span className='ms-auto shrink-0 text-label text-muted-foreground'>
                    {item.targetName} · {RUN_STATUS_LABELS[item.status]} ·{' '}
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {objectQuery && canReadTargets && (targetRows.length > 0 || targets.isError) ? (
            <CommandGroup heading='目标系统'>
              {targets.isError ? (
                <CommandItem value='target-error' disabled>
                  暂时无法搜索
                </CommandItem>
              ) : null}
              {targetRows.map((item) => (
                <CommandItem
                  key={`target:${item.id}`}
                  value={`target:${item.id}`}
                  onSelect={() =>
                    runCommand(() =>
                      navigate({ to: '/targets/$targetId', params: { targetId: item.id } })
                    )
                  }
                >
                  <span className='truncate'>{item.name}</span>
                  <span className='ms-auto text-label text-muted-foreground'>{item.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
