import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, type LinkProps } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Sparkles } from 'lucide-react'
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
import { useAssistantStore } from '@/stores/assistant-store'
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

  // Assistant store bindings
  const busy = useAssistantStore((s) => s.busy)
  const assistantDraft = useAssistantStore((s) => s.question)
  const activeQuote = useAssistantStore((s) => s.activeQuote)
  const capabilities = useAssistantStore((s) => s.capabilities)

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
  const canAssist = can(user, 'ai:assist')

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
  const trimmedQuery = query.trim()
  const showAskAssistant = Boolean(trimmedQuery) && canAssist

  let disabledReason: string | null = null
  if (busy) {
    disabledReason = '助手正在回复中'
  } else if (assistantDraft && assistantDraft.trim().length > 0) {
    disabledReason = '助手输入框有未发送的草稿'
  } else if (activeQuote) {
    disabledReason = '助手有待处理的引用内容'
  } else if (capabilities?.modelEnabled === false) {
    disabledReason = '平台 AI 尚未启用'
  }

  const handleAskAssistant = React.useCallback(async () => {
    if (disabledReason) return
    const questionSnapshot = trimmedQuery
    if (!questionSnapshot) return

    // 固定输入快照，关闭命令菜单
    closeMenu()

    // 打开助手并填入该问题，显式调用 submit() 发送一次
    const assistantStore = useAssistantStore.getState()
    assistantStore.openPanel({ question: questionSnapshot })

    try {
      await assistantStore.submit()
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败，请稍后重试'
      useAssistantStore.setState({ error: message })
    }

    // 确保键盘焦点最终落在助手
    requestAnimationFrame(() => {
      const input = document.getElementById('assistant-question') as HTMLTextAreaElement | null
      if (input) {
        input.focus()
      } else {
        const panel = document.querySelector('[data-assistant-panel="true"]') as HTMLElement | null
        panel?.focus()
      }
    })
  }, [closeMenu, disabledReason, trimmedQuery])

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

  const hasAnyResults = pages.length > 0 || !objectGroupsEmpty || showAskAssistant

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
          {!hasAnyResults && !failed ? (
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
                  <span className='font-mono text-caption text-muted-foreground mr-1.5'>
                    #{item.id.slice(0, 8)}
                  </span>
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
          {showAskAssistant ? (
            <CommandGroup heading='智能助手'>
              <CommandItem
                key='ask-assistant'
                value={`ask-assistant:${trimmedQuery}`}
                disabled={Boolean(disabledReason)}
                onSelect={() => {
                  if (!disabledReason) {
                    void handleAskAssistant()
                  }
                }}
              >
                <div className='flex size-4 items-center justify-center text-primary'>
                  <Sparkles className='size-3.5' />
                </div>
                <span className='truncate'>问识途助手：{trimmedQuery}</span>
                {disabledReason ? (
                  <span className='ms-auto text-caption text-muted-foreground shrink-0'>
                    {disabledReason}
                  </span>
                ) : null}
              </CommandItem>
            </CommandGroup>
          ) : null}
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
