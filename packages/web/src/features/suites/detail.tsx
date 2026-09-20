import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  EMPTY_SUITE_DOCUMENT,
  canExecuteRun,
  hasPermission,
  type SuiteDocument,
  type SuiteMember,
} from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { ArrowDown, ArrowLeft, ArrowUp, Play, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createSuiteRun,
  previewSuiteRun,
  publishSuite,
  saveSuiteDraft,
  updateSuiteEnabled,
  validateSuite,
  fetchSuite,
} from '@/lib/suites-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { fetchTarget } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { SUITE_STATUS_LABELS, suiteStatusTone } from './labels'
import { ReportProfileEditor, ReportProfileSelect } from '@/features/reports/profiles'

function nextMemberId(members: SuiteMember[]) {
  let index = members.length + 1
  const used = new Set(members.map((item) => item.memberId))
  while (used.has(`m${index}`)) index += 1
  return `m${index}`
}

function newIdempotencyKey() {
  return `suite-${crypto.randomUUID()}`
}

export function SuiteDetailPage() {
  const { suiteId } = useParams({ from: '/_authenticated/suites/$suiteId/' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canWrite = useCan('suite:write')
  const permissions = useAuthStore((state) => state.auth.user?.permissions ?? [])
  const canExecute = canExecuteRun(permissions) && hasPermission(permissions, 'suite:read')
  const query = useQuery({ queryKey: ['suite', suiteId], queryFn: () => fetchSuite(suiteId) })
  const target = useQuery({
    queryKey: ['target', query.data?.targetId],
    queryFn: () => fetchTarget(query.data!.targetId),
    enabled: Boolean(query.data?.targetId),
  })
  const scenarios = useQuery({
    queryKey: ['scenarios', { targetId: query.data?.targetId, limit: 100 }],
    queryFn: () => fetchScenarios({ targetId: query.data!.targetId, status: 'active', limit: 100 }),
    enabled: Boolean(query.data?.targetId),
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [document, setDocument] = useState<SuiteDocument>(EMPTY_SUITE_DOCUMENT)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!query.data) return
    setName(query.data.name)
    setDescription(query.data.description ?? '')
    setDocument(query.data.draft.document)
  }, [query.data])

  const scenarioNames = useMemo(
    () => new Map((scenarios.data?.items ?? []).map((item) => [item.id, item.name])),
    [scenarios.data],
  )

  async function save() {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      await queryClient.setQueryData(['suite', suiteId], saved)
      toast.success('草稿已保存')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function publish() {
    if (!query.data) return
    setBusy(true)
    try {
      const saved = await saveSuiteDraft(suiteId, {
        expectedRevision: query.data.draft.revision,
        name: name.trim(),
        description: description.trim() || null,
        document,
      })
      const checked = await validateSuite(suiteId)
      if (!checked.ok) {
        toast.error(checked.issues.find((item) => item.severity === 'error')?.message ?? '校验未通过')
        await queryClient.setQueryData(['suite', suiteId], saved)
        return
      }
      const published = await publishSuite(suiteId, {
        expectedRevision: saved.draft.revision,
        idempotencyKey: newIdempotencyKey(),
      })
      await queryClient.setQueryData(['suite', suiteId], published)
      toast.success(`已发布 v${published.published?.versionNo ?? ''}`)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
    } finally {
      setBusy(false)
    }
  }

  async function startRun() {
    if (!query.data?.published) {
      toast.error('发布后才能启动')
      return
    }
    setBusy(true)
    try {
      const preview = await previewSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      const blocking = preview.issues.filter((item) => item.severity === 'error')
      if (blocking.length) {
        toast.error(blocking[0]!.message)
        return
      }
      const created = await createSuiteRun({
        suiteId,
        idempotencyKey: newIdempotencyKey(),
      })
      toast.success('已启动场景集运行')
      void navigate({ to: '/suite-runs/$suiteRunId', params: { suiteRunId: created.observation.id } })
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '启动失败')
    } finally {
      setBusy(false)
    }
  }

  function addMember(scenarioId: string) {
    const scenario = scenarios.data?.items.find((item) => item.id === scenarioId)
    if (!scenario) return
    const member: SuiteMember = {
      memberId: nextMemberId(document.members),
      ordinal: document.members.length,
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      displayName: scenario.name,
      input: {},
    }
    setDocument({ ...document, members: [...document.members, member] })
  }

  function moveMember(index: number, delta: number) {
    const next = [...document.members]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item!)
    setDocument({ ...document, members: next.map((member, ordinal) => ({ ...member, ordinal })) })
  }

  if (query.isPending) {
    return (
      <Main>
        <PageSkeleton />
      </Main>
    )
  }
  if (query.isError || !query.data) {
    return (
      <Main>
        <QueryErrorState title='无法加载场景集' onRetry={() => void query.refetch()} />
      </Main>
    )
  }

  const suite = query.data

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        parent={
          <Link to='/suites' className='inline-flex items-center gap-1.5 hover:text-link'>
            <ArrowLeft className='size-4' />
            返回场景集
          </Link>
        }
        title={suite.name}
        description={target.data?.name ?? '同一目标系统下的已发布场景编排。'}
        actions={
          <div className='flex flex-wrap items-center gap-2'>
            <StatusBadge tone={suiteStatusTone(suite.status)}>{SUITE_STATUS_LABELS[suite.status]}</StatusBadge>
            {suite.published ? <StatusBadge tone='info'>已发布 v{suite.published.versionNo}</StatusBadge> : null}
            <Can permission='suite:write'>
              <Button variant='outline' disabled={busy} onClick={() => void save()}>
                <Save />
                保存草稿
              </Button>
              <Button variant='outline' disabled={busy} onClick={() => void publish()}>
                发布
              </Button>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => {
                  void updateSuiteEnabled(suiteId, { status: suite.status === 'active' ? 'disabled' : 'active' })
                    .then((next) => {
                      queryClient.setQueryData(['suite', suiteId], next)
                      toast.success(next.status === 'active' ? '已启用' : '已停用')
                    })
                    .catch((error) => toast.error(error instanceof ApiRequestError ? error.message : '更新失败'))
                }}
              >
                {suite.status === 'active' ? '停用' : '启用'}
              </Button>
            </Can>
            {canExecute ? (
              <Button disabled={busy || !suite.published} onClick={() => void startRun()}>
                <Play />
                启动运行
              </Button>
            ) : null}
          </div>
        }
      />
      <section className='grid gap-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
        <div className='grid gap-2'>
          <Label htmlFor='suite-detail-name'>名称</Label>
          <Input id='suite-detail-name' value={name} disabled={!canWrite} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className='grid gap-2'>
          <Label htmlFor='suite-detail-desc'>说明</Label>
          <Textarea
            id='suite-detail-desc'
            value={description}
            disabled={!canWrite}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className='grid gap-2 sm:grid-cols-2'>
          <div className='grid gap-2'>
            <Label>失败策略</Label>
            <Select
              value={document.failurePolicy}
              disabled={!canWrite}
              onValueChange={(value) =>
                setDocument({ ...document, failurePolicy: value as SuiteDocument['failurePolicy'] })
              }
            >
              <SelectTrigger aria-label='失败策略'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='continue'>失败后继续</SelectItem>
                <SelectItem value='stop'>失败后停止后续</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className='self-end text-label text-muted-foreground'>
            成员之间不传递页面或输出。成员间隙允许同账号独立运行插入，可能拉长墙钟时间。
          </p>
        </div>
      </section>
      <section className='space-y-4 rounded-lg border border-border-card bg-card p-5'>
        <h2 className='text-title'>集合报告</h2>
        <ReportProfileSelect targetId={suite.targetId} value={document.reportProfileId} disabled={!canWrite} onChange={(reportProfileId) => setDocument({ ...document, reportProfileId })}/>
        <label className='flex items-start gap-2 text-body'><input type='checkbox' disabled={!canWrite} checked={document.autoGenerateFinalReport} onChange={(event) => setDocument({ ...document, autoGenerateFinalReport: event.target.checked })}/><span>运行完成并结算证据后，自动生成总报告和 Word / PDF 文件。</span></label>
        <p className='text-label text-muted-foreground'>配置随新运行冻结。生成失败单独记录，可从运行详情重试报告。</p>
        <ReportProfileEditor targetId={suite.targetId} editScope='suite'/>
      </section>
      <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
        <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
          <div>
            <h2 className='text-title'>成员</h2>
            <p className='text-label text-muted-foreground'>引用已发布场景的精确版本，最多 50 个，允许同一场景重复出现。</p>
          </div>
          {canWrite ? (
            <Select onValueChange={addMember}>
              <SelectTrigger className='w-56' aria-label='添加成员场景'>
                <SelectValue placeholder='添加已发布场景' />
              </SelectTrigger>
              <SelectContent>
                {(scenarios.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className='inline-flex items-center gap-1'>
                      <Plus className='size-3' />
                      {item.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        {document.members.length === 0 ? (
          <p className='p-6 text-body text-muted-foreground'>还没有成员。添加至少一个已发布场景后才能发布。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>顺序</TableHead>
                <TableHead>成员</TableHead>
                <TableHead>场景</TableHead>
                <TableHead className='w-28' />
              </TableRow>
            </TableHeader>
            <TableBody>
              {document.members.map((member, index) => (
                <TableRow key={member.memberId}>
                  <TableCell>{member.ordinal + 1}</TableCell>
                  <TableCell>
                    <Input
                      value={member.displayName ?? ''}
                      disabled={!canWrite}
                      aria-label={`${member.memberId} 展示名称`}
                      onChange={(event) => {
                        const members = document.members.map((item) =>
                          item.memberId === member.memberId ? { ...item, displayName: event.target.value } : item,
                        )
                        setDocument({ ...document, members })
                      }}
                    />
                    <p className='mt-1 text-label text-muted-foreground'>{member.memberId}</p>
                    <details className='mt-2'><summary className='cursor-pointer text-label'>子报告配置</summary><div className='mt-2 min-w-48'><ReportProfileSelect targetId={suite.targetId} label={`${member.memberId} 子报告默认配置`} value={member.reportProfileId} disabled={!canWrite} onChange={(reportProfileId) => setDocument({ ...document, members: document.members.map((item) => item.memberId === member.memberId ? { ...item, reportProfileId } : item) })}/></div></details>
                  </TableCell>
                  <TableCell>{scenarioNames.get(member.scenarioId) ?? member.scenarioId.slice(0, 8)}</TableCell>
                  <TableCell>
                    {canWrite ? (
                      <div className='flex gap-1'>
                        <Button variant='ghost' size='icon' aria-label='上移' onClick={() => moveMember(index, -1)}>
                          <ArrowUp className='size-4' />
                        </Button>
                        <Button variant='ghost' size='icon' aria-label='下移' onClick={() => moveMember(index, 1)}>
                          <ArrowDown className='size-4' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          aria-label='移除'
                          onClick={() =>
                            setDocument({
                              ...document,
                              members: document.members
                                .filter((item) => item.memberId !== member.memberId)
                                .map((item, ordinal) => ({ ...item, ordinal })),
                            })
                          }
                        >
                          <Trash2 className='size-4' />
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </Main>
  )
}
