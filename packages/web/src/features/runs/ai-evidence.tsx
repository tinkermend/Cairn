import { isAiCallEvidence, type EvidenceMetadata, type JsonValue } from '@cairn/shared'

export function AiAttemptSummary({
  output,
  evidence,
}: {
  output: JsonValue | null
  evidence: EvidenceMetadata[]
}) {
  const record =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : null
  const judgement = record
    ? {
        passed: typeof record.passed === 'boolean' ? record.passed : undefined,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
        citations: Array.isArray(record.citations) ? (record.citations as string[]) : undefined,
        fallbackReason: typeof record.fallbackReason === 'string' ? record.fallbackReason : undefined,
      }
    : null
  const calls = evidence.filter((item) => item.payload !== undefined && isAiCallEvidence(item.payload))

  if (!judgement && calls.length === 0 && output == null) return null

  return (
    <div className='space-y-2 text-label'>
      {typeof judgement?.passed === 'boolean' ? (
        <p>
          判断 {judgement.passed ? '成立' : '不成立'}
          {judgement.reason ? ` · ${judgement.reason}` : ''}
        </p>
      ) : output != null ? (
        <pre className='overflow-x-auto text-label'>{JSON.stringify(output)}</pre>
      ) : null}
      {judgement?.citations && judgement.citations.length > 0 ? (
        <div className='rounded bg-muted/60 p-2'>
          <p className='font-medium text-muted-foreground'>语义树引用行 (Citations):</p>
          <ul className='mt-1 list-inside list-disc space-y-0.5 font-mono text-label text-foreground'>
            {judgement.citations.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {judgement?.fallbackReason ? (
        <p className='text-muted-foreground'>回退说明: {judgement.fallbackReason}</p>
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
