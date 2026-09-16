import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  scenarioDocumentDigest,
  isAuthoringDocumentV2,
  type ScenarioAuthoringDocumentV2,
  type AuthoringProposal,
  type ScenarioDocument,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  acceptKnowledgeProposal,
  createKnowledgeProposal,
  rejectKnowledgeProposal,
  fetchKnowledgeProposal,
} from '@/lib/knowledge-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { KnowledgeSources } from '../map/knowledge-sources'

const STATUS_LABEL: Record<string, string> = {
  proposed: '待接受',
  needs_input: '待补充',
  unsupported: '无法生成',
  failed: '生成失败',
  accepted: '已接受',
  stale: '已过期',
  rejected: '已拒绝',
  generating: '正在生成',
}

type KnowledgeProposalProps = {
  scenarioId: string
  draftRevision: number
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
  disabled?: boolean
  onAccepted: (draftRevision: number, document: ScenarioDocument) => void
}

export function KnowledgeProposal(props: KnowledgeProposalProps) {
  return <KnowledgeProposalContent key={props.scenarioId} {...props} />
}

function KnowledgeProposalContent(props: KnowledgeProposalProps) {
  const flatDocument: ScenarioDocument | undefined = isAuthoringDocumentV2(
    props.document
  )
    ? props.document.nodes.some((node) => node.kind === 'module')
      ? undefined
      : {
          schemaVersion: 1,
          inputs: props.document.inputs,
          steps: props.document.nodes.flatMap((node) =>
            node.kind === 'step' ? [node.step] : []
          ),
        }
    : props.document
  const canAssist = useCan('ai:assist')
  const canWrite = useCan('workflow:write')
  const canReadMap = useCan('map:read')
  const canReadTarget = useCan('target:read')
  const canGenerate = canAssist && canWrite && canReadMap && canReadTarget
  const [existingId, setExistingId] = useState('')
  const [question, setQuestion] = useState('根据已有知识按订单号查询状态')
  const [selectedTermIds, setSelectedTermIds] = useState<string[]>([])
  const [selectedModuleVersionIds, setSelectedModuleVersionIds] = useState<
    string[]
  >([])
  const [proposal, setProposal] = useState<AuthoringProposal | null>(null)
  const request = useRef<{ signature: string; key: string } | null>(null)
  const generate = useMutation({
    mutationFn: async (selection?: {
      terms?: string[]
      modules?: string[]
    }) => {
      const body = {
        question: question.trim(),
        expectedDraftRevision: props.draftRevision,
        documentDigest: await scenarioDocumentDigest(flatDocument!),
        selectedTermIds: selection?.terms ?? selectedTermIds,
        selectedModuleVersionIds:
          selection?.modules ?? selectedModuleVersionIds,
      }
      const signature = JSON.stringify(body)
      if (request.current?.signature !== signature)
        request.current = { signature, key: `know:${crypto.randomUUID()}` }
      return createKnowledgeProposal(props.scenarioId, {
        ...body,
        idempotencyKey: request.current.key,
      })
    },
    onSuccess: (result) => {
      setProposal(result)
      request.current = null
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '生成知识建议失败'
      ),
  })
  const accept = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error('没有可接受的建议')
      return acceptKnowledgeProposal(props.scenarioId, proposal.proposalId, {
        idempotencyKey: `know-acc:${proposal.proposalId}`,
        expectedDraftRevision: props.draftRevision,
        documentDigest: await scenarioDocumentDigest(flatDocument!),
      })
    },
    onSuccess: (result) => {
      toast.success('已接受到草稿，尚未发布')
      setProposal(result.proposal)
      if (result.proposal.document)
        props.onAccepted(result.draftRevision, result.proposal.document)
    },
    onError: (error) => {
      if (
        error instanceof ApiRequestError &&
        error.payload.code === 'AUTHORING_PROPOSAL_STALE'
      )
        setProposal((value) =>
          value ? { ...value, proposalStatus: 'stale' } : value
        )
      toast.error(
        error instanceof ApiRequestError ? error.message : '接受建议失败'
      )
    },
  })
  const reject = useMutation({
    mutationFn: () =>
      rejectKnowledgeProposal(props.scenarioId, proposal!.proposalId),
    onSuccess: setProposal,
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '拒绝建议失败'
      ),
  })
  const load = useMutation({
    mutationFn: () =>
      fetchKnowledgeProposal(props.scenarioId, existingId.trim()),
    onSuccess: setProposal,
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '读取建议失败'
      ),
  })
  if (!(canWrite && canReadMap && canReadTarget)) return null
  if (!flatDocument)
    return (
      <p className='text-small text-muted-foreground'>
        知识建议目前只支持独立步骤草稿；此草稿含模块调用，请在模块编写流程中维护。
      </p>
    )
  const busy =
    generate.isPending || accept.isPending || reject.isPending || load.isPending
  const stale =
    proposal?.proposalStatus === 'proposed' &&
    proposal.baseline.draftRevision !== props.draftRevision
  return (
    <Card>
      <CardHeader>
        <CardTitle>知识建议</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <details>
          <summary className='cursor-pointer text-small text-link'>
            打开助手或之前保存的建议
          </summary>
          <div className='mt-2 flex gap-2'>
            <Input
              aria-label='已有建议编号'
              value={existingId}
              onChange={(e) => setExistingId(e.target.value)}
            />
            <Button
              variant='outline'
              disabled={busy || !existingId.trim()}
              onClick={() => load.mutate()}
            >
              打开建议
            </Button>
          </div>
        </details>
        {props.disabled ? (
          <p className='text-small text-muted-foreground'>
            草稿当前不可接受知识建议，请先完成编辑并保存。
          </p>
        ) : null}
        <Input
          aria-label='知识建议需求'
          value={question}
          disabled={props.disabled || busy}
          onChange={(event) => {
            setQuestion(event.target.value)
            setSelectedTermIds([])
            setSelectedModuleVersionIds([])
          }}
        />
        <div className='flex flex-wrap gap-2'>
          <Button
            size='sm'
            disabled={
              !canGenerate || props.disabled || !question.trim() || busy
            }
            loading={generate.isPending}
            onClick={() => generate.mutate(undefined)}
          >
            生成知识建议
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={
              props.disabled ||
              busy ||
              stale ||
              proposal?.proposalStatus !== 'proposed'
            }
            loading={accept.isPending}
            onClick={() => accept.mutate()}
          >
            接受到草稿
          </Button>
          {proposal &&
          ['proposed', 'needs_input'].includes(proposal.proposalStatus) ? (
            <Button
              size='sm'
              variant='ghost'
              disabled={busy}
              onClick={() => reject.mutate()}
            >
              拒绝建议
            </Button>
          ) : null}
        </div>
        {stale ? (
          <Alert>
            <AlertDescription>
              草稿已更新，请重新生成。原建议保留供比较。
            </AlertDescription>
          </Alert>
        ) : null}
        {proposal ? (
          <div className='min-w-0 space-y-3 text-small' aria-live='polite'>
            <p>
              状态：
              {STATUS_LABEL[proposal.proposalStatus] ?? proposal.proposalStatus}
              {proposal.unknowns.length
                ? ` · 未知 ${proposal.unknowns.join('、')}`
                : ''}
            </p>
            {proposal.termCandidates.length > 1 ? (
              <Alert>
                <AlertDescription className='space-y-2'>
                  <p>请选定术语含义后再生成，不会按名字自动替换参数。</p>
                  <div className='flex flex-wrap gap-2'>
                    {proposal.termCandidates.map((item) => (
                      <div key={item.termId}>
                        <Button
                          size='sm'
                          variant={
                            selectedTermIds.includes(item.termId)
                              ? 'default'
                              : 'outline'
                          }
                          disabled={!canGenerate || props.disabled || busy}
                          onClick={() => {
                            setSelectedTermIds([item.termId])
                            generate.mutate({ terms: [item.termId] })
                          }}
                        >
                          {item.canonicalName}
                        </Button>
                        <p className='mt-1 text-muted-foreground'>
                          {item.meaning}
                        </p>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {proposal.suggestedModules.length > 1 ? (
              <div className='space-y-2'>
                <p>多个做法匹配，请选择版本：</p>
                <div className='flex flex-wrap gap-2'>
                  {proposal.suggestedModules.map((item) => (
                    <Button
                      key={item.moduleVersionId}
                      variant='outline'
                      size='sm'
                      disabled={!canGenerate || props.disabled || busy}
                      onClick={() => {
                        setSelectedModuleVersionIds([item.moduleVersionId])
                        generate.mutate({ modules: [item.moduleVersionId] })
                      }}
                    >
                      {item.name}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {proposal.diagnostics.map((item) => (
              <p
                key={`${item.code}-${item.message}`}
                className='text-muted-foreground'
              >
                {item.message}
              </p>
            ))}
            {proposal.document ? (
              <div className='space-y-2'>
                <p className='font-medium'>
                  接受后的步骤（{proposal.document.steps.length} 步）
                </p>
                <ol className='list-decimal space-y-2 ps-5'>
                  {proposal.document.steps.map((step) => (
                    <li key={step.id}>
                      <span>
                        {step.name} · {step.type} · {step.effectType}
                      </span>
                      <details>
                        <summary className='cursor-pointer text-link'>
                          查看步骤参数
                        </summary>
                        <pre className='max-h-64 overflow-auto rounded border p-2 break-all whitespace-pre-wrap'>
                          {JSON.stringify(step.input, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {proposal.diffs.length ? (
              <details>
                <summary className='cursor-pointer text-link'>
                  查看 {proposal.diffs.length} 处具体变更
                </summary>
                <pre className='max-h-80 overflow-auto rounded border p-2 break-all whitespace-pre-wrap'>
                  {JSON.stringify(proposal.diffs, null, 2)}
                </pre>
              </details>
            ) : null}
            <KnowledgeSources
              targetId={proposal.targetId}
              sources={proposal.sources}
            />
          </div>
        ) : (
          <p className='text-small text-muted-foreground'>
            基于已确认术语和已发布做法生成可编辑步骤，不会自动发布或试跑。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
