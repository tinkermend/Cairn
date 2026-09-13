import { isAiCallEvidence, type EvidenceMetadata, type JsonValue } from '@cairn/shared'

export function AiAttemptSummary({
  output,
  evidence,
}: {
  output: JsonValue | null
  evidence: EvidenceMetadata[]
}) {
  const judgement =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as { passed?: unknown; reason?: unknown })
      : null
  const calls = evidence.filter((item) => item.payload !== undefined && isAiCallEvidence(item.payload))

  if (!judgement && calls.length === 0 && output == null) return null

  return (
    <div className='space-y-2 text-label'>
      {typeof judgement?.passed === 'boolean' ? (
        <p>
          判断 {judgement.passed ? '成立' : '不成立'}
          {typeof judgement.reason === 'string' && judgement.reason ? ` · ${judgement.reason}` : ''}
        </p>
      ) : output != null ? (
        <pre className='overflow-x-auto text-label'>{JSON.stringify(output)}</pre>
      ) : null}
      {calls.map((item) => {
        const payload = item.payload
        if (!payload || !isAiCallEvidence(payload)) return null
        return (
          <p key={item.id} className='text-muted-foreground'>
            模型调用 #{payload.n}
            {payload.model ? ` · ${payload.model}` : ''}
            {payload.durationMs != null ? ` · ${payload.durationMs} ms` : ''}
            {payload.inputTokens == null && payload.outputTokens == null
              ? ' · 用量未知'
              : ` · tokens ${payload.inputTokens ?? '未知'}/${payload.outputTokens ?? '未知'}`}
          </p>
        )
      })}
    </div>
  )
}
