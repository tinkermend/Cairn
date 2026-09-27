import { Link } from '@tanstack/react-router'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCan } from '@/hooks/use-permissions'

export type RunViewTab = 'runs' | 'suites' | 'reports' | 'materials' | 'retention'

export interface RunsNavTabsProps {
  activeTab: RunViewTab
  targetId?: string
  onTabChange?: (tab: Exclude<RunViewTab, 'suites'>) => void
}

export function RunsNavTabs({ activeTab, targetId, onTabChange }: RunsNavTabsProps) {
  const canReadReports = useCan('report:read')
  const canDelete = useCan('run:delete')

  const targetParam = targetId && targetId !== 'all' ? targetId : undefined

  if (activeTab === 'suites') {
    return (
      <Tabs value='suites'>
        <TabsList>
          <TabsTrigger value='runs' asChild>
            <Link to='/runs' search={targetParam ? { targetId: targetParam } : undefined}>
              独立运行
            </Link>
          </TabsTrigger>
          <TabsTrigger value='suites'>场景集运行</TabsTrigger>
          {canReadReports ? (
            <TabsTrigger value='reports' asChild>
              <Link
                to='/runs'
                search={{
                  view: 'reports',
                  ...(targetParam ? { targetId: targetParam } : {}),
                }}
              >
                交付报告
              </Link>
            </TabsTrigger>
          ) : null}
          <TabsTrigger value='materials' asChild>
            <Link
              to='/runs'
              search={{
                view: 'materials',
                ...(targetParam ? { targetId: targetParam } : {}),
              }}
            >
              材料检索
            </Link>
          </TabsTrigger>
          {canDelete ? (
            <TabsTrigger value='retention' asChild>
              <Link
                to='/runs'
                search={{
                  view: 'retention',
                  ...(targetParam ? { targetId: targetParam } : {}),
                }}
              >
                留存与清理
              </Link>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>
    )
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(val) => {
        if (val !== 'suites') {
          onTabChange?.(val as Exclude<RunViewTab, 'suites'>)
        }
      }}
    >
      <TabsList>
        <TabsTrigger value='runs'>独立运行</TabsTrigger>
        <TabsTrigger value='suites' asChild>
          <Link to='/suite-runs'>场景集运行</Link>
        </TabsTrigger>
        {canReadReports ? (
          <TabsTrigger value='reports'>交付报告</TabsTrigger>
        ) : null}
        <TabsTrigger value='materials'>材料检索</TabsTrigger>
        {canDelete ? (
          <TabsTrigger value='retention'>留存与清理</TabsTrigger>
        ) : null}
      </TabsList>
    </Tabs>
  )
}
