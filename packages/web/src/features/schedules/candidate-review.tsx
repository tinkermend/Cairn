import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  authoringSteps,
  canonicalJson,
  diffKnowledgeDocuments,
  isAuthoringDocumentV2,
  scenarioDocumentDigest,
  scenarioDocumentSchema,
  terminologyEntrySchema,
  walkAuthoringNodes,
  type AnalysisCandidateDto,
  type KnowledgeDiff,
  type ReviewAnalysisCandidateBody,
  type ScenarioDocument,
  type TerminologyEntry,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'
import {
  acceptKnowledgeProposal,
  fetchKnowledgeProposal,
  rejectKnowledgeProposal,
  reviewAnalysisCandidate,
} from '@/lib/knowledge-api'
import { fetchMapTerms } from '@/lib/map-api'
import { fetchScenario, fetchScenarios } from '@/lib/scenarios-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { priorBindings, priorOutputShapes } from '@/features/authoring/document'
import { InputsEditor, StepEditor } from '@/features/authoring/step-editor'
import { TermEditor } from '@/features/map/term-editor'
import { CANDIDATE_STATUS } from './labels'

type Action<T = ReviewAnalysisCandidateBody> = T extends unknown
  ? Omit<T, 'idempotencyKey' | 'expectedRevision'>
  : never
type Submit = (action: Action) => void

export function CandidateReviewDialog({
  candidate,
  targetId,
  onClose,
}: {
  candidate: AnalysisCandidateDto
  targetId: string
  onClose: () => void
}) {
  const client = useQueryClient()
  const canWrite = useCan('workflow:write')
  const canReadScenario = useCan('workflow:read')
  const canReview = useCan('map:review')
  const [kind, setKind] = useState<'term' | 'proposal'>(
    candidate.kind === 'term' ? 'term' : 'proposal'
  )
  const [replacing, setReplacing] = useState(false)
  const [reason, setReason] = useState('')
  const request = useRef<{ signature: string; key: string } | null>(null)
  const review = useMutation({
    mutationFn: (action: Action) => {
      const value = { ...action, expectedRevision: candidate.revision }
      const signature = canonicalJson(value)
      if (request.current?.signature !== signature)
        request.current = { signature, key: `candidate:${crypto.randomUUID()}` }
      return reviewAnalysisCandidate(candidate.candidateId, {
        ...value,
        idempotencyKey: request.current.key,
      })
    },
    onSuccess: (job) => {
      client.setQueryData(['analysis-job', candidate.jobId], job)
      void client.invalidateQueries({ queryKey: ['map', targetId, 'terms'] })
      setReplacing(false)
    },
  })
  const destination = candidate.review?.destination
  const pending = candidate.status === 'pending' || replacing
  const canReplace =
    destination?.kind === 'proposal' &&
    ['stale', 'rejected', 'failed'].includes(candidate.proposalStatus ?? '')
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !review.isPending) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>审阅候选知识</DialogTitle>
          <DialogDescription>
            检查来源和具体修改后采纳。场景建议只写入草稿，发布使用原有流程。
          </DialogDescription>
        </DialogHeader>
        <div className='grid min-w-0 gap-4 text-body'>
          <div className='rounded-md border p-3'>
            <p className='font-medium'>{candidate.title}</p>
            <p className='mt-2 break-words whitespace-pre-wrap'>
              {candidate.summary}
            </p>
            <p className='mt-2 text-label text-muted-foreground'>
              {CANDIDATE_STATUS[candidate.status]} · 修订 {candidate.revision}
            </p>
            <div className='mt-2 flex flex-wrap gap-3'>
              {candidate.sources.map((source, index) => (
                <a
                  key={index}
                  className='text-link underline'
                  href={
                    typeof source.runId === 'string'
                      ? `/runs/${source.runId}`
                      : `/targets/${targetId}/map`
                  }
                  target='_blank'
                  rel='noreferrer'
                >
                  查看来源{index + 1}
                </a>
              ))}
            </div>
          </div>
          {review.isError ? (
            <div role='alert' className='space-y-2 text-destructive'>
              <p>{review.error.message}</p>
              <p className='text-label'>
                输入已保留。若提示版本冲突，请关闭并重新打开，核对最新版本后再提交。
              </p>
            </div>
          ) : null}
          {pending ? (
            <>
              <div className='grid gap-1'>
                <Label htmlFor='candidate-destination'>采纳到</Label>
                <SelectField
                  id='candidate-destination'
                  value={kind}
                  disabled={review.isPending}
                  onValueChange={(value) => setKind(value as typeof kind)}
                >
                  <SelectFieldOption value='proposal'>
                    场景知识建议
                  </SelectFieldOption>
                  <SelectFieldOption value='term'>业务术语</SelectFieldOption>
                </SelectField>
              </div>
              {kind === 'proposal' ? (
                canWrite && canReadScenario ? (
                  <ScenarioCandidate
                    targetId={targetId}
                    busy={review.isPending}
                    submit={(action) => review.mutate(action)}
                  />
                ) : (
                  <p>需要场景读写权限才能创建知识建议。</p>
                )
              ) : null}
              {kind === 'term' ? (
                canReview ? (
                  <TermCandidate
                    targetId={targetId}
                    candidate={candidate}
                    busy={review.isPending}
                    submit={(action) => review.mutate(action)}
                  />
                ) : (
                  <p>需要地图审阅权限才能保存术语。</p>
                )
              ) : null}
              {canReview ? (
                <details className='rounded-md border p-3'>
                  <summary className='cursor-pointer text-label'>
                    不采纳这条候选
                  </summary>
                  <div className='mt-3 grid gap-2'>
                    <Label htmlFor='candidate-reason'>拒绝原因</Label>
                    <Textarea
                      id='candidate-reason'
                      value={reason}
                      maxLength={512}
                      disabled={review.isPending}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <Button
                      variant='outline'
                      disabled={review.isPending || !reason.trim()}
                      onClick={() =>
                        review.mutate({ kind: 'reject', reason: reason.trim() })
                      }
                    >
                      记录原因并拒绝
                    </Button>
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
          {!pending && destination?.kind === 'proposal' ? (
            <ProposalReview
              scenarioId={destination.scenarioId}
              proposalId={destination.proposalId}
              jobId={candidate.jobId}
              canWrite={canWrite}
            />
          ) : null}
          {!pending && destination?.kind === 'term' ? (
            <SavedTerm
              targetId={targetId}
              termId={destination.termId}
              canReview={canReview}
            />
          ) : null}
          {destination?.kind === 'reject' ? (
            <p>拒绝原因：{destination.reason}</p>
          ) : null}
          {!pending && canReplace && canWrite ? (
            <Button variant='outline' onClick={() => setReplacing(true)}>
              根据最新草稿重新提出建议
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ScenarioCandidate({
  targetId,
  busy,
  submit,
}: {
  targetId: string
  busy: boolean
  submit: Submit
}) {
  const [search, setSearch] = useState('')
  const [scenarioId, setScenarioId] = useState('')
  const scenarios = useQuery({
    queryKey: ['candidate-scenarios', targetId, search],
    queryFn: () => fetchScenarios({ targetId, search, limit: 100 }),
  })
  const scenario = useQuery({
    queryKey: ['candidate-scenario-baseline', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
    enabled: Boolean(scenarioId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const draft = scenario.data?.draft
  const flat =
    draft &&
    (isAuthoringDocumentV2(draft.document)
      ? walkAuthoringNodes(draft.document).some(
          ({ node }) =>
            node.kind === 'module' ||
            node.kind === 'block' ||
            (node.kind === 'step' && (node.outcomes?.length ?? 0) > 0),
        )
        ? null
        : scenarioDocumentSchema.parse({
            schemaVersion: 1,
            inputs: draft.document.inputs,
            steps: authoringSteps(draft.document),
          })
      : scenarioDocumentSchema.parse(draft.document))
  return (
    <div className='grid gap-3'>
      <Label htmlFor='candidate-scenario-search'>查找同一目标系统的场景</Label>
      <Input
        id='candidate-scenario-search'
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={busy}
      />
      <Label htmlFor='candidate-scenario'>应用场景</Label>
      <SelectField
        id='candidate-scenario'
        value={scenarioId}
        disabled={busy || scenarios.isPending}
        onValueChange={(value) => setScenarioId(value)}
      >
        <SelectFieldOption value=''>选择场景</SelectFieldOption>
        {scenarios.data?.items.map((item) => (
          <SelectFieldOption value={item.id} key={item.id}>
            {item.name}
          </SelectFieldOption>
        ))}
      </SelectField>
      {scenarios.data?.nextCursor ? (
        <p className='text-label text-muted-foreground'>
          匹配结果超过 100 条，请细化名称查找。
        </p>
      ) : null}
      {scenarios.isError || scenario.isError ? (
        <p role='alert'>
          {scenarios.error?.message ?? scenario.error?.message}
        </p>
      ) : null}
      {scenarioId && (scenario.isPending || scenario.isFetching) ? (
        <p role='status'>正在读取当前草稿…</p>
      ) : null}
      {scenario.isSuccess && !scenario.isFetching && flat && draft ? (
        <ScenarioProposalForm
          key={`${scenarioId}:${draft.revision}`}
          baseline={flat}
          revision={draft.revision}
          scenarioId={scenarioId}
          busy={busy}
          submit={submit}
        />
      ) : null}
      {scenario.isSuccess && !scenario.isFetching && draft && !flat ? (
        <p role='alert'>
          现有知识建议暂不支持含模块调用或业务结果规则的草稿，请在场景编排器中处理；本候选仍保留待审阅。
        </p>
      ) : null}
    </div>
  )
}

function ScenarioProposalForm({
  baseline,
  revision,
  scenarioId,
  busy,
  submit,
}: {
  baseline: ScenarioDocument
  revision: number
  scenarioId: string
  busy: boolean
  submit: Submit
}) {
  const [document, setDocument] = useState(baseline)
  const [index, setIndex] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const changed = canonicalJson(document) !== canonicalJson(baseline)
  const step = document.steps[index]
  return (
    <div className='grid gap-4 rounded-md border p-3'>
      <p className='text-label text-muted-foreground'>
        基于草稿 r{revision}。按候选结论调整实际步骤，检查差异后保存建议。
      </p>
      <Label htmlFor='candidate-step'>修改步骤</Label>
      <SelectField
        id='candidate-step'
        value={index}
        disabled={busy}
        onValueChange={(value) => setIndex(Number(value))}
      >
        {document.steps.map((item, i) => (
          <SelectFieldOption key={item.id} value={i}>
            {i + 1}. {item.name}
          </SelectFieldOption>
        ))}
      </SelectField>
      {step ? (
        <StepEditor
          step={step}
          index={index}
          bindings={priorBindings(document, index)}
          shapes={priorOutputShapes(document, index)}
          editableTypes={[step.type]}
          diagnostics={[]}
          disabled={busy}
          onRequestTypeChange={() => {}}
          onChange={(next) =>
            setDocument((value) => ({
              ...value,
              steps: value.steps.map((item, i) => (i === index ? next : item)),
            }))
          }
        />
      ) : (
        <p>草稿还没有步骤，请先在场景中添加步骤。</p>
      )}
      <details>
        <summary className='cursor-pointer text-label'>场景输入</summary>
        <InputsEditor
          inputs={document.inputs ?? []}
          disabled={busy}
          onChange={(inputs) => setDocument((value) => ({ ...value, inputs }))}
        />
      </details>
      {changed ? (
        <KnowledgeDiffs diffs={diffKnowledgeDocuments(baseline, document)} />
      ) : null}
      {error ? <p role='alert'>{error}</p> : null}
      <Button
        disabled={busy || preparing || !changed}
        onClick={() => {
          setPreparing(true)
          setError('')
          void scenarioDocumentDigest(baseline)
            .then((documentDigest) =>
              submit({
                kind: 'proposal',
                scenarioId,
                expectedDraftRevision: revision,
                documentDigest,
                document,
              })
            )
            .catch((failure: Error) => setError(failure.message))
            .finally(() => setPreparing(false))
        }}
      >
        保存为知识建议
      </Button>
    </div>
  )
}

function TermCandidate({
  targetId,
  candidate,
  busy,
  submit,
}: {
  targetId: string
  candidate: AnalysisCandidateDto
  busy: boolean
  submit: Submit
}) {
  const [search, setSearch] = useState('')
  const [prior, setPrior] = useState<TerminologyEntry | null>(null)
  const [name, setName] = useState(candidate.title.slice(0, 128))
  const [aliases, setAliases] = useState('')
  const [meaning, setMeaning] = useState(candidate.summary)
  const terms = useQuery({
    queryKey: ['candidate-terms', targetId, search],
    queryFn: () =>
      fetchMapTerms(targetId, { q: search || undefined, limit: 100 }),
  })
  return (
    <div className='grid gap-3'>
      <Label htmlFor='candidate-term-search'>查找要更新的术语（可选）</Label>
      <Input
        id='candidate-term-search'
        value={search}
        disabled={busy}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Label htmlFor='candidate-term-existing'>保存方式</Label>
      <SelectField
        id='candidate-term-existing'
        value={prior?.termId ?? ''}
        disabled={busy}
        onValueChange={(value) => {
          const term =
            terms.data?.items.find((item) => item.termId === value) ?? null
          setPrior(term)
          setName(term?.canonicalName ?? candidate.title.slice(0, 128))
          setAliases(term?.aliases.join('，') ?? '')
        }}
      >
        <SelectFieldOption value=''>新建术语</SelectFieldOption>
        {terms.data?.items
          .filter((item) => item.termStatus !== 'retired')
          .map((item) => (
            <SelectFieldOption key={item.termId} value={item.termId}>
              {item.canonicalName} · r{item.revision}
            </SelectFieldOption>
          ))}
      </SelectField>
      {terms.isError ? <p role='alert'>{terms.error.message}</p> : null}
      {terms.data?.nextCursor ? (
        <p className='text-label text-muted-foreground'>
          结果较多，请输入更具体的术语名称。
        </p>
      ) : null}
      {prior ? (
        <p className='rounded-md border p-3 text-label'>
          当前含义（r{prior.revision}）：{prior.meaning}
        </p>
      ) : null}
      <Label htmlFor='candidate-term-name'>规范名称</Label>
      <Input
        id='candidate-term-name'
        value={name}
        maxLength={128}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      <Label htmlFor='candidate-term-aliases'>别名（逗号分隔）</Label>
      <Input
        id='candidate-term-aliases'
        value={aliases}
        disabled={busy}
        onChange={(event) => setAliases(event.target.value)}
      />
      <Label htmlFor='candidate-term-meaning'>确认后的业务含义</Label>
      <Textarea
        id='candidate-term-meaning'
        value={meaning}
        maxLength={2048}
        rows={5}
        disabled={busy}
        onChange={(event) => setMeaning(event.target.value)}
      />
      <p className='text-label text-muted-foreground'>
        保存后成为已确认术语。请检查适用范围与来源；更新会保留原有适用条件和修订记录。
      </p>
      <Button
        disabled={busy || !name.trim() || !meaning.trim()}
        onClick={() =>
          submit({
            kind: 'term',
            canonicalName: name,
            aliases: aliases
              .split(/[,，]/)
              .map((item) => item.trim())
              .filter(Boolean),
            meaning,
            existingTerm: prior
              ? { termId: prior.termId, expectedRevision: prior.revision }
              : undefined,
          })
        }
      >
        确认并保存术语
      </Button>
    </div>
  )
}

function SavedTerm({
  targetId,
  termId,
  canReview,
}: {
  targetId: string
  termId: string
  canReview: boolean
}) {
  const term = useQuery({
    queryKey: ['map', targetId, 'terms', termId],
    queryFn: () =>
      apiFetch(
        `/api/targets/${targetId}/map/terms/${termId}`,
        terminologyEntrySchema
      ),
  })
  return (
    <div>
      {term.isPending ? <p role='status'>正在加载已保存术语…</p> : null}
      {term.isError ? <p role='alert'>{term.error.message}</p> : null}
      {term.data ? (
        <>
          <p>
            已保存为术语「{term.data.canonicalName}」 · r{term.data.revision}
          </p>
          <TermEditor term={term.data} canReview={canReview} />
        </>
      ) : null}
    </div>
  )
}

function ProposalReview({
  scenarioId,
  proposalId,
  jobId,
  canWrite,
}: {
  scenarioId: string
  proposalId: string
  jobId: string
  canWrite: boolean
}) {
  const client = useQueryClient()
  const key = ['knowledge-proposal', scenarioId, proposalId]
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchKnowledgeProposal(scenarioId, proposalId),
  })
  const action = useMutation({
    mutationFn: async (kind: 'accept' | 'reject') => {
      const proposal = query.data!
      return kind === 'reject'
        ? rejectKnowledgeProposal(scenarioId, proposalId)
        : (
            await acceptKnowledgeProposal(scenarioId, proposalId, {
              idempotencyKey: `candidate-accept:${proposalId}`,
              expectedDraftRevision: proposal.baseline.draftRevision,
              documentDigest: proposal.baseline.documentDigest,
            })
          ).proposal
    },
    onSuccess: (value) => {
      client.setQueryData(key, value)
      void client.invalidateQueries({ queryKey: ['analysis-job', jobId] })
      void client.invalidateQueries({ queryKey: ['scenario', scenarioId] })
    },
    onError: () => {
      void query.refetch()
      void client.invalidateQueries({ queryKey: ['analysis-job', jobId] })
    },
  })
  const proposal = query.data
  return (
    <div className='grid min-w-0 gap-3'>
      {query.isPending ? <p role='status'>正在读取知识建议…</p> : null}
      {query.isError ? <p role='alert'>{query.error.message}</p> : null}
      {proposal ? (
        <>
          <p>
            {proposal.proposalStatus === 'accepted'
              ? '已接受到场景草稿，尚未发布。'
              : proposal.proposalStatus === 'stale'
                ? '草稿已更新，此建议已过期。请基于最新草稿重新提出建议。'
                : proposal.proposalStatus === 'rejected'
                  ? '建议已拒绝，可重新提出。'
                  : `待审阅知识建议 · 基于草稿 r${proposal.baseline.draftRevision}`}
          </p>
          <KnowledgeDiffs diffs={proposal.diffs} />
          {canWrite && proposal.proposalStatus === 'proposed' ? (
            <div className='flex flex-wrap gap-2'>
              <Button
                disabled={action.isPending}
                onClick={() => action.mutate('accept')}
              >
                接受到场景草稿
              </Button>
              <Button
                variant='outline'
                disabled={action.isPending}
                onClick={() => action.mutate('reject')}
              >
                拒绝建议
              </Button>
            </div>
          ) : null}
          <a className='text-link underline' href={`/scenarios/${scenarioId}`}>
            打开场景检查与发布
          </a>
        </>
      ) : null}
      {action.isError ? <p role='alert'>{action.error.message}</p> : null}
    </div>
  )
}

function KnowledgeDiffs({ diffs }: { diffs: KnowledgeDiff[] }) {
  const labels: Record<string, string> = {
    name: '名称',
    input: '步骤参数',
    inputs: '场景输入',
    effectType: '副作用',
    outputKey: '输出名称',
    policy: '执行策略',
    timeoutMs: '超时时间',
  }
  return (
    <details open>
      <summary className='cursor-pointer text-label'>
        具体变更（{diffs.length} 处）
      </summary>
      <ul className='mt-2 grid gap-3'>
        {diffs.map((diff, index) => (
          <li key={index} className='min-w-0 rounded-md border p-3'>
            <p className='mb-2 font-medium'>
              {diff.fieldPath
                .map((part, i) =>
                  i === 0 && part === 'steps'
                    ? '步骤'
                    : /^\d+$/.test(part)
                      ? String(Number(part) + 1)
                      : (labels[part] ?? part)
                )
                .join(' · ')}
            </p>
            <div className='grid min-w-0 gap-2 sm:grid-cols-2'>
              {[
                { label: '修改前', value: diff.from },
                { label: '修改后', value: diff.to },
              ].map((item) => (
                <div key={item.label} className='min-w-0'>
                  <p className='text-label text-muted-foreground'>
                    {item.label}
                  </p>
                  <pre className='max-h-64 overflow-auto rounded-md bg-muted p-2 text-body break-all whitespace-pre-wrap'>
                    {typeof item.value === 'string'
                      ? item.value
                      : item.value === undefined
                        ? '未设置'
                        : JSON.stringify(item.value, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </details>
  )
}
