import { Link } from '@tanstack/react-router'
import { ArrowLeft, Play, Save } from 'lucide-react'
import type { SuiteDetailDto } from '@cairn/shared'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { ObjectSchedules } from '@/features/schedules/object-schedules'
import { SUITE_STATUS_LABELS, suiteStatusTone } from '../labels'

export function SuiteHeader({
  suite,
  targetName,
  canExecute,
  busy,
  isDirty,
  onSave,
  onPublish,
  onStartRun,
  onToggleStatus,
}: {
  suite: SuiteDetailDto
  targetName?: string
  canExecute: boolean
  busy: boolean
  isDirty: boolean
  onSave: () => void
  onPublish: () => void
  onStartRun: () => void
  onToggleStatus: () => void
}) {
  return (
    <PageHeader
      parent={
        <Link to='/suites' className='inline-flex items-center gap-1.5 hover:text-link'>
          <ArrowLeft className='size-4' />
          返回场景集
        </Link>
      }
      title={suite.name}
      description={targetName ? `所属目标系统: ${targetName}` : '同一目标系统下的已发布场景编排流水线。'}
      actions={
        <div className='flex flex-wrap items-center gap-2'>
          <ObjectSchedules
            context={{
              type: 'suite_run',
              targetId: suite.targetId,
              targetName,
              objectId: suite.id,
              name: suite.name,
              versionId: suite.published?.id,
            }}
          />
          <StatusBadge tone={suiteStatusTone(suite.status)}>{SUITE_STATUS_LABELS[suite.status]}</StatusBadge>
          {suite.published ? (
            <StatusBadge tone='info'>已发布 v{suite.published.versionNo}</StatusBadge>
          ) : (
            <StatusBadge tone='neutral'>未发布草稿</StatusBadge>
          )}
          {isDirty ? (
            <StatusBadge tone='warning'>草稿有更改</StatusBadge>
          ) : null}
          <Can permission='suite:write'>
            <Button variant='outline' disabled={busy} onClick={onSave}>
              <Save className='mr-1.5 size-4' />
              保存草稿
            </Button>
            <Button variant='outline' disabled={busy} onClick={onPublish}>
              发布
            </Button>
            <Button variant='outline' disabled={busy} onClick={onToggleStatus}>
              {suite.status === 'active' ? '停用' : '启用'}
            </Button>
          </Can>
          {canExecute ? (
            <Button
              disabled={busy || !suite.published}
              onClick={onStartRun}
              title={suite.published ? '启动此场景集' : '发布后才可启动运行'}
            >
              <Play className='mr-1.5 size-4' />
              启动运行
            </Button>
          ) : null}
        </div>
      }
    />
  )
}
