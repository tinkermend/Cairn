import { useNavigate } from '@tanstack/react-router'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/stores/auth-store'
import { LoginsAuditPanel } from './logins'
import { OperationsAuditPanel } from './operations'
import { AUDIT_PANE_COPY, visibleAuditPanes, type AuditPane } from './panes'

export function AuditPage({ pane }: { pane: AuditPane }) {
  const navigate = useNavigate()
  const user = useAuthStore((state) => state.auth.user)
  const panes = visibleAuditPanes(user)
  const copy = AUDIT_PANE_COPY[pane]
  const showTabs = panes.length > 1
  const tabs = showTabs ? (
    <Tabs
      value={pane}
      activationMode='manual'
      className='gap-0'
      onValueChange={(next) => {
        void navigate({ to: next === 'logins' ? '/audit/logins' : '/audit/operations' })
      }}
    >
      <TabsList className='border-b-0'>
        {panes.map((item) => (
          <TabsTrigger key={item} value={item}>
            {AUDIT_PANE_COPY[item].title}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  ) : null

  return (
    <Main
      fixed
      className='flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden sm:gap-6'
    >
        <PageHeader className='shrink-0' title='审计日志' description={copy.description} />
        {pane === 'operations' ? (
          <OperationsAuditPanel header={tabs} />
        ) : (
          <LoginsAuditPanel header={tabs} />
        )}
    </Main>
  )
}
